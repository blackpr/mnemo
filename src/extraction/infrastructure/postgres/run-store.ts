import type { BankId, EpisodeId, ModelRef, TenantId } from "../../../shared-kernel/index.js";
import type { Queryable } from "../../../platform/postgres/pool.js";
import type { ExtractionUsage } from "../../ports/extractor.js";
import type { BankRunSummary, ClaimedRun, ExtractionRunOutcome, ExtractionRunStore, RunStatus } from "../../ports/run-store.js";

export class PgExtractionRunStore implements ExtractionRunStore {
  constructor(private readonly db: Queryable) {}

  async enqueue(episodeId: EpisodeId, bankId: BankId, tenantId: TenantId, now: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO extraction.runs (episode_id, bank_id, tenant_id, status, next_attempt_at)
       VALUES ($1, $2, $3, 'pending', $4) ON CONFLICT (episode_id) DO NOTHING`,
      [episodeId, bankId, tenantId, now],
    );
  }

  async claimNext(now: Date, opts: { readonly staleAfterMs: number; readonly maxAttempts: number }): Promise<ClaimedRun | undefined> {
    // One statement: pick the oldest due row with SKIP LOCKED, mark it running, bump attempts.
    const { rows } = await this.db.query<{ episode_id: string; bank_id: string; tenant_id: string; attempts: number; claimed_at: Date }>(
      `UPDATE extraction.runs r
       SET status = 'running', attempts = r.attempts + 1, claimed_at = $1, error = NULL
       FROM (
         SELECT episode_id FROM extraction.runs
         WHERE next_attempt_at <= $1
           AND (
             status = 'pending'
             OR (status = 'failed' AND attempts < $3)
             OR (status = 'running' AND attempts < $3 AND claimed_at < $1::timestamptz - ($2::int * interval '1 millisecond'))
           )
         ORDER BY next_attempt_at, episode_id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       ) due
       WHERE r.episode_id = due.episode_id
       RETURNING r.episode_id, r.bank_id, r.tenant_id, r.attempts, r.claimed_at`,
      [now, opts.staleAfterMs, opts.maxAttempts],
    );
    const r = rows[0];
    return r ? { episodeId: r.episode_id as EpisodeId, bankId: r.bank_id as BankId, tenantId: r.tenant_id as TenantId, attempts: r.attempts, claimedAt: r.claimed_at } : undefined;
  }

  async complete(claim: ClaimedRun, extractor: ModelRef, o: ExtractionRunOutcome, now: Date): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE extraction.runs SET status = 'done', finished_at = $2, extractor = $3, input_tokens = $4, output_tokens = $5, latency_ms = $6,
         candidates = $7, asserted = $8, superseded = $9, invalidated = $10, historical = $11, rejected = $12,
         cached_input_tokens = $14, cache_write_tokens = $15
       WHERE episode_id = $1 AND status = 'running' AND claimed_at = $13`,
      [claim.episodeId, now, JSON.stringify(extractor), o.usage.inputTokens, o.usage.outputTokens, o.usage.latencyMs, o.candidates, o.asserted, o.superseded, o.invalidated, o.historical, o.rejected, claim.claimedAt, o.usage.cachedInputTokens ?? null, o.usage.cacheWriteTokens ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async fail(claim: ClaimedRun, error: string, now: Date, retryAt: Date | undefined, usage?: ExtractionUsage): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE extraction.runs
       SET status = $4, finished_at = $2, error = $3, next_attempt_at = COALESCE($5::timestamptz, next_attempt_at),
           input_tokens = COALESCE($6, input_tokens), output_tokens = COALESCE($7, output_tokens), latency_ms = COALESCE($8, latency_ms),
           cached_input_tokens = COALESCE($10, cached_input_tokens), cache_write_tokens = COALESCE($11, cache_write_tokens)
       WHERE episode_id = $1 AND status = 'running' AND claimed_at = $9`,
      [claim.episodeId, now, error.slice(0, 2000), retryAt ? "failed" : "dead", retryAt ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.latencyMs ?? null, claim.claimedAt, usage?.cachedInputTokens ?? null, usage?.cacheWriteTokens ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async skip(claim: ClaimedRun, reason: string, now: Date): Promise<void> {
    await this.db.query("UPDATE extraction.runs SET status = 'skipped', reason = $3, finished_at = $2 WHERE episode_id = $1 AND status = 'running' AND claimed_at = $4", [claim.episodeId, now, reason, claim.claimedAt]);
  }

  async sweepStale(now: Date, opts: { readonly staleAfterMs: number; readonly maxAttempts: number }): Promise<number> {
    const r = await this.db.query(
      `UPDATE extraction.runs SET status = 'dead', finished_at = $1, error = COALESCE(error, 'claim went stale after the attempt limit (worker crashed?)')
       WHERE status = 'running' AND attempts >= $3 AND claimed_at < $1::timestamptz - ($2::int * interval '1 millisecond')`,
      [now, opts.staleAfterMs, opts.maxAttempts],
    );
    return r.rowCount ?? 0;
  }

  async requeueFailed(): Promise<number> {
    const r = await this.db.query("UPDATE extraction.runs SET status = 'pending', attempts = 0, next_attempt_at = now(), error = NULL WHERE status IN ('failed', 'dead')");
    return r.rowCount ?? 0;
  }

  async counts(): Promise<Readonly<Record<RunStatus, number>>> {
    const { rows } = await this.db.query<{ status: RunStatus; n: string }>("SELECT status, count(*)::text AS n FROM extraction.runs GROUP BY status");
    const out: Record<RunStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, dead: 0, skipped: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  async summaryByBank(bankId: BankId): Promise<BankRunSummary> {
    const { rows } = await this.db.query<{ status: RunStatus; n: string; input_tokens: string; output_tokens: string; cached_input_tokens: string; cache_write_tokens: string; llm_attempts: string }>(
      `SELECT status, count(*)::text AS n, coalesce(sum(input_tokens), 0)::text AS input_tokens, coalesce(sum(output_tokens), 0)::text AS output_tokens,
              coalesce(sum(cached_input_tokens), 0)::text AS cached_input_tokens, coalesce(sum(cache_write_tokens), 0)::text AS cache_write_tokens,
              coalesce(sum(attempts) FILTER (WHERE input_tokens IS NOT NULL OR status IN ('done', 'failed', 'dead')), 0)::text AS llm_attempts
       FROM extraction.runs WHERE bank_id = $1 GROUP BY status`,
      [bankId],
    );
    const counts: Record<RunStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, dead: 0, skipped: 0 };
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let cacheWriteTokens = 0;
    let llmAttempts = 0;
    for (const r of rows) {
      counts[r.status] = Number(r.n);
      inputTokens += Number(r.input_tokens);
      outputTokens += Number(r.output_tokens);
      cachedInputTokens += Number(r.cached_input_tokens);
      cacheWriteTokens += Number(r.cache_write_tokens);
      llmAttempts += Number(r.llm_attempts);
    }
    return { counts, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, llmAttempts };
  }

  async countByBank(bankId: BankId): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM extraction.runs WHERE bank_id = $1", [bankId]);
    return Number(rows[0]?.n ?? 0);
  }

  async purgeBank(bankId: BankId): Promise<number> {
    const r = await this.db.query("DELETE FROM extraction.runs WHERE bank_id = $1", [bankId]);
    return r.rowCount ?? 0;
  }
}

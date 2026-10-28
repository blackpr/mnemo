import type { BankId, EpisodeId, FactId, Scope } from "../../../shared-kernel/index.js";
import type { Episode, Fact } from "../../../memory/index.js";
import type { Queryable } from "../../../platform/postgres/pool.js";
import { crossBank } from "../../../platform/postgres/bank-isolation.js";
import type { Embedder } from "../../ports/embedder.js";
import type { RankedHit, RecallOptions, RetrievalEngine } from "../../ports/retrieval-engine.js";

interface Row {
  bankId: BankId;
  kind: "fact" | "episode";
  refId: string;
  text: string;
  vector: readonly number[];
  validFrom?: Date | undefined;
  validTo?: Date | undefined;
  retracted: boolean;
}

interface HitRow {
  kind: "fact" | "episode";
  ref_id: string;
  score: number;
}

/**
 * Default engine (spike arm B): our own Postgres, pgvector cosine similarity, no LLM on the
 * write path. Holds derived state only; see rebuild(). A Bank is one Subject's store, so
 * purgeBank deletes by bank_id and re-counts to prove zero remaining.
 *
 * Every row records the embedder that produced it and recall only compares rows from the
 * current embedder, so switching embedders can never mix vector spaces (or dimensions); rows
 * from a previous embedder are simply invisible until `rebuild` replaces them.
 */
export class PgvectorEngine implements RetrievalEngine {
  readonly name = "pgvector";

  constructor(
    private readonly db: Queryable,
    private readonly embedder: Embedder,
  ) {}

  get embedderId(): string {
    return this.embedder.id;
  }

  get embedderDimensions(): number | undefined {
    return this.embedder.dimensions;
  }

  /** One tiny embedding call, so a bad key or model fails at boot instead of dead-lettering events later. */
  async probeEmbedder(): Promise<void> {
    await this.embedder.embed(["startup probe"]);
  }

  async indexFact(fact: Fact): Promise<void> {
    const [vec] = await this.embedder.embed([fact.statement]);
    await this.upsert({
      bankId: fact.bankId,
      kind: "fact",
      refId: fact.id,
      text: fact.statement,
      vector: vec ?? [],
      validFrom: fact.validity.validFrom,
      validTo: fact.validity.validTo,
      retracted: fact.transaction.retractedAt !== undefined,
    });
  }

  async indexEpisode(episode: Episode): Promise<void> {
    const [vec] = await this.embedder.embed([episode.text]);
    await this.upsert({
      bankId: episode.bankId,
      kind: "episode",
      refId: episode.id,
      text: episode.text,
      vector: vec ?? [],
      validFrom: episode.occurredAt,
      retracted: false,
    });
  }

  async retractFact(bankId: BankId, factId: FactId): Promise<void> {
    await this.db.query("UPDATE retrieval.pgvector_index SET retracted = true WHERE bank_id = $1 AND kind = 'fact' AND ref_id = $2", [bankId, factId]);
  }

  async recall(scope: Scope, query: string, options: RecallOptions): Promise<readonly RankedHit[]> {
    const [qvec] = await this.embedder.embed([query]);
    const kinds = options.includeEpisodes ? ["fact", "episode"] : ["fact"];
    const { rows } = await this.db.query<HitRow>(
      `SELECT kind, ref_id, 1 - (embedding <=> $1::vector) AS score
       FROM retrieval.pgvector_index
       WHERE bank_id = $2
         AND embedder = $6
         AND kind = ANY($3::text[])
         AND NOT retracted
         AND (valid_from IS NULL OR valid_from <= COALESCE($4::timestamptz, now()))
         AND (valid_to IS NULL OR valid_to > COALESCE($4::timestamptz, now()))
       ORDER BY embedding <=> $1::vector
       LIMIT $5`,
      [toVectorLiteral(qvec ?? []), scope.bankId, kinds, options.asOf ?? null, options.limit, this.embedder.id],
    );
    // hnsw.iterative_scan = relaxed_order (set per connection in createPool) may hand rows back slightly out of distance order.
    return rows
      .map((r) => (r.kind === "fact" ? { factId: r.ref_id as FactId, score: Number(r.score) } : { episodeId: r.ref_id as EpisodeId, score: Number(r.score) }))
      .sort((a, b) => b.score - a.score);
  }

  async countBank(bankId: BankId): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM retrieval.pgvector_index WHERE bank_id = $1", [bankId]);
    return Number(rows[0]?.n ?? 0);
  }

  async purgeBank(bankId: BankId): Promise<{ readonly deleted: number; readonly remaining: number }> {
    const del = await this.db.query("DELETE FROM retrieval.pgvector_index WHERE bank_id = $1", [bankId]);
    return { deleted: del.rowCount ?? 0, remaining: await this.countBank(bankId) };
  }

  /**
   * Rebuild a bank's index for the current embedder without ever shrinking recall: rows are
   * upserted in batches (the old-embedder row for the same fact/episode is overwritten in place),
   * and only then are rows from other embedders deleted. Interrupted mid-way, the bank is left
   * partly re-embedded and `staleRowCount` still reports the remainder; re-running resumes.
   */
  async rebuild(bankId: BankId, facts: AsyncIterable<Fact>, episodes: AsyncIterable<Episode>, batchSize = 64): Promise<void> {
    let batch: Row[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const vectors = await this.embedder.embed(batch.map((r) => r.text));
      for (const [i, r] of batch.entries()) await this.upsert({ ...r, vector: vectors[i] ?? [] });
      batch = [];
    };
    for await (const f of facts) {
      batch.push({ bankId, kind: "fact", refId: f.id, text: f.statement, vector: [], validFrom: f.validity.validFrom, validTo: f.validity.validTo, retracted: f.transaction.retractedAt !== undefined });
      if (batch.length >= batchSize) await flush();
    }
    for await (const e of episodes) {
      batch.push({ bankId, kind: "episode", refId: e.id, text: e.text, vector: [], validFrom: e.occurredAt, retracted: false });
      if (batch.length >= batchSize) await flush();
    }
    await flush();
    await this.db.query("DELETE FROM retrieval.pgvector_index WHERE bank_id = $1 AND embedder <> $2", [bankId, this.embedder.id]);
  }

  /** Rows in this bank written by a different embedder than the current one (invisible to recall until rebuilt). */
  async staleRowCount(bankId: BankId): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM retrieval.pgvector_index WHERE bank_id = $1 AND embedder <> $2", [bankId, this.embedder.id]);
    return Number(rows[0]?.n ?? 0);
  }

  /** Other embedder ids present anywhere in the index, with row counts: a non-empty result means banks need `reindex` (or another writer is live). */
  async foreignEmbedders(): Promise<readonly { readonly embedder: string; readonly rows: number }[]> {
    const { rows } = await this.db.query<{ embedder: string; n: string }>(`${crossBank("pgvector.foreign-embedders")}SELECT embedder, count(*)::text AS n FROM retrieval.pgvector_index WHERE embedder <> $1 GROUP BY embedder`, [this.embedder.id]);
    return rows.map((r) => ({ embedder: r.embedder, rows: Number(r.n) }));
  }

  /**
   * The row key is (kind, ref_id), not the bank: DO UPDATE only overwrites a row of the same bank, and a ref id
   * already indexed for another bank is refused instead of being moved across (ids are generated, so this means a bug).
   */
  private async upsert(row: Row): Promise<void> {
    const r = await this.db.query(
      `INSERT INTO retrieval.pgvector_index (bank_id, kind, ref_id, text, embedding, embedder, valid_from, valid_to, retracted)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9)
       ON CONFLICT (kind, ref_id) DO UPDATE SET
         text = EXCLUDED.text, embedding = EXCLUDED.embedding, embedder = EXCLUDED.embedder,
         valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, retracted = EXCLUDED.retracted
       WHERE pgvector_index.bank_id = EXCLUDED.bank_id`,
      [row.bankId, row.kind, row.refId, row.text, toVectorLiteral(row.vector), this.embedder.id, row.validFrom ?? null, row.validTo ?? null, row.retracted],
    );
    if (r.rowCount === 0) throw new Error(`pgvector: ${row.kind} ${row.refId} is already indexed for another bank; refusing to overwrite it from bank ${row.bankId}`);
  }
}

/** pgvector accepts the text form "[x,y,z]". */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}

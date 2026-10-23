import type { BankId, EpisodeId, FactId, Scope, SubjectId } from "../../../shared-kernel/index.js";
import type { Episode, Fact } from "../../../memory/index.js";
import type { Queryable } from "../../../platform/postgres/pool.js";
import type { Embedder } from "../../ports/embedder.js";
import type { RankedHit, RecallOptions, RetrievalEngine } from "../../ports/retrieval-engine.js";

interface HitRow {
  kind: "fact" | "episode";
  ref_id: string;
  score: number;
}

/**
 * Default engine (spike arm B): our own Postgres, pgvector cosine similarity, no LLM on the
 * write path. Holds derived state only; see rebuild(). A Bank is one Subject's store, so
 * purgeSubject deletes by bank_id and re-counts to prove zero remaining.
 */
export class PgvectorEngine implements RetrievalEngine {
  readonly name = "pgvector";

  constructor(
    private readonly db: Queryable,
    private readonly embedder: Embedder,
  ) {}

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

  async retractFact(factId: FactId): Promise<void> {
    await this.db.query("UPDATE retrieval.pgvector_index SET retracted = true WHERE kind = 'fact' AND ref_id = $1", [factId]);
  }

  async recall(scope: Scope, query: string, options: RecallOptions): Promise<readonly RankedHit[]> {
    const [qvec] = await this.embedder.embed([query]);
    const kinds = options.includeEpisodes ? ["fact", "episode"] : ["fact"];
    const { rows } = await this.db.query<HitRow>(
      `SELECT kind, ref_id, 1 - (embedding <=> $1::vector) AS score
       FROM retrieval.pgvector_index
       WHERE bank_id = $2
         AND kind = ANY($3::text[])
         AND NOT retracted
         AND (valid_from IS NULL OR valid_from <= COALESCE($4::timestamptz, now()))
         AND (valid_to IS NULL OR valid_to > COALESCE($4::timestamptz, now()))
       ORDER BY embedding <=> $1::vector
       LIMIT $5`,
      [toVectorLiteral(qvec ?? []), scope.bankId, kinds, options.asOf ?? null, options.limit],
    );
    return rows.map((r) =>
      r.kind === "fact"
        ? { factId: r.ref_id as FactId, score: Number(r.score) }
        : { episodeId: r.ref_id as EpisodeId, score: Number(r.score) },
    );
  }

  async purgeSubject(bankId: BankId, _subjectId: SubjectId): Promise<{ readonly deleted: number; readonly remaining: number }> {
    const del = await this.db.query("DELETE FROM retrieval.pgvector_index WHERE bank_id = $1", [bankId]);
    const { rows } = await this.db.query<{ n: string }>("SELECT count(*)::text AS n FROM retrieval.pgvector_index WHERE bank_id = $1", [bankId]);
    return { deleted: del.rowCount ?? 0, remaining: Number(rows[0]?.n ?? 0) };
  }

  async rebuild(bankId: BankId, facts: AsyncIterable<Fact>, episodes: AsyncIterable<Episode>): Promise<void> {
    await this.db.query("DELETE FROM retrieval.pgvector_index WHERE bank_id = $1", [bankId]);
    for await (const f of facts) await this.indexFact(f);
    for await (const e of episodes) await this.indexEpisode(e);
  }

  private async upsert(row: {
    bankId: BankId;
    kind: "fact" | "episode";
    refId: string;
    text: string;
    vector: readonly number[];
    validFrom?: Date | undefined;
    validTo?: Date | undefined;
    retracted: boolean;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO retrieval.pgvector_index (bank_id, kind, ref_id, text, embedding, embedder, valid_from, valid_to, retracted)
       VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9)
       ON CONFLICT (kind, ref_id) DO UPDATE SET
         text = EXCLUDED.text, embedding = EXCLUDED.embedding, embedder = EXCLUDED.embedder,
         valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, retracted = EXCLUDED.retracted`,
      [row.bankId, row.kind, row.refId, row.text, toVectorLiteral(row.vector), this.embedder.id, row.validFrom ?? null, row.validTo ?? null, row.retracted],
    );
  }
}

/** pgvector accepts the text form "[x,y,z]". */
export function toVectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}

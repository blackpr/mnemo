/**
 * Arm B, pgvector through the REST attachment. Per conversation (once per process, memoized, and
 * recorded under eval/results so a rerun skips it): create a throwaway bank `eval-<id8>` with the
 * admin CLI, grant the eval principal, set the extractor, retain every turn as an episode
 * (externalRef `eval:<conversation>:<turn>` makes it idempotent), wait for extraction to drain via
 * `admin extraction-status --bank`, and record ingest time and write tokens. Per question: `recall`
 * (facts plus episodes, bi-temporal `asOf` for temporal questions) and answer from what came back.
 *
 * EVAL_B_EXTRACTOR (default: the answering model) picks the bank's extractor. `none` is the plan's
 * floor, raw turns embedded with no LLM extraction: a separate bank `eval-<id8>-raw`, recall returns
 * episodes only, and the arm is labelled `B-pgvector-raw` in the metadata.
 *
 * Nothing here touches `bank-demo`; every bank this arm creates is named `eval-*` in tenant `t-eval`.
 * A bank id is never reused for different content: the ingestion record carries a digest of the
 * conversation, and a mismatch fails closed (erase the bank, delete the record, run again).
 */
import path from "node:path";
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";
import { loadConversation } from "../corpus/store.js";
import { ANSWERING_MODEL } from "../llm.js";
import { admin, answer, asOfInstruction, evalVars, providerResponse, recall, REPO_ROOT, retain, type RecalledEpisode, type RecalledFact } from "./lib.js";
import { digestOf, IngestionRecord, SerializedIngestion, sleep } from "./ingestion.js";

const EXTRACTOR = process.env.EVAL_B_EXTRACTOR ?? ANSWERING_MODEL;
export const ARM = EXTRACTOR === "none" ? "B-pgvector-raw" : "B-pgvector";
const TENANT = "t-eval";
const PRINCIPAL = "eval-runner";
const SOURCE = "eval-corpus";
const RECALL_LIMIT = Number(process.env.EVAL_RECALL_LIMIT ?? 10);
const DRAIN_POLL_MS = 5_000;
const DRAIN_TIMEOUT_MS = Number(process.env.EVAL_DRAIN_TIMEOUT_MS ?? 30 * 60_000);
const record = new IngestionRecord<Ingestion>(path.join(REPO_ROOT, "eval", "results", "pgvector-banks.json"));
const serialized = new SerializedIngestion<Ingestion>();

interface Ingestion {
  readonly bankId: string;
  readonly extractor: string;
  /** sha256 of the conversation file as ingested; a different corpus must not reuse the bank. */
  readonly digest: string;
  readonly turns: number;
  readonly created: number;
  readonly duplicates: number;
  readonly ingestMs: number;
  readonly writeInputTokens: number;
  readonly writeOutputTokens: number;
  readonly runs: Record<string, number>;
  readonly ingestedAt: string;
}

type RunCounts = Record<"pending" | "running" | "done" | "failed" | "dead" | "skipped", number>;
type ExtractionSummary = { counts: RunCounts; inputTokens: number; outputTokens: number };

const drained = (c: RunCounts, turns: number): boolean => c.pending + c.running + c.failed === 0 && c.done + c.skipped + c.dead >= turns;

async function extractionSummary(bankId: string): Promise<ExtractionSummary> {
  return JSON.parse(await admin("extraction-status", "--bank", bankId)) as ExtractionSummary;
}

async function waitForDrain(bankId: string, turns: number): Promise<ExtractionSummary> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const s = await extractionSummary(bankId);
    if (drained(s.counts, turns)) {
      if (s.counts.dead > 0) console.warn(`[${ARM}] ${bankId}: ${s.counts.dead} extraction run(s) dead-lettered; their facts are missing from this arm`);
      return s;
    }
    if (Date.now() > deadline) throw new Error(`${bankId}: extraction did not drain within ${DRAIN_TIMEOUT_MS} ms (${JSON.stringify(s.counts)}, ${turns} turns)`);
    await sleep(DRAIN_POLL_MS);
  }
}

/** Idempotent on every step: an existing bank, grant, extractor or episode is fine. Refused: a bank outside `eval-*`, or a bank whose record is for other content. */
async function ingest(conversationId: string): Promise<Ingestion> {
  const bankId = `eval-${conversationId.slice(0, 8)}${EXTRACTOR === "none" ? "-raw" : ""}`;
  if (!bankId.startsWith("eval-")) throw new Error("refusing to ingest into a non-eval bank");
  const turns = await loadConversation(conversationId);
  const digest = digestOf(turns);
  const stateKey = `${conversationId}${EXTRACTOR === "none" ? ":raw" : ""}`;
  const known = await record.get(stateKey);
  if (known) {
    if (known.bankId !== bankId || known.digest !== digest || known.extractor !== EXTRACTOR) {
      throw new Error(`${bankId} was ingested from different content or settings (${JSON.stringify({ bankId: known.bankId, extractor: known.extractor, digest: known.digest.slice(0, 12) })}); erase it with \`npm run admin -- erase-bank\`, remove its entry from ${record.path}, and run again`);
    }
    const s = await extractionSummary(bankId);
    if (drained(s.counts, known.turns)) return known;
    // The record exists but the bank does not hold its runs (erased, or a crash mid-ingest): fall through and re-ingest; a tombstoned bank then fails on retain.
  }

  const started = Date.now();
  try {
    await admin("create-bank", "--id", bankId, "--tenant", TENANT, "--subject", bankId);
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("already exists"))) throw e;
  }
  await admin("grant", "--principal", PRINCIPAL, "--bank", bankId, "--caps", "read,write");
  if (EXTRACTOR === "none") await admin("clear-extractor", "--bank", bankId);
  else await admin("set-extractor", "--bank", bankId, "--model", EXTRACTOR);

  let created = 0;
  let duplicates = 0;
  for (const t of turns) {
    const outcome = await retain(bankId, { source: SOURCE, kind: "conversation_turn", role: t.role, text: t.text, occurredAt: t.occurredAt, externalRef: `eval:${conversationId}:${t.turnIndex}` });
    if (outcome === "created") created++;
    else duplicates++;
  }
  const s = await waitForDrain(bankId, turns.length);
  // The relay indexes the facts the last extraction wrote on a later tick (OUTBOX_POLL_MS, default 500 ms,
  // plus one embedding call); wait a few ticks. A per-bank outbox count would make this exact (STATUS follow-up).
  await sleep(3 * Number(process.env.OUTBOX_POLL_MS ?? 500) + 1_000);
  const ingestion: Ingestion = {
    bankId,
    extractor: EXTRACTOR,
    digest,
    turns: turns.length,
    created,
    duplicates,
    // A re-ingest that created nothing measures nothing; keep the original timing.
    ingestMs: created === 0 && known ? known.ingestMs : Date.now() - started,
    writeInputTokens: s.inputTokens,
    writeOutputTokens: s.outputTokens,
    runs: s.counts,
    ingestedAt: new Date().toISOString(),
  };
  await record.save(stateKey, ingestion);
  console.log(`[${ARM}] ${bankId}: ${created} retained, ${duplicates} already there, drained in ${Math.round(ingestion.ingestMs / 1000)} s, write tokens ${s.inputTokens} in / ${s.outputTokens} out, runs ${JSON.stringify(s.counts)}`);
  return ingestion;
}

/**
 * Ingestions run one at a time (`SerializedIngestion`): `admin grant` rewrites the principal's whole
 * grant list without a transaction, so two concurrent grants lose one bank; and a single extraction
 * worker drains them sequentially anyway.
 */
const ensureIngested = (conversationId: string): Promise<Ingestion> => serialized.ensure(conversationId, () => ingest(conversationId));

function renderFact(f: RecalledFact): string {
  const to = f.validity.validTo ? ` until ${f.validity.validTo}` : "";
  return `- ${f.statement} (valid from ${f.validity.validFrom}${to})`;
}

function renderEpisode(e: RecalledEpisode): string {
  return `${e.role ?? "unknown"} (${e.occurredAt}):\n${e.text}`;
}

export default class PgvectorProvider implements ApiProvider {
  private readonly providerId: string;

  constructor(options: { id?: string } = {}) {
    this.providerId = options.id ?? "arm-b-pgvector";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const vars = evalVars(context);
    const ingestion = await ensureIngested(vars.conversationId);
    const t0 = Date.now();
    const recalled = await recall(ingestion.bankId, { query: vars.question, limit: RECALL_LIMIT, includeEpisodes: true, ...(vars.asOf ? { asOf: vars.asOf } : {}) });
    const recallMs = Date.now() - t0;
    const facts = recalled.facts.length > 0 ? recalled.facts.map(renderFact).join("\n") : "(none)";
    const episodes = recalled.episodes.length > 0 ? recalled.episodes.map(renderEpisode).join("\n\n") : "(none)";
    const user = `Here is what the user's memory recalled for this question.\n\n<facts>\n${facts}\n</facts>\n\n<episodes>\n${episodes}\n</episodes>\n\nQuestion: ${vars.question}${asOfInstruction(vars.asOf)}`;
    const a = await answer(ARM, user, context);
    return providerResponse(
      ARM,
      a,
      context,
      {
        questionId: vars.questionId,
        conversationId: vars.conversationId,
        type: vars.type,
        asOf: vars.asOf ?? null,
        bankId: ingestion.bankId,
        extractor: ingestion.extractor,
        extractionModel: ingestion.extractor,
        recallMs,
        recalledFacts: recalled.facts.length,
        recalledEpisodes: recalled.episodes.length,
        recallLimit: RECALL_LIMIT,
        conversationTurns: ingestion.turns,
        ingestMs: ingestion.ingestMs,
        writeInputTokens: ingestion.writeInputTokens,
        writeOutputTokens: ingestion.writeOutputTokens,
        extractionRuns: ingestion.runs,
      },
      recallMs + a.latencyMs,
    );
  }
}

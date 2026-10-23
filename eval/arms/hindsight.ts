/**
 * Arm C, Hindsight (vectorize-io/hindsight 1.1.0) run natively through its official TypeScript
 * client: one Hindsight bank `eval-<id8>` per conversation, every turn retained as its own document
 * with Hindsight's own extraction (bank defaults: concise extraction, observations on, all four
 * retrieval arms plus reranking), and per question one `recall` whose results are the material for
 * the same pinned answering model as every other arm. The engine's extraction model and embedder
 * come from docker-compose.yml (Opus 5.5 and text-embedding-3-small by default, same as arm B).
 *
 * Write tokens: Hindsight reports LLM usage on every synchronous retain (`usage`), and keeps a
 * per-call trace (`llm-requests`, retention set to forever in our compose) that also covers the
 * background observation consolidation, so the record carries both: the retain usage and the
 * total of every LLM call the bank made (that total is what the summary table reports).
 *
 * Env: HINDSIGHT_BASE_URL, HINDSIGHT_API_KEY (.env); EVAL_RECALL_MAX_TOKENS (default 4096, the
 * token budget Hindsight bounds recall by, since it has no result-count limit); EVAL_DRAIN_TIMEOUT_MS.
 * Banks are named `eval-*` and never shared with the port adapter (prefix `mem-`).
 */
import { createClient, createConfig, HindsightClient, HindsightError, sdk, type RecallResult } from "@vectorize-io/hindsight-client";
import path from "node:path";
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";
import { loadConversation } from "../corpus/store.js";
import { answer, asOfInstruction, evalVars, providerResponse, REPO_ROOT } from "./lib.js";
import { digestOf, IngestionRecord, SerializedIngestion, sleep } from "./ingestion.js";

export const ARM = "C-hindsight";
const RECALL_MAX_TOKENS = Number(process.env.EVAL_RECALL_MAX_TOKENS ?? 4_096);
const DRAIN_TIMEOUT_MS = Number(process.env.EVAL_DRAIN_TIMEOUT_MS ?? 30 * 60_000);
const DRAIN_POLL_MS = 3_000;
/** The extraction model docker-compose.yml gives Hindsight; recorded per row like arm B's extractor. */
const EXTRACTION_MODEL = `${process.env.HINDSIGHT_LLM_PROVIDER ?? "anthropic"}:${process.env.HINDSIGHT_LLM_MODEL ?? "claude-opus-5-5"}`;

interface Ingestion {
  readonly bankId: string;
  readonly digest: string;
  readonly engineVersion: string;
  readonly extractionModel: string;
  readonly turns: number;
  readonly retained: number;
  /** True when the bank already existed without a record and the retains were re-run; ingestMs then covers only the resumed part. */
  readonly resumed: boolean;
  readonly ingestMs: number;
  /** Usage Hindsight returned on the synchronous retain calls. */
  readonly retainInputTokens: number;
  readonly retainOutputTokens: number;
  /** Every LLM call in the bank's trace (retain + consolidation), what the table reports as write tokens. */
  readonly writeInputTokens: number;
  readonly writeOutputTokens: number;
  readonly writeCachedTokens: number;
  readonly llmCalls: number;
  readonly embeddingTokens: number;
  readonly ingestedAt: string;
}

const record = new IngestionRecord<Ingestion>(path.join(REPO_ROOT, "eval", "results", "hindsight-banks.json"));
const serialized = new SerializedIngestion<Ingestion>();

let clients: { client: HindsightClient; raw: ReturnType<typeof createClient> } | undefined;
function hindsight(): { client: HindsightClient; raw: ReturnType<typeof createClient> } {
  if (clients) return clients;
  const baseUrl = process.env.HINDSIGHT_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new Error("HINDSIGHT_BASE_URL is not set (npm run engines:hindsight:up; see .env.example)");
  const apiKey = process.env.HINDSIGHT_API_KEY;
  clients = {
    client: new HindsightClient({ baseUrl, ...(apiKey ? { apiKey } : {}) }),
    raw: createClient(createConfig({ baseUrl, ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}) })),
  };
  return clients;
}

async function bankExists(bankId: string): Promise<boolean> {
  try {
    await hindsight().client.listMemories(bankId, { limit: 1 });
    return true;
  } catch (e) {
    if (e instanceof HindsightError && e.statusCode === 404) return false;
    throw e;
  }
}

/** Until Hindsight has no pending retain operations and no memories queued for consolidation. */
async function waitForDrain(bankId: string): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const r = await sdk.getAgentStats({ client: hindsight().raw, path: { bank_id: bankId }, query: { refresh: true }, throwOnError: true });
    const s = r.data;
    const pendingConsolidation = s.pending_consolidation ?? 0;
    if (s.pending_operations === 0 && pendingConsolidation === 0) {
      const failed = (s.failed_operations ?? 0) + (s.failed_consolidation ?? 0);
      // A bank with failed work is not ingested; do not record it (the next row re-runs the retains, which Hindsight skips when unchanged).
      if (failed > 0) throw new Error(`${bankId}: Hindsight reports ${s.failed_operations ?? 0} failed operation(s) and ${s.failed_consolidation ?? 0} failed consolidation(s); not recording this ingestion`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`${bankId}: Hindsight did not drain within ${DRAIN_TIMEOUT_MS} ms (${JSON.stringify({ pending: s.pending_operations, consolidation: pendingConsolidation })})`);
    await sleep(DRAIN_POLL_MS);
  }
}

/** Sum of the bank's LLM trace: every model call Hindsight made for it, by kind. */
async function traceTotals(bankId: string): Promise<{ input: number; output: number; cached: number; calls: number; embedding: number }> {
  const out = { input: 0, output: 0, cached: 0, calls: 0, embedding: 0 };
  for (const callType of ["llm", "embedding"] as const) {
    for (let offset = 0; ; offset += 200) {
      const r = await sdk.listLlmRequests({ client: hindsight().raw, path: { bank_id: bankId }, query: { call_type: callType, limit: 200, offset }, throwOnError: true });
      for (const item of r.data.items) {
        if (callType === "embedding") out.embedding += item.input_tokens ?? 0;
        else {
          out.input += item.input_tokens ?? 0;
          out.output += item.output_tokens ?? 0;
          out.cached += item.cached_tokens ?? 0;
          out.calls++;
        }
      }
      if (offset + 200 >= r.data.total) break;
    }
  }
  return out;
}

async function ingest(conversationId: string): Promise<Ingestion> {
  const bankId = `eval-${conversationId.slice(0, 8)}`;
  const turns = await loadConversation(conversationId);
  const digest = digestOf(turns);
  const known = await record.get(conversationId);
  let resumed = false;
  if (known) {
    if (known.bankId !== bankId || known.digest !== digest) throw new Error(`${bankId} was ingested from different content (${known.digest.slice(0, 12)}); delete the Hindsight bank and its entry in ${record.path}, then run again`);
    if (await bankExists(bankId)) return known;
    // Record without a bank (deleted since): re-ingest.
  } else if (await bankExists(bankId)) {
    // An ingestion that died half-way (provider outage, credits) leaves the bank without a record. Retains
    // are per-document and Hindsight skips a document whose content hash is unchanged, so re-running
    // them completes the bank cheaply; the trace total still covers every call, only ingestMs is short.
    resumed = true;
    console.warn(`[${ARM}] ${bankId} exists without an ingestion record; resuming (retains of unchanged documents are skipped by Hindsight). Delete the bank instead if it holds other content.`);
  }
  const { client } = hindsight();
  const version = await client.getVersion();
  const started = Date.now();
  await client.createBank(bankId);
  let retainIn = 0;
  let retainOut = 0;
  for (const t of turns) {
    const r = await client.retain(bankId, t.text, {
      timestamp: t.occurredAt,
      context: `${t.role} turn ${t.turnIndex} of a conversation between the user and an AI coding assistant`,
      documentId: `eval:${conversationId}:${t.turnIndex}`,
      metadata: { conversationId, turnIndex: String(t.turnIndex), role: t.role },
    });
    retainIn += r.usage?.input_tokens ?? 0;
    retainOut += r.usage?.output_tokens ?? 0;
  }
  await waitForDrain(bankId);
  const ingestMs = Date.now() - started;
  const trace = await traceTotals(bankId);
  const ingestion: Ingestion = {
    bankId,
    digest,
    engineVersion: version.api_version,
    extractionModel: EXTRACTION_MODEL,
    turns: turns.length,
    retained: turns.length,
    resumed,
    ingestMs,
    retainInputTokens: retainIn,
    retainOutputTokens: retainOut,
    writeInputTokens: trace.input,
    writeOutputTokens: trace.output,
    writeCachedTokens: trace.cached,
    llmCalls: trace.calls,
    embeddingTokens: trace.embedding,
    ingestedAt: new Date().toISOString(),
  };
  await record.save(conversationId, ingestion);
  console.log(`[${ARM}] ${bankId}: ${turns.length} turns retained in ${Math.round(ingestMs / 1000)} s; retain usage ${retainIn} in / ${retainOut} out; trace total ${trace.input} in / ${trace.output} out over ${trace.calls} LLM calls (${trace.cached} cached), ${trace.embedding} embedding tokens`);
  return ingestion;
}

function renderResult(r: RecallResult): string {
  const when = r.occurred_start ? ` (occurred ${r.occurred_start}${r.occurred_end && r.occurred_end !== r.occurred_start ? ` to ${r.occurred_end}` : ""})` : r.mentioned_at ? ` (mentioned ${r.mentioned_at})` : "";
  const ctx = r.context ? ` [${r.context}]` : "";
  return `- (${r.type ?? "memory"}${ctx}) ${r.text}${when}`;
}

export default class HindsightProvider implements ApiProvider {
  private readonly providerId: string;

  constructor(options: { id?: string } = {}) {
    this.providerId = options.id ?? "arm-c-hindsight";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const vars = evalVars(context);
    const ingestion = await serialized.ensure(vars.conversationId, () => ingest(vars.conversationId));
    const t0 = Date.now();
    const recalled = await hindsight().client.recall(ingestion.bankId, vars.question, {
      maxTokens: RECALL_MAX_TOKENS,
      includeEntities: false,
      ...(vars.asOf ? { queryTimestamp: vars.asOf } : {}),
    });
    const recallMs = Date.now() - t0;
    const material = recalled.results.length > 0 ? recalled.results.map(renderResult).join("\n") : "(none)";
    const user = `Here is what the user's memory recalled for this question.\n\n<memories>\n${material}\n</memories>\n\nQuestion: ${vars.question}${asOfInstruction(vars.asOf)}`;
    const a = await answer(ARM, user, context);
    const byType: Record<string, number> = {};
    for (const r of recalled.results) byType[r.type ?? "?"] = (byType[r.type ?? "?"] ?? 0) + 1;
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
        engine: `hindsight ${ingestion.engineVersion}`,
        extractionModel: ingestion.extractionModel,
        recallMs,
        recalled: recalled.results.length,
        recalledByType: byType,
        recallMaxTokens: RECALL_MAX_TOKENS,
        conversationTurns: ingestion.turns,
        ingestMs: ingestion.ingestMs,
        ingestResumed: ingestion.resumed,
        writeInputTokens: ingestion.writeInputTokens,
        writeOutputTokens: ingestion.writeOutputTokens,
        writeCachedTokens: ingestion.writeCachedTokens,
        retainInputTokens: ingestion.retainInputTokens,
        retainOutputTokens: ingestion.retainOutputTokens,
        writeLlmCalls: ingestion.llmCalls,
        embeddingTokens: ingestion.embeddingTokens,
      },
      recallMs + a.latencyMs,
    );
  }
}

/**
 * Arm D, Honcho (plastic-labs/honcho 3.4.1) run natively through its official TypeScript SDK: one
 * workspace `eval-<id8>` per conversation with two peers, `user` (the Subject) and `assistant`,
 * both observed by the deriver as Honcho ships it, every turn added as a message with its original
 * timestamp, and the deriver left to build its representation (conclusions, peer card, summaries).
 * Per question the material is what Honcho's read paths return: the user peer's representation
 * focused by the question (`representation` with `searchQuery`) plus a message search over the
 * session, answered by the same pinned answering model as every other arm. Honcho's own dialectic
 * `chat` endpoint is deliberately not used for scoring: it answers with Honcho's prompt and model,
 * which would make the answering step incomparable.
 *
 * Write tokens: Honcho reports no usage on any response. The deriver exposes Prometheus counters
 * (`deriver_tokens_processed_total`, published on 127.0.0.1:9091 by docker-compose.yml), which are
 * process-wide, so ingestions run one at a time and the record keeps the counter delta per
 * conversation. The representation and dialectic paths' own LLM use is not captured anywhere we
 * can read per request; `representation` as used here is a read, not an LLM call.
 *
 * Env: HONCHO_BASE_URL, HONCHO_API_KEY, HONCHO_METRICS_URL (default http://127.0.0.1:9091/metrics),
 * EVAL_RECALL_LIMIT (messages, default 10), EVAL_DRAIN_TIMEOUT_MS.
 */
import { Honcho, type Message, type Peer, type Session } from "@honcho-ai/sdk";
import path from "node:path";
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";
import { loadConversation } from "../corpus/store.js";
import { answer, asOfInstruction, evalVars, providerResponse, REPO_ROOT } from "./lib.js";
import { digestOf, IngestionRecord, SerializedIngestion, sleep } from "./ingestion.js";

export const ARM = "D-honcho";
const RECALL_LIMIT = Number(process.env.EVAL_RECALL_LIMIT ?? 10);
const DRAIN_TIMEOUT_MS = Number(process.env.EVAL_DRAIN_TIMEOUT_MS ?? 30 * 60_000);
const DRAIN_POLL_MS = 3_000;
const METRICS_URL = process.env.HONCHO_METRICS_URL ?? "http://127.0.0.1:9091/metrics";
const SESSION = "conversation";
const USER = "user";
const ASSISTANT = "assistant";
/** The deriver model docker-compose.yml runs (Honcho 3.4.1 cannot drive Claude 5; see the compose file). Recorded per row so the table shows the uneven write side. */
const EXTRACTION_MODEL = `anthropic:${process.env.HONCHO_LLM_MODEL ?? "claude-sonnet-4-5"}`;

interface Ingestion {
  readonly workspaceId: string;
  readonly digest: string;
  readonly turns: number;
  readonly ingestMs: number;
  readonly extractionModel: string;
  /** Deriver counter deltas over the ingestion: process-wide counters, ingestions serialized; workspace-level work the deriver schedules later (peer card, dreams) lands in the next conversation's delta. */
  readonly writeInputTokens: number;
  readonly writeOutputTokens: number;
  readonly writeTokensByTask: Record<string, { input: number; output: number }>;
  readonly queue: { total: number; completed: number };
  /** Conclusions the deriver stored for the workspace: the queue reports a failed LLM call as a completed work unit, so this is the real signal. */
  readonly conclusions: number;
  readonly ingestedAt: string;
}

const record = new IngestionRecord<Ingestion>(path.join(REPO_ROOT, "eval", "results", "honcho-workspaces.json"));
const serialized = new SerializedIngestion<Ingestion>();

function honchoFor(workspaceId: string): Honcho {
  const baseURL = process.env.HONCHO_BASE_URL?.replace(/\/$/, "");
  if (!baseURL) throw new Error("HONCHO_BASE_URL is not set (npm run engines:honcho:up; see .env.example)");
  const apiKey = process.env.HONCHO_API_KEY;
  return new Honcho({ baseURL, workspaceId, ...(apiKey ? { apiKey } : {}) });
}

async function workspaceExists(workspaceId: string): Promise<boolean> {
  const page = await honchoFor(workspaceId).workspaces({ filters: { id: workspaceId }, size: 1 });
  return page.items.includes(workspaceId);
}

/** Prometheus text exposition -> token totals by task_type, split input/output. */
async function deriverTokens(): Promise<Record<string, { input: number; output: number }>> {
  const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`deriver metrics at ${METRICS_URL}: HTTP ${res.status}`);
  const out: Record<string, { input: number; output: number }> = {};
  const unknown = new Set<string>();
  for (const line of (await res.text()).split("\n")) {
    const m = /^deriver_tokens_processed_total\{([^}]*)\}\s+([0-9.eE+-]+)/.exec(line);
    if (!m) continue;
    const labels = Object.fromEntries([...(m[1] ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const task = labels.task_type ?? "?";
    const side = labels.token_type === "output" ? "output" : "input";
    // `component` splits input into prompt/messages and output into output_total and finer parts; count the totals only,
    // and say so when Honcho publishes a component this parser does not know (it would otherwise be dropped silently).
    const known = side === "input" ? ["prompt", "messages"] : ["output_total"];
    if (!known.includes(labels.component ?? "")) {
      if (side === "output" && !/^output_/.test(labels.component ?? "")) unknown.add(`${side}:${labels.component}`);
      if (side === "input") unknown.add(`${side}:${labels.component}`);
      continue;
    }
    out[task] ??= { input: 0, output: 0 };
    out[task][side] += Number(m[2]);
  }
  if (unknown.size > 0) console.warn(`[${ARM}] deriver metrics have component labels this arm does not count: ${[...unknown].join(", ")}`);
  return out;
}

/** Counter deltas per task; a deriver restart in between resets the counters, which would read as a negative write cost. */
function diff(after: Record<string, { input: number; output: number }>, before: Record<string, { input: number; output: number }>): Record<string, { input: number; output: number }> {
  const out: Record<string, { input: number; output: number }> = {};
  for (const [task, a] of Object.entries(after)) {
    const b = before[task] ?? { input: 0, output: 0 };
    const d = { input: a.input - b.input, output: a.output - b.output };
    if (d.input < 0 || d.output < 0) throw new Error(`deriver token counters went backwards for ${task} (deriver restarted during ingestion?); the write-token delta for this conversation is not trustworthy, run it again`);
    if (d.input !== 0 || d.output !== 0) out[task] = d;
  }
  return out;
}

/** Until the session's queue reports no pending or in-progress work (enqueue itself is a background task, so first wait for work to appear). */
async function waitForDrain(honcho: Honcho, session: Session, expectedMessages: number): Promise<{ total: number; completed: number }> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  let sawWork = false;
  for (;;) {
    const q = await honcho.queueStatus({ session });
    if (q.totalWorkUnits > 0) sawWork = true;
    const busy = q.pendingWorkUnits + q.inProgressWorkUnits;
    if (sawWork && busy === 0) return { total: q.totalWorkUnits, completed: q.completedWorkUnits };
    if (!sawWork && expectedMessages > 0 && Date.now() - (deadline - DRAIN_TIMEOUT_MS) > 60_000) {
      throw new Error(`${session.workspaceId}: no deriver work appeared within 60 s of adding ${expectedMessages} messages (is the deriver running?)`);
    }
    if (Date.now() > deadline) throw new Error(`${session.workspaceId}: Honcho deriver did not drain within ${DRAIN_TIMEOUT_MS} ms (${JSON.stringify(q)})`);
    await sleep(DRAIN_POLL_MS);
  }
}

async function ingest(conversationId: string): Promise<Ingestion> {
  const workspaceId = `eval-${conversationId.slice(0, 8)}`;
  const turns = await loadConversation(conversationId);
  const digest = digestOf(turns);
  const known = await record.get(conversationId);
  if (known) {
    if (known.workspaceId !== workspaceId || known.digest !== digest) throw new Error(`${workspaceId} was ingested from different content (${known.digest.slice(0, 12)}); delete the Honcho workspace and its entry in ${record.path}, then run again`);
    if (await workspaceExists(workspaceId)) return known;
  } else if (await workspaceExists(workspaceId)) {
    // Messages have no idempotency key in Honcho, so a half-finished ingestion cannot be resumed without duplicating turns.
    throw new Error(`Honcho workspace ${workspaceId} exists but has no ingestion record in ${record.path}; delete its session and the workspace (DELETE /v3/workspaces/${workspaceId}/sessions/${SESSION}, then DELETE /v3/workspaces/${workspaceId}) and run again`);
  }
  const honcho = honchoFor(workspaceId);
  const before = await deriverTokens();
  const started = Date.now();
  await honcho.peer(USER);
  await honcho.peer(ASSISTANT);
  const session = await honcho.session(SESSION, { peers: [USER, ASSISTANT] });
  for (let i = 0; i < turns.length; i += 100) {
    await session.addMessages(
      turns.slice(i, i + 100).map((t) => ({
        peerId: t.role === "user" ? USER : ASSISTANT,
        content: t.text,
        createdAt: t.occurredAt,
        metadata: { conversationId, turnIndex: t.turnIndex, role: t.role },
      })),
    );
  }
  const queue = await waitForDrain(honcho, session, turns.length);
  const ingestMs = Date.now() - started;
  const conclusions = (await honcho.conclusions.list({ size: 1 })).total;
  // The queue reports a failed LLM call as a completed work unit; an ingestion that derived nothing is a failure, not a record.
  if (conclusions === 0) throw new Error(`${workspaceId}: the deriver stored no conclusions for ${turns.length} messages (its queue reports failed LLM calls as completed; see \`docker logs mem-honcho-deriver\`). Delete the session and workspace and run again.`);
  const byTask = diff(await deriverTokens(), before);
  const totals = Object.values(byTask).reduce((a, b) => ({ input: a.input + b.input, output: a.output + b.output }), { input: 0, output: 0 });
  const ingestion: Ingestion = {
    workspaceId,
    digest,
    turns: turns.length,
    extractionModel: EXTRACTION_MODEL,
    ingestMs,
    writeInputTokens: totals.input,
    writeOutputTokens: totals.output,
    writeTokensByTask: byTask,
    queue,
    conclusions,
    ingestedAt: new Date().toISOString(),
  };
  await record.save(conversationId, ingestion);
  console.log(`[${ARM}] ${workspaceId}: ${turns.length} messages, deriver drained in ${Math.round(ingestMs / 1000)} s (${queue.completed}/${queue.total} work units, ${conclusions} conclusions); deriver tokens ${totals.input} in / ${totals.output} out ${JSON.stringify(byTask)}`);
  return ingestion;
}

function renderMessage(m: Message): string {
  return `${m.peerId} (${m.createdAt}):\n${m.content}`;
}

export default class HonchoProvider implements ApiProvider {
  private readonly providerId: string;
  private readonly handles = new Map<string, Promise<{ honcho: Honcho; user: Peer; session: Session }>>();

  constructor(options: { id?: string } = {}) {
    this.providerId = options.id ?? "arm-d-honcho";
  }

  id(): string {
    return this.providerId;
  }

  private handle(workspaceId: string): Promise<{ honcho: Honcho; user: Peer; session: Session }> {
    let h = this.handles.get(workspaceId);
    if (!h) {
      h = (async () => {
        const honcho = honchoFor(workspaceId);
        return { honcho, user: await honcho.peer(USER), session: await honcho.session(SESSION) };
      })();
      h.catch(() => this.handles.delete(workspaceId));
      this.handles.set(workspaceId, h);
    }
    return h;
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const vars = evalVars(context);
    const ingestion = await serialized.ensure(vars.conversationId, () => ingest(vars.conversationId));
    const { user, session } = await this.handle(ingestion.workspaceId);
    const t0 = Date.now();
    const [representation, messages] = await Promise.all([
      user.representation({ session, searchQuery: vars.question, searchTopK: RECALL_LIMIT, maxConclusions: 25 }),
      session.search(vars.question, { limit: RECALL_LIMIT }),
    ]);
    const recallMs = Date.now() - t0;
    const rep = representation.trim() === "" ? "(none)" : representation.trim();
    const msgs = messages.length > 0 ? messages.map(renderMessage).join("\n\n") : "(none)";
    const userPrompt = `Here is what the user's memory recalled for this question.\n\n<representation>\n${rep}\n</representation>\n\n<messages>\n${msgs}\n</messages>\n\nQuestion: ${vars.question}${asOfInstruction(vars.asOf)}`;
    const a = await answer(ARM, userPrompt, context);
    return providerResponse(
      ARM,
      a,
      context,
      {
        questionId: vars.questionId,
        conversationId: vars.conversationId,
        type: vars.type,
        asOf: vars.asOf ?? null,
        bankId: ingestion.workspaceId,
        engine: "honcho 3.4.1",
        extractionModel: ingestion.extractionModel,
        recallMs,
        representationChars: rep.length,
        recalledMessages: messages.length,
        recallLimit: RECALL_LIMIT,
        conversationTurns: ingestion.turns,
        ingestMs: ingestion.ingestMs,
        writeInputTokens: ingestion.writeInputTokens,
        writeOutputTokens: ingestion.writeOutputTokens,
        writeTokensByTask: ingestion.writeTokensByTask,
        deriverQueue: ingestion.queue,
        conclusions: ingestion.conclusions,
      },
      recallMs + a.latencyMs,
    );
  }
}

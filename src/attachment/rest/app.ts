import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import { asBankId, asEpisodeId, asFactId, type BankId, type Scope } from "../../shared-kernel/index.js";
import { auditDenial, buildHandlers, type AppError, type AttachmentDeps } from "../handlers.js";
import { createMcpServer } from "../mcp/server.js";
import { serializeEpisode, serializeErasure, serializeFact } from "../serialize.js";
import { toHttpError } from "../errors.js";
import { fileExtensionOf } from "../../portability/index.js";
import { assertFactBody, erasureIdParam, exportQuery, listFactsQuery, recallBody, retainBody } from "./schemas.js";

/**
 * REST attachment. Thin: resolve Scope, validate input, call one application handler, map the
 * result. No domain logic lives here. Application handlers write their own audit entries
 * (inside the transaction for writes); the attachment only audits denials it sees first.
 * The MCP attachment is mounted on the same app under /v1/banks/:bankId/mcp and shares the
 * auth middleware and handlers.
 */
export type RestDeps = AttachmentDeps;

type Env = { Variables: { scope: Scope; bankId: BankId } };

export function createApp(deps: RestDeps): Hono<Env> {
  const app = new Hono<Env>();
  const handlers = buildHandlers(deps);
  const { recordEpisode, recall, assertFact: assertFactH, listFacts, getFact, setConfirmation, exportBank, eraseBank, getErasure } = handlers;

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Deny by default: anything under /v1 that is not a bank-scoped route is 404, never unauthenticated.
  app.use("/v1/*", async (c, next) => {
    if (!/^\/v1\/banks\/[^/]+\/.+/.test(new URL(c.req.url).pathname)) return c.json({ error: "not_found" }, 404);
    await next();
  });

  // Scope resolution for every bank-scoped route.
  app.use("/v1/banks/:bankId/*", async (c, next) => {
    const bankId = asBankId(c.req.param("bankId"));
    const resolved = await deps.scopes.resolve(bearerToken(c.req.header("authorization")), bankId);
    if (!resolved.ok) {
      if (resolved.error.kind === "NoGrant") {
        // Authenticated principal probing a bank it has no usable grant on: attributable, so audited.
        const { principalId, tenantId } = resolved.error;
        await deps.audit.append({ tenantId, bankId, principalId, action: "access.denied", details: { required: "grant" }, at: deps.clock.now() });
      }
      const { status, body } = toHttpError(resolved.error);
      return c.json(body, status);
    }
    c.set("scope", resolved.value);
    c.set("bankId", bankId);
    await next();
  });

  // MCP (Streamable HTTP, stateless): one server per request, bound to the resolved Scope.
  // Stateless means no server-to-client stream: GET (SSE) and DELETE (session) are not offered.
  app.all("/v1/banks/:bankId/mcp", async (c) => {
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405, { Allow: "POST" });
    }
    const server = createMcpServer(deps, handlers, c.get("scope"), c.get("bankId"));
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return (await transport.handleRequest(c)) ?? c.json({ error: "not_found" }, 404);
    } catch (e) {
      // The transport reports protocol errors (406/415/400/404) as HTTPExceptions with JSON-RPC bodies.
      if (e instanceof HTTPException) return e.getResponse();
      throw e;
    } finally {
      server.close().catch(() => {});
    }
  });

  // Retain: record an Episode. Extraction/indexing follow asynchronously via the outbox.
  app.post("/v1/banks/:bankId/episodes", async (c) => {
    const body = await parseJson(c, retainBody);
    if (!body.ok) return body.response;
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await recordEpisode.handle(scope, {
      id: asEpisodeId(randomUUID()),
      bankId,
      kind: body.value.kind,
      source: body.value.source,
      text: body.value.text,
      occurredAt: body.value.occurredAt ?? deps.clock.now(),
      ...(body.value.role !== undefined ? { role: body.value.role } : {}),
      ...(body.value.externalRef !== undefined ? { externalRef: body.value.externalRef } : {}),
    });
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    return c.json({ episodeId: r.value.episodeId }, 201);
  });

  // Recall.
  app.post("/v1/banks/:bankId/recall", async (c) => {
    const body = await parseJson(c, recallBody);
    if (!body.ok) return body.response;
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await recall.handle(scope, {
      bankId,
      query: body.value.query,
      limit: body.value.limit,
      includeEpisodes: body.value.includeEpisodes,
      ...(body.value.asOf !== undefined ? { asOf: body.value.asOf } : {}),
    });
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    return c.json({
      facts: r.value.facts.map((f) => ({ ...serializeFact(f), score: f.score })),
      episodes: r.value.episodes.map((e) => ({ ...serializeEpisode(e), score: e.score })),
    });
  });

  // Facts: assert (client-authored), list, get, confirm, dispute.
  app.post("/v1/banks/:bankId/facts", async (c) => {
    const body = await parseJson(c, assertFactBody);
    if (!body.ok) return body.response;
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await assertFactH.handle(scope, {
      id: asFactId(randomUUID()),
      bankId,
      statement: body.value.statement,
      sourceEpisodeIds: body.value.sourceEpisodeIds.map(asEpisodeId),
      ...(body.value.predicate !== undefined ? { predicate: body.value.predicate } : {}),
      ...(body.value.validFrom !== undefined ? { validFrom: body.value.validFrom } : {}),
    });
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    return c.json(serializeFact(r.value), 201);
  });

  app.get("/v1/banks/:bankId/facts", async (c) => {
    const q = listFactsQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ error: "invalid_query", detail: q.error.issues }, 400);
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await listFacts.handle(scope, bankId, q.data.asOf !== undefined ? { asOf: q.data.asOf } : {});
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    return c.json({ facts: r.value.map(serializeFact) });
  });

  app.get("/v1/banks/:bankId/facts/:factId", async (c) => {
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await getFact.handle(scope, bankId, asFactId(c.req.param("factId")));
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    return c.json(serializeFact(r.value));
  });

  for (const state of ["confirmed", "disputed"] as const) {
    const verb = state === "confirmed" ? "confirm" : "dispute";
    app.post(`/v1/banks/:bankId/facts/:factId/${verb}`, async (c) => {
      const scope = c.get("scope");
      const bankId = c.get("bankId");
      const r = await setConfirmation.handle(scope, bankId, asFactId(c.req.param("factId")), state);
      if (!r.ok) return fail(c, r.error, scope, bankId, deps);
      return c.json(serializeFact(r.value));
    });
  }

  // Export: the whole bank (every fact, closed and retracted ones included) as JSONL or Markdown. Read capability; recorded and audited.
  app.get("/v1/banks/:bankId/export", async (c) => {
    const q = exportQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!q.success) return c.json({ error: "invalid_query", detail: q.error.issues }, 400);
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await exportBank.handle(scope, { bankId, format: q.data.format });
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    const stamp = r.value.producedAt.toISOString().replace(/[:.]/g, "-");
    const safeName = bankId.replace(/[^A-Za-z0-9._-]/g, "_");
    return c.body(r.value.content, 200, {
      "content-type": r.value.contentType,
      "content-disposition": `attachment; filename="${safeName}-${stamp}.${fileExtensionOf(r.value.format)}"`,
      "x-mem-export-id": r.value.exportId,
    });
  });

  // Erasure: the one destructive operation. `erase` capability; runs the whole workflow (inventory, purge
  // every store, verify, receipt) before answering, so the response already carries the outcome. The
  // request record exists either way: 201 when `receipted`, 500 `erasure_failed` (with the record, so the
  // id can be looked up and the bank retried) when `failed`. No body is read.
  // Deliberately absent from MCP: an agent should never be able to erase its Subject's memory.
  app.post("/v1/banks/:bankId/erasure", async (c) => {
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await eraseBank.handle(scope, bankId);
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    const body = serializeErasure(r.value);
    return r.value.state === "receipted" ? c.json(body, 201) : c.json({ error: "erasure_failed", request: body }, 500);
  });

  app.get("/v1/banks/:bankId/erasure/:id", async (c) => {
    const id = erasureIdParam.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "erasure_not_found", detail: { requestId: c.req.param("id") } }, 404);
    const scope = c.get("scope");
    const bankId = c.get("bankId");
    const r = await getErasure.handle(scope, bankId, id.data);
    if (!r.ok) return fail(c, r.error, scope, bankId, deps);
    return c.json(serializeErasure(r.value));
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}

/** RFC 7235: the scheme is case-insensitive. */
function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim();
}

async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "invalid_json" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: c.json({ error: "invalid_body", detail: parsed.error.issues }, 400) };
  return { ok: true, value: parsed.data };
}

async function fail(c: Context, error: AppError, scope: Scope, bankId: BankId, deps: RestDeps): Promise<Response> {
  await auditDenial(deps, scope, bankId, error);
  const { status, body } = toHttpError(error);
  return c.json(body, status);
}

export { serializeEpisode, serializeFact };

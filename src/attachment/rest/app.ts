import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ZodType } from "zod";
import { asBankId, asEpisodeId, asFactId, type BankId, type Clock, type Scope } from "../../shared-kernel/index.js";
import type { AccessPolicy, AuditLogStore, ScopeResolver } from "../../governance/index.js";
import {
  AssertFactHandler,
  GetFactHandler,
  ListFactsHandler,
  RecallHandler,
  RecordEpisodeHandler,
  SetConfirmationHandler,
  type Episode,
  type Fact,
  type UnitOfWork,
  type EpisodeRepository,
  type FactRepository,
  type MemoryFinder,
} from "../../memory/index.js";
import { toHttpError, type AppError } from "./errors.js";
import { assertFactBody, listFactsQuery, recallBody, retainBody } from "./schemas.js";

/**
 * REST attachment. Thin: resolve Scope, validate input, call one application handler, map the
 * result. No domain logic lives here. Application handlers write their own audit entries
 * (inside the transaction for writes); the attachment only audits denials it sees first.
 */
export interface RestDeps {
  readonly scopes: ScopeResolver;
  readonly access: AccessPolicy;
  readonly audit: AuditLogStore;
  readonly clock: Clock;
  readonly uow: UnitOfWork;
  readonly facts: FactRepository;
  readonly episodes: EpisodeRepository;
  readonly finder: MemoryFinder;
}

type Env = { Variables: { scope: Scope; bankId: BankId } };

export function createApp(deps: RestDeps): Hono<Env> {
  const app = new Hono<Env>();
  const recordEpisode = new RecordEpisodeHandler(deps.uow, deps.access, deps.clock);
  const recall = new RecallHandler(deps.finder, deps.facts, deps.episodes, deps.access, deps.audit, deps.clock);
  const assertFactH = new AssertFactHandler(deps.uow, deps.access, deps.clock);
  const listFacts = new ListFactsHandler(deps.facts, deps.access, deps.audit, deps.clock);
  const getFact = new GetFactHandler(deps.facts, deps.access, deps.audit, deps.clock);
  const setConfirmation = new SetConfirmationHandler(deps.uow, deps.access, deps.clock);

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
  if (error.kind === "AccessDenied") {
    const required = String((error as AppError & { required?: unknown }).required);
    await deps.audit.append({ tenantId: scope.tenantId, bankId, principalId: scope.principalId, action: "access.denied", details: { required }, at: deps.clock.now() });
  }
  const { status, body } = toHttpError(error);
  return c.json(body, status);
}

export function serializeFact(f: Fact) {
  return {
    id: f.id,
    bankId: f.bankId,
    statement: f.statement,
    predicate: f.predicate ?? null,
    validity: { validFrom: f.validity.validFrom.toISOString(), validTo: f.validity.validTo?.toISOString() ?? null },
    transaction: { recordedAt: f.transaction.recordedAt.toISOString(), retractedAt: f.transaction.retractedAt?.toISOString() ?? null },
    provenance: f.provenance,
    supersedes: f.supersedes ?? null,
    supersededBy: f.supersededBy ?? null,
    invalidation: f.invalidation ? { ...f.invalidation, at: f.invalidation.at.toISOString() } : null,
  };
}

export function serializeEpisode(e: Episode) {
  return {
    id: e.id,
    bankId: e.bankId,
    kind: e.kind,
    source: e.source,
    role: e.role ?? null,
    text: e.text,
    occurredAt: e.occurredAt.toISOString(),
    recordedAt: e.recordedAt.toISOString(),
    recordedBy: e.recordedBy,
    externalRef: e.externalRef ?? null,
  };
}

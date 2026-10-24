import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { asPrincipalId, systemClock } from "../../src/shared-kernel/index.js";
import { generateApiKey, PgApiKeyStore, PgAuditLog, PgErasureRequestRepository, PgPrincipalRepository, ScopeResolver, scopeAccessPolicy, verifyChain, type Principal } from "../../src/governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutboxRelay, PgUnitOfWork } from "../../src/memory/index.js";
import { EngineMemoryFinder, HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../src/retrieval/index.js";
import { createApp } from "../../src/attachment/rest/app.js";
import { serializeErasure } from "../../src/attachment/serialize.js";
import { PgExportStore } from "../../src/portability/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, tenant } from "../helpers/fixtures.js";
import { erasureDeps } from "../helpers/erasure.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describeWithDb("REST attachment", () => {
  let db: TestDb;
  let app: ReturnType<typeof createApp>;
  let deps: Parameters<typeof createApp>[0];
  let relay: PgOutboxRelay;
  let projector: IndexingProjector;
  let rwKey: string; // read+write on bank A
  let roKey: string; // read on bank A
  let bothKey: string; // read+write on A and B
  const bankA = bankFixture("bank-a");
  const bankB = bankFixture("bank-b");

  const headers = (key: string) => ({ authorization: `Bearer ${key}`, "content-type": "application/json" });
  const post = (path: string, key: string, body: unknown) => app.request(path, { method: "POST", headers: headers(key), body: JSON.stringify(body) });
  const get = (path: string, key: string) => app.request(path, { headers: headers(key) });
  const json = async <T,>(res: Response): Promise<T> => (await res.json()) as T;
  const drain = () => relay.drainAll((events) => projector.handle(events));
  // Table names are test constants, never input.
  const rowsIn = async (table: string) => (await db.pool.query(`SELECT 1 FROM ${table} WHERE bank_id = $1`, [bankA.id])).rows;
  const retain = async (key: string, bank: string, text: string, extra: Record<string, unknown> = {}) => {
    const res = await post(`/v1/banks/${bank}/episodes`, key, { source: "test", text, ...extra });
    expect(res.status).toBe(201);
    return (await json<{ episodeId: string }>(res)).episodeId;
  };

  beforeAll(async () => {
    db = await setupTestDb();
    const engine = new PgvectorEngine(db.pool, new HashingEmbedder(256));
    const facts = new PgFactRepository(db.pool);
    const episodes = new PgEpisodeRepository(db.pool);
    relay = new PgOutboxRelay(db.pool);
    projector = new IndexingProjector(engine, facts, episodes);
    deps = {
      scopes: new ScopeResolver(new PgPrincipalRepository(db.pool), new PgBankRepository(db.pool), systemClock),
      access: scopeAccessPolicy,
      audit: new PgAuditLog(db.pool),
      clock: systemClock,
      uow: new PgUnitOfWork(db.pool),
      banks: new PgBankRepository(db.pool),
      facts,
      episodes,
      finder: new EngineMemoryFinder(engine),
      exports: new PgExportStore(db.pool),
      erasure: erasureDeps(db.pool, engine),
    };
    app = createApp(deps);
  });
  afterAll(async () => db.close());
  afterEach(() => vi.useRealTimers());

  beforeEach(async () => {
    await db.truncateAll();
    const banks = new PgBankRepository(db.pool);
    await banks.create(bankA);
    await banks.create(bankB);
    const principals = new PgPrincipalRepository(db.pool);
    const keys = new PgApiKeyStore(db.pool);
    const rw: Principal = { id: asPrincipalId("rw"), tenantId: tenant, kind: "agent", displayName: "rw", grants: [{ bankId: bankA.id, capabilities: new Set(["read", "write"]), grantedAt: new Date() }] };
    const ro: Principal = { id: asPrincipalId("ro"), tenantId: tenant, kind: "human", displayName: "ro", grants: [{ bankId: bankA.id, capabilities: new Set(["read"]), grantedAt: new Date() }] };
    const both: Principal = {
      id: asPrincipalId("both"),
      tenantId: tenant,
      kind: "agent",
      displayName: "both",
      grants: [
        { bankId: bankA.id, capabilities: new Set(["read", "write"]), grantedAt: new Date() },
        { bankId: bankB.id, capabilities: new Set(["read", "write"]), grantedAt: new Date() },
      ],
    };
    for (const p of [rw, ro, both]) await principals.save(p);
    const issued = await Promise.all(
      [rw, ro, both].map(async (p) => {
        const k = generateApiKey();
        await keys.issue(p.id, k.hash, "t");
        return k.token;
      }),
    );
    [rwKey, roKey, bothKey] = issued as [string, string, string];
  });

  it("health endpoint needs no auth; unknown /v1 paths are 404 not open", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/v1/whatever")).status).toBe(404);
    expect((await app.request("/v1/banks/bank-a")).status).toBe(404);
  });

  it("rejects missing, bad and unknown credentials with 401; accepts lowercase scheme", async () => {
    expect((await app.request(`/v1/banks/${bankA.id}/facts`)).status).toBe(401);
    expect((await get(`/v1/banks/${bankA.id}/facts`, "garbage")).status).toBe(401);
    expect((await get(`/v1/banks/${bankA.id}/facts`, generateApiKey().token)).status).toBe(401);
    expect((await app.request(`/v1/banks/${bankA.id}/facts`, { headers: { authorization: `bearer ${roKey}` } })).status).toBe(200);
  });

  it("returns 403 for a bank the principal has no grant on, and audits the probe", async () => {
    expect((await get(`/v1/banks/${bankB.id}/facts`, rwKey)).status).toBe(403);
    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => [a.action, a.principalId, a.bankId])).toEqual([["access.denied", "rw", bankB.id]]);
  });

  it("retain -> project -> recall returns the episode; audit records ids only and verifies", async () => {
    const episodeId = await retain(rwKey, bankA.id, "we decided to use pgvector as the default retrieval engine", { role: "user", occurredAt: "2026-10-23T10:00:00Z", externalRef: "cc:session1:turn3" });
    expect(await drain()).toBe(1);

    const res = await post(`/v1/banks/${bankA.id}/recall`, rwKey, { query: "which retrieval engine is the default, pgvector?", includeEpisodes: true });
    expect(res.status).toBe(200);
    const body = await json<{ facts: unknown[]; episodes: { id: string; text: string; score: number }[] }>(res);
    expect(body.facts).toEqual([]);
    expect(body.episodes[0]?.id).toBe(episodeId);
    expect(body.episodes[0]?.text).toContain("pgvector");

    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["episode.recorded", "recall.served"]);
    expect(JSON.stringify(audit[1]?.details)).not.toContain("pgvector as the default");
    expect(audit[1]?.details["episodeIds"]).toEqual([episodeId]);
    expect(verifyChain(audit, sha256)).toBeUndefined();
  });

  it("duplicate externalRef is a 409 and leaves no second audit entry", async () => {
    await retain(rwKey, bankA.id, "same turn", { externalRef: "dup:1" });
    const second = await post(`/v1/banks/${bankA.id}/episodes`, rwKey, { source: "test", text: "same turn", externalRef: "dup:1" });
    expect(second.status).toBe(409);
    expect((await json<{ error: string }>(second)).error).toBe("duplicate_episode");
    expect((await new PgAuditLog(db.pool).list(tenant)).length).toBe(1);
  });

  it("validates bodies and ignores client-supplied ids", async () => {
    expect((await post(`/v1/banks/${bankA.id}/episodes`, rwKey, { source: "s" })).status).toBe(400);
    expect((await post(`/v1/banks/${bankA.id}/recall`, rwKey, { query: "" })).status).toBe(400);
    const res = await app.request(`/v1/banks/${bankA.id}/recall`, { method: "POST", headers: headers(rwKey), body: "{not json" });
    expect(res.status).toBe(400);
    const id = await retain(rwKey, bankA.id, "x", { id: "attacker-chosen" });
    expect(id).not.toBe("attacker-chosen");
  });

  it("read-only principal can recall, list and get but cannot retain or assert; denial and reads are audited", async () => {
    expect((await post(`/v1/banks/${bankA.id}/episodes`, roKey, { source: "s", text: "nope" })).status).toBe(403);
    expect((await get(`/v1/banks/${bankA.id}/facts`, roKey)).status).toBe(200);
    expect((await post(`/v1/banks/${bankA.id}/recall`, roKey, { query: "anything" })).status).toBe(200);
    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["access.denied", "facts.listed", "recall.served"]);
    expect(audit[0]?.principalId).toBe("ro");
  });

  it("assert fact requires existing source episodes; then list, get, recall, confirm, dispute", async () => {
    const episodeId = await retain(rwKey, bankA.id, "I use neovim as my editor now", { occurredAt: "2026-06-01T00:00:00Z" });

    expect((await post(`/v1/banks/${bankA.id}/facts`, rwKey, { statement: "editor is neovim", sourceEpisodeIds: ["ghost"] })).status).toBe(422);
    expect((await post(`/v1/banks/${bankA.id}/facts`, rwKey, { statement: "x", sourceEpisodeIds: [] })).status).toBe(400);

    const asserted = await post(`/v1/banks/${bankA.id}/facts`, rwKey, { statement: "the user's editor is neovim", sourceEpisodeIds: [episodeId], validFrom: "2026-06-01T00:00:00Z" });
    expect(asserted.status).toBe(201);
    const fact = await json<{ id: string; provenance: { confirmation: string; writerPrincipalId: string; sourceEpisodeIds: string[] } }>(asserted);
    expect(fact.provenance.sourceEpisodeIds).toEqual([episodeId]);
    expect(fact.provenance.writerPrincipalId).toBe("rw");
    expect(fact.provenance.confirmation).toBe("asserted");

    const listed = await json<{ facts: { id: string }[] }>(await get(`/v1/banks/${bankA.id}/facts`, roKey));
    expect(listed.facts.map((f) => f.id)).toEqual([fact.id]);
    const before = await json<{ facts: unknown[] }>(await get(`/v1/banks/${bankA.id}/facts?asOf=2026-01-01T00:00:00Z`, roKey));
    expect(before.facts).toEqual([]);

    expect((await get(`/v1/banks/${bankA.id}/facts/${fact.id}`, roKey)).status).toBe(200);
    expect((await get(`/v1/banks/${bankA.id}/facts/nope`, roKey)).status).toBe(404);

    await drain();
    const recalled = await json<{ facts: { id: string }[] }>(await post(`/v1/banks/${bankA.id}/recall`, roKey, { query: "which editor neovim" }));
    expect(recalled.facts.map((f) => f.id)).toEqual([fact.id]);

    const disputed = await json<{ provenance: { confirmation: string } }>(await post(`/v1/banks/${bankA.id}/facts/${fact.id}/dispute`, rwKey, {}));
    expect(disputed.provenance.confirmation).toBe("disputed");
    const confirmed = await json<{ provenance: { confirmation: string } }>(await post(`/v1/banks/${bankA.id}/facts/${fact.id}/confirm`, rwKey, {}));
    expect(confirmed.provenance.confirmation).toBe("confirmed");
    expect((await post(`/v1/banks/${bankA.id}/facts/${fact.id}/confirm`, roKey, {})).status).toBe(403);
    expect((await post(`/v1/banks/${bankA.id}/facts/nope/confirm`, rwKey, {})).status).toBe(404);

    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual([
      "episode.recorded",
      "fact.asserted",
      "facts.listed",
      "facts.listed",
      "fact.read",
      "recall.served",
      "fact.disputed",
      "fact.confirmed",
      "access.denied",
    ]);
    expect(verifyChain(audit, sha256)).toBeUndefined();
  });

  it("a principal granted on both banks cannot cross banks by id", async () => {
    const epA = await retain(bothKey, bankA.id, "fact source in A");
    const factA = await json<{ id: string }>(await post(`/v1/banks/${bankA.id}/facts`, bothKey, { statement: "lives in A", sourceEpisodeIds: [epA] }));

    expect((await get(`/v1/banks/${bankB.id}/facts/${factA.id}`, bothKey)).status).toBe(404);
    expect((await post(`/v1/banks/${bankB.id}/facts/${factA.id}/confirm`, bothKey, {})).status).toBe(404);
    expect((await post(`/v1/banks/${bankB.id}/facts`, bothKey, { statement: "smuggled", sourceEpisodeIds: [epA] })).status).toBe(422);
    const listB = await json<{ facts: unknown[] }>(await get(`/v1/banks/${bankB.id}/facts`, bothKey));
    expect(listB.facts).toEqual([]);

    await drain();
    const recallB = await json<{ facts: unknown[]; episodes: unknown[] }>(await post(`/v1/banks/${bankB.id}/recall`, bothKey, { query: "lives in A fact source", includeEpisodes: true }));
    expect(recallB).toEqual({ facts: [], episodes: [] });
  });

  it("recall does not surface a fact the index still holds but the system of record has retracted", async () => {
    const ep = await retain(rwKey, bankA.id, "source");
    const fact = await json<{ id: string }>(await post(`/v1/banks/${bankA.id}/facts`, rwKey, { statement: "the sky is green", sourceEpisodeIds: [ep] }));
    await drain();
    // Simulate index lag: retract in the system of record without the projector seeing it.
    // The fact's own timestamps came from the Node clock a moment ago; clamp so Postgres now()
    // can never land before them and trip the valid_from <= valid_to / recorded_at <= retracted_at checks.
    await db.pool.query(
      "UPDATE memory.facts SET retracted_at = GREATEST(now(), recorded_at), valid_to = GREATEST(now(), valid_from) WHERE id = $1",
      [fact.id],
    );
    const recalled = await json<{ facts: unknown[] }>(await post(`/v1/banks/${bankA.id}/recall`, rwKey, { query: "sky green" }));
    expect(recalled.facts).toEqual([]);
    expect((await post(`/v1/banks/${bankA.id}/facts/${fact.id}/confirm`, rwKey, {})).status).toBe(409);
  });

  it("export: read capability, JSONL by default, Markdown on request, bad format is 400; recorded and audited", async () => {
    const ep = await retain(rwKey, bankA.id, "source");
    await post(`/v1/banks/${bankA.id}/facts`, rwKey, { statement: "the user's editor is neovim", sourceEpisodeIds: [ep] });

    const jsonl = await get(`/v1/banks/${bankA.id}/export`, roKey);
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(jsonl.headers.get("content-disposition")).toMatch(/^attachment; filename="bank-a-.*\.jsonl"$/);
    const lines = (await jsonl.text()).trim().split("\n").map((l) => JSON.parse(l) as { record: string; statement?: string });
    expect(lines.map((l) => l.record)).toEqual(["header", "fact"]);
    expect(lines[1]?.statement).toBe("the user's editor is neovim");

    const md = await get(`/v1/banks/${bankA.id}/export?format=markdown`, roKey);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await md.text()).toContain("- the user's editor is neovim");

    expect((await get(`/v1/banks/${bankA.id}/export?format=xml`, roKey)).status).toBe(400);
    expect((await get(`/v1/banks/${bankB.id}/export`, roKey)).status).toBe(403);

    const exportId = jsonl.headers.get("x-mem-export-id");
    const recorded = await new PgExportStore(db.pool).listByBank({ tenantId: tenant, bankId: bankA.id, principalId: asPrincipalId("ro"), capabilities: new Set() });
    expect(recorded.map((e) => e.format).sort()).toEqual(["jsonl", "markdown"]);
    expect(recorded.some((e) => e.id === exportId && e.principalId === "ro")).toBe(true);
    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["episode.recorded", "fact.asserted", "export.produced", "export.produced", "access.denied"]);
  });

  it("erasure: needs the erase capability, runs to a receipt, removes every grant and dedicated key (the GET route is proven with a repository-level re-grant, which admin grant refuses on erased banks); a stuck request is 409", async () => {
    const principals = new PgPrincipalRepository(db.pool);
    const keys = new PgApiKeyStore(db.pool);
    const issue = async (id: string, bankId: string) => {
      await principals.save({ id: asPrincipalId(id), tenantId: tenant, kind: "human", displayName: id, grants: [{ bankId: bankId as never, capabilities: new Set(["erase"]), grantedAt: new Date() }] });
      const k = generateApiKey();
      await keys.issue(asPrincipalId(id), k.hash, "t");
      return k.token;
    };
    const eraserKey = await issue("eraser", bankA.id);
    const eraserBKey = await issue("eraser-b", bankB.id);

    const ep = await retain(rwKey, bankA.id, "the user lives in Lisbon");
    await post(`/v1/banks/${bankA.id}/facts`, rwKey, { statement: "the user lives in Lisbon", sourceEpisodeIds: [ep] });
    await drain();

    // read+write is not enough; neither is read. Both denials are audited.
    expect((await post(`/v1/banks/${bankA.id}/erasure`, rwKey, {})).status).toBe(403);
    expect((await post(`/v1/banks/${bankA.id}/erasure`, roKey, {})).status).toBe(403);
    expect((await rowsIn("memory.facts")).length).toBe(1);
    // Unknown or malformed request ids are 404 (checked before the erasure: afterwards no key reaches the bank, see below).
    expect((await app.request(`/v1/banks/${bankA.id}/erasure/not-a-uuid`, { headers: { authorization: `Bearer ${eraserKey}` } })).status).toBe(404);
    expect((await app.request(`/v1/banks/${bankA.id}/erasure/00000000-0000-4000-8000-000000000000`, { headers: { authorization: `Bearer ${eraserKey}` } })).status).toBe(404);

    const res = await app.request(`/v1/banks/${bankA.id}/erasure`, { method: "POST", headers: { authorization: `Bearer ${eraserKey}` } });
    expect(res.status).toBe(201);
    const body = await json<{ id: string; state: string; stores: { store: string; countBefore: number; deleted: number; hitsAfter: number }[]; receipt: { digest: string; deletions: unknown[] } | null; failure: string | null }>(res);
    expect(body.state).toBe("receipted");
    expect(body.failure).toBeNull();
    expect(body.receipt?.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.fromEntries(body.stores.map((s) => [s.store, [s.countBefore, s.deleted, s.hitsAfter]]))).toEqual({
      "memory.facts": [1, 1, 0],
      "memory.episodes": [1, 1, 0],
      "memory.outbox": [2, 2, 0],
      "retrieval.pgvector": [2, 2, 0],
      "extraction.runs": [0, 0, 0],
      "portability.exports": [0, 0, 0],
      // Every grant on A (rw, ro, both, eraser) and the keys of the principals that existed only for A (rw, ro, eraser).
      "governance.grants": [4, 4, 0],
      "governance.api_keys": [3, 3, 0],
    });
    expect(await rowsIn("memory.facts")).toEqual([]);
    expect(await rowsIn("retrieval.pgvector_index")).toEqual([]);
    expect(await rowsIn("governance.grants")).toEqual([]);

    // Access went with the data: the eraser's and the readers' keys are revoked (401), the principal that also holds bank B
    // keeps its key but no longer has a grant on A (403, audited). The receipt is the POST response and the stored request
    // (`admin erasure-status` / `verify-receipt`); over REST nobody can read it back, since no grant on the bank is left.
    expect((await app.request(`/v1/banks/${bankA.id}/erasure/${body.id}`, { headers: { authorization: `Bearer ${eraserKey}` } })).status).toBe(401);
    expect((await get(`/v1/banks/${bankA.id}/erasure/${body.id}`, roKey)).status).toBe(401);
    expect((await get(`/v1/banks/${bankA.id}/erasure/${body.id}`, bothKey)).status).toBe(403);
    expect((await get(`/v1/banks/${bankB.id}/erasure/${body.id}`, bothKey)).status).toBe(403);
    expect((await get(`/v1/banks/${bankB.id}/erasure/${body.id}`, eraserBKey)).status).toBe(404);
    const stored = await new PgErasureRequestRepository(db.pool).get(body.id);
    expect(stored && JSON.parse(JSON.stringify(serializeErasure(stored)))).toEqual(body);
    // A grant written at the repository level (admin grant refuses erased banks; this only exercises the route): a fresh key with erase reads the record, read+write alone is 403 (audited).
    const eraserAgain = await issue("eraser", bankA.id);
    const bothAgain = (await principals.get(asPrincipalId("both")))!;
    await principals.save({ ...bothAgain, grants: [...bothAgain.grants, { bankId: bankA.id, capabilities: new Set(["read", "write"]), grantedAt: new Date() }] });
    const got = await app.request(`/v1/banks/${bankA.id}/erasure/${body.id}`, { headers: { authorization: `Bearer ${eraserAgain}` } });
    expect(got.status).toBe(200);
    expect(await json(got)).toEqual(body);
    expect((await get(`/v1/banks/${bankA.id}/erasure/${body.id}`, bothKey)).status).toBe(403);

    // A request left in flight (as after a crash) makes a new one 409 until an operator abandons it.
    await db.pool.query("INSERT INTO governance.erasure_requests (id, tenant_id, bank_id, subject_id, requested_by, requested_at, state) VALUES ($1, $2, $3, $4, 'eraser-b', now(), 'inventoried')", [
      "11111111-1111-4111-8111-111111111111", tenant, bankB.id, bankB.subjectId,
    ]);
    const stuck = await app.request(`/v1/banks/${bankB.id}/erasure`, { method: "POST", headers: { authorization: `Bearer ${eraserBKey}` } });
    expect(stuck.status).toBe(409);
    expect((await json<{ error: string }>(stuck)).error).toBe("erasure_in_flight");

    // The bank is a tombstone even for a principal an operator grants on it afterwards: writes and exports are refused,
    // recall is empty, the audit chain carries the receipt digest.
    expect((await post(`/v1/banks/${bankA.id}/episodes`, bothKey, { source: "test", text: "after erasure" })).status).toBe(409);
    expect((await get(`/v1/banks/${bankA.id}/export`, bothKey)).status).toBe(409);
    expect(await rowsIn("portability.exports")).toEqual([]);
    const recalled = await json<{ facts: unknown[]; episodes: unknown[] }>(await post(`/v1/banks/${bankA.id}/recall`, bothKey, { query: "Lisbon", includeEpisodes: true }));
    expect(recalled).toEqual({ facts: [], episodes: [] });
    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(verifyChain(audit, sha256)).toBeUndefined();
    expect(audit.filter((a) => a.action.startsWith("erasure.")).map((a) => [a.action, a.principalId])).toEqual([
      ["erasure.requested", "eraser"],
      ["erasure.access_revoked", "eraser"],
      ["erasure.deleted", "eraser"],
      ["erasure.verified", "eraser"],
      ["erasure.receipt_issued", "eraser"],
    ]);
    expect(audit.find((a) => a.action === "erasure.access_revoked")?.details).toEqual({ requestId: body.id, "deleted.governance.grants": 4, "deleted.governance.api_keys": 3 });
    expect(audit.find((a) => a.action === "erasure.receipt_issued")?.details["digest"]).toBe(body.receipt?.digest);
    // rw and ro: erasure without the capability; both: probing A with no grant left, B's erasure record without erase, then A's after the re-grant.
    expect(audit.filter((a) => a.action === "access.denied").map((a) => [a.principalId, a.details["required"]])).toEqual([["rw", "erase"], ["ro", "erase"], ["both", "grant"], ["both", "erase"], ["both", "erase"]]);
  });

  it("rate limit: per API key over everything under /v1 (MCP included), 429 with the standard headers; a per-address ceiling catches clients without a valid key; /healthz is exempt; the window resets", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const limited = createApp(deps, { rateLimitPerMinute: 3, rateLimitPerAddressPerMinute: 10 });
    // @hono/node-server exposes the socket on c.env; the test injects it the same way (app.request's third argument).
    const from = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
    const list = (key: string, address = "10.0.0.1") => limited.request(`/v1/banks/${bankA.id}/facts`, { headers: headers(key) }, from(address));
    for (const remaining of ["2", "1", "0"]) {
      const res = await list(rwKey);
      expect(res.status).toBe(200);
      expect([res.headers.get("ratelimit-limit"), res.headers.get("ratelimit-remaining"), res.headers.get("ratelimit-policy")]).toEqual(["3", remaining, "3;w=60"]);
    }
    const blocked = await list(rwKey);
    expect(blocked.status).toBe(429);
    expect(await json(blocked)).toEqual({ error: "rate_limited" });
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
    // The same key is throttled on the MCP route too, before any handler or transport runs.
    const mcp = await limited.request(`/v1/banks/${bankA.id}/mcp`, { method: "POST", headers: { ...headers(rwKey), accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(mcp.status).toBe(429);
    // Other keys have their own window; the bucket is the key's hash, so a key is never compared in plaintext.
    expect((await list(roKey)).status).toBe(200);
    // No credential, or a malformed one, counts against the client's address: 401 until that window is spent, then 429; another address is unaffected.
    const anon = (address: string, token = "Bearer mem_nope") => limited.request(`/v1/banks/${bankA.id}/facts`, { headers: { authorization: token } }, from(address));
    for (let i = 0; i < 3; i++) expect((await anon("10.0.0.2")).status).toBe(401);
    expect((await anon("10.0.0.2")).status).toBe(429);
    expect((await anon("10.0.0.2", "Bearer ")).status).toBe(429);
    expect((await anon("10.0.0.3")).status).toBe(401);
    // Rotating well-formed but unknown tokens gets a fresh key bucket each time, so the per-address ceiling (10 here) is what stops it: 5 more from 10.0.0.1 (5 spent above) then 429.
    const fresh = () => `Bearer mem_${"x".repeat(40)}${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 5; i++) expect((await anon("10.0.0.1", fresh())).status).toBe(401);
    const ceiling = await anon("10.0.0.1", fresh());
    expect(ceiling.status).toBe(429);
    expect(ceiling.headers.get("ratelimit-limit")).toBe("10");
    // Unknown address (no socket, as in-process requests without an env): one shared bucket, never a crash.
    expect((await limited.request(`/v1/banks/${bankA.id}/facts`, { headers: headers(roKey) })).status).toBe(200);
    // Health is outside /v1 and never limited; the default app advertises its 600/minute.
    for (let i = 0; i < 5; i++) expect((await limited.request("/healthz")).status).toBe(200);
    expect((await get(`/v1/banks/${bankA.id}/facts`, rwKey)).headers.get("ratelimit-limit")).toBe("600");
    // The window is fixed from the first hit: a minute later the exhausted key is served again.
    vi.advanceTimersByTime(60_001);
    expect((await list(rwKey, "10.0.0.9")).status).toBe(200);
    // An explicit 0 for the address ceiling means none, not "nothing allowed".
    const noCeiling = createApp(deps, { rateLimitPerMinute: 3, rateLimitPerAddressPerMinute: 0 });
    for (let i = 0; i < 5; i++) expect((await noCeiling.request(`/v1/banks/${bankA.id}/facts`, { headers: { authorization: fresh() } }, from("10.0.0.1"))).status).toBe(401);
  });

  it("projector is idempotent under redelivery", async () => {
    await retain(rwKey, bankA.id, "redeliver me");
    let captured: Parameters<IndexingProjector["handle"]>[0] = [];
    await relay.drainAll(async (evs) => {
      captured = evs;
    });
    await projector.handle(captured);
    await projector.handle(captured);
    const { rows } = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM retrieval.pgvector_index");
    expect(rows[0]?.n).toBe("1");
  });
});

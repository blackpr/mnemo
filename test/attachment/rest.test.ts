import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asPrincipalId, systemClock } from "../../src/shared-kernel/index.js";
import { generateApiKey, PgApiKeyStore, PgAuditLog, PgPrincipalRepository, ScopeResolver, scopeAccessPolicy, verifyChain, type Principal } from "../../src/governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutboxRelay, PgUnitOfWork } from "../../src/memory/index.js";
import { EngineMemoryFinder, HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../src/retrieval/index.js";
import { createApp } from "../../src/attachment/rest/app.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, tenant } from "../helpers/fixtures.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describeWithDb("REST attachment", () => {
  let db: TestDb;
  let app: ReturnType<typeof createApp>;
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
    app = createApp({
      scopes: new ScopeResolver(new PgPrincipalRepository(db.pool), new PgBankRepository(db.pool), systemClock),
      access: scopeAccessPolicy,
      audit: new PgAuditLog(db.pool),
      clock: systemClock,
      uow: new PgUnitOfWork(db.pool),
      facts,
      episodes,
      finder: new EngineMemoryFinder(engine),
    });
  });
  afterAll(async () => db.close());

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
    await db.pool.query("UPDATE memory.facts SET retracted_at = now(), valid_to = now() WHERE id = $1", [fact.id]);
    const recalled = await json<{ facts: unknown[] }>(await post(`/v1/banks/${bankA.id}/recall`, rwKey, { query: "sky green" }));
    expect(recalled.facts).toEqual([]);
    expect((await post(`/v1/banks/${bankA.id}/facts/${fact.id}/confirm`, rwKey, {})).status).toBe(409);
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

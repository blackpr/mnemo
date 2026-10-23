import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asPrincipalId, systemClock } from "../../src/shared-kernel/index.js";
import { generateApiKey, PgApiKeyStore, PgAuditLog, PgPrincipalRepository, ScopeResolver, scopeAccessPolicy, type Principal } from "../../src/governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgFactRepository, PgOutboxRelay, PgUnitOfWork } from "../../src/memory/index.js";
import { EngineMemoryFinder, HashingEmbedder, IndexingProjector, PgvectorEngine } from "../../src/retrieval/index.js";
import { createApp } from "../../src/attachment/rest/app.js";
import { PgExportStore } from "../../src/portability/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, tenant } from "../helpers/fixtures.js";


describeWithDb("MCP attachment", () => {
  let db: TestDb;
  let app: ReturnType<typeof createApp>;
  let relay: PgOutboxRelay;
  let projector: IndexingProjector;
  let rwKey: string;
  let roKey: string;
  const bankA = bankFixture("bank-a");
  const bankB = bankFixture("bank-b");

  /** An MCP client whose HTTP goes straight into the Hono app (no sockets). */
  const connect = async (key: string | undefined, bank = bankA.id) => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://mem.test/v1/banks/${bank}/mcp`), {
      fetch: async (url, init) => app.request(url instanceof URL ? url.toString() : url, init),
      ...(key ? { requestInit: { headers: { authorization: `Bearer ${key}` } } } : {}),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    // The SDK's Transport type is not exactOptionalPropertyTypes-clean; the object is the SDK's own.
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    return client;
  };
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  const drain = () => relay.drainAll((events) => projector.handle(events));

  beforeAll(async () => {
    db = await setupTestDb();
    const engine = new PgvectorEngine(db.pool, new HashingEmbedder(256));
    const facts = new PgFactRepository(db.pool);
    const episodes = new PgEpisodeRepository(db.pool);
    relay = new PgOutboxRelay(db.pool, { backoffMs: () => 0 });
    projector = new IndexingProjector(engine, facts, episodes);
    app = createApp({
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
    await principals.save(rw);
    await principals.save(ro);
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    await keys.issue(rw.id, k1.hash, "t");
    await keys.issue(ro.id, k2.hash, "t");
    rwKey = k1.token;
    roKey = k2.token;
  });

  it("lists the five tools with annotations", async () => {
    const client = await connect(rwKey);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["confirm_fact", "dispute_fact", "list_facts", "recall", "retain"]);
    expect(tools.find((t) => t.name === "recall")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "retain")?.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });

  it("refuses to initialize without a valid key or on a bank without a grant", async () => {
    await expect(connect(undefined)).rejects.toThrow(/unauthorized/);
    await expect(connect(generateApiKey().token)).rejects.toThrow(/unauthorized/);
    await expect(connect(rwKey, bankB.id)).rejects.toThrow(/forbidden/);
  });

  it("retain -> project -> recall round trip through MCP, with structured content", async () => {
    const client = await connect(rwKey);
    const retained = await client.callTool({ name: "retain", arguments: { text: "I switched my editor to neovim last week", verbatim: true, source: "claude-code", externalRef: "cc:s1:t1" } });
    expect(retained.isError).toBeFalsy();
    const episodeId = (retained.structuredContent as { episodeId: string }).episodeId;
    expect(text(retained)).toContain(episodeId);

    await drain();
    const recalled = await client.callTool({ name: "recall", arguments: { query: "which editor neovim", includeEpisodes: true } });
    const sc = recalled.structuredContent as { facts: unknown[]; episodes: { id: string }[] };
    expect(sc.facts).toEqual([]);
    expect(sc.episodes[0]?.id).toBe(episodeId);
    expect(text(recalled)).toContain("No facts in memory match");
    expect(text(recalled)).toContain("neovim");

    // Idempotent retain via externalRef surfaces as a tool error, not a transport error.
    const dup = await client.callTool({ name: "retain", arguments: { text: "again", verbatim: true, externalRef: "cc:s1:t1" } });
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain("duplicate_episode");
    await client.close();
  });

  it("list_facts, confirm_fact and dispute_fact work on a fact and audit through the shared handlers", async () => {
    const client = await connect(rwKey);
    const retained = await client.callTool({ name: "retain", arguments: { text: "I live in Lisbon", verbatim: true } });
    const episodeId = (retained.structuredContent as { episodeId: string }).episodeId;
    // Assert a fact through REST (MCP has no assert tool by design), then act on it through MCP.
    const res = await app.request(`/v1/banks/${bankA.id}/facts`, {
      method: "POST",
      headers: { authorization: `Bearer ${rwKey}`, "content-type": "application/json" },
      body: JSON.stringify({ statement: "The Subject lives in Lisbon", sourceEpisodeIds: [episodeId] }),
    });
    const fact = (await res.json()) as { id: string };

    const listed = await client.callTool({ name: "list_facts", arguments: {} });
    expect((listed.structuredContent as { facts: { id: string }[] }).facts.map((f) => f.id)).toEqual([fact.id]);
    expect(text(listed)).toContain("lives in Lisbon");

    const disputed = await client.callTool({ name: "dispute_fact", arguments: { factId: fact.id } });
    expect(text(disputed)).toContain("now disputed");
    const confirmed = await client.callTool({ name: "confirm_fact", arguments: { factId: fact.id } });
    expect(text(confirmed)).toContain("now confirmed");
    const missing = await client.callTool({ name: "confirm_fact", arguments: { factId: "nope" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("fact_not_found");

    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["episode.recorded", "fact.asserted", "facts.listed", "fact.disputed", "fact.confirmed"]);
    await client.close();
  });

  it("a paraphrase (verbatim=false) is stored as assistant context, never as the user's words", async () => {
    const client = await connect(rwKey);
    const r = await client.callTool({ name: "retain", arguments: { text: "User seems to prefer tabs", verbatim: false } });
    expect((r.structuredContent as { role: string }).role).toBe("assistant");
    expect(text(r)).toContain("no facts will be extracted");
    const { rows } = await db.pool.query<{ role: string }>("SELECT role FROM memory.episodes");
    expect(rows.map((x) => x.role)).toEqual(["assistant"]);
    await client.close();
  });

  it("transport edge cases: GET is 405, a notification is 202, protocol errors keep their JSON-RPC shape, exceptions are masked", async () => {
    const headers = { authorization: `Bearer ${rwKey}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await app.request(`/v1/banks/${bankA.id}/mcp`, { headers })).status).toBe(405);
    const notified = await app.request(`/v1/banks/${bankA.id}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notified.status).toBe(202);
    const badAccept = await app.request(`/v1/banks/${bankA.id}/mcp`, { method: "POST", headers: { ...headers, accept: "text/plain" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(badAccept.status).toBe(406);
    expect(((await badAccept.json()) as { jsonrpc: string }).jsonrpc).toBe("2.0");

    // A handler that throws must surface as a masked tool error, never as the raw message.
    const broken = createApp({
      scopes: new ScopeResolver(new PgPrincipalRepository(db.pool), new PgBankRepository(db.pool), systemClock),
      access: scopeAccessPolicy,
      audit: new PgAuditLog(db.pool),
      clock: systemClock,
      uow: new PgUnitOfWork(db.pool),
      banks: new PgBankRepository(db.pool),
      facts: new PgFactRepository(db.pool),
      episodes: new PgEpisodeRepository(db.pool),
      finder: { find: async () => { throw new Error("connection to host=db.internal failed"); } },
      exports: new PgExportStore(db.pool),
    });
    const transport = new StreamableHTTPClientTransport(new URL(`http://mem.test/v1/banks/${bankA.id}/mcp`), {
      fetch: async (url, init) => broken.request(url instanceof URL ? url.toString() : url, init),
      requestInit: { headers: { authorization: `Bearer ${rwKey}` } },
    });
    const client = new Client({ name: "t", version: "0" });
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    const r = await client.callTool({ name: "recall", arguments: { query: "x" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("internal");
    await client.close();
  });

  it("a principal granted on both banks cannot act on bank B's facts through bank A's MCP URL", async () => {
    const principals = new PgPrincipalRepository(db.pool);
    const both: Principal = { id: asPrincipalId("both"), tenantId: tenant, kind: "agent", displayName: "both", grants: [bankA.id, bankB.id].map((bankId) => ({ bankId, capabilities: new Set(["read", "write"] as const), grantedAt: new Date() })) };
    await principals.save(both);
    const k = generateApiKey();
    await new PgApiKeyStore(db.pool).issue(both.id, k.hash, "t");
    const clientB = await connect(k.token, bankB.id);
    const retained = await clientB.callTool({ name: "retain", arguments: { text: "bank B secret", verbatim: true } });
    const episodeId = (retained.structuredContent as { episodeId: string }).episodeId;
    const res = await app.request(`/v1/banks/${bankB.id}/facts`, { method: "POST", headers: { authorization: `Bearer ${k.token}`, "content-type": "application/json" }, body: JSON.stringify({ statement: "B fact", sourceEpisodeIds: [episodeId] }) });
    const factB = (await res.json()) as { id: string };
    await clientB.close();

    const clientA = await connect(k.token, bankA.id);
    const r = await clientA.callTool({ name: "confirm_fact", arguments: { factId: factB.id } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("fact_not_found");
    const listed = await clientA.callTool({ name: "list_facts", arguments: {} });
    expect((listed.structuredContent as { facts: unknown[] }).facts).toEqual([]);
    await clientA.close();
  });

  it("a read-only principal can recall but gets a tool error on retain, and the denial is audited", async () => {
    const client = await connect(roKey);
    const ok = await client.callTool({ name: "recall", arguments: { query: "anything" } });
    expect(ok.isError).toBeFalsy();
    const denied = await client.callTool({ name: "retain", arguments: { text: "nope", verbatim: true } });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("forbidden");
    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["recall.served", "access.denied"]);
    expect(audit[1]?.details["via"]).toBe("attachment");
    await client.close();
  });
});

import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asPrincipalId, systemClock } from "../../src/shared-kernel/index.js";
import { PgAuditLog, scopeAccessPolicy, verifyChain } from "../../src/governance/index.js";
import { PgBankRepository, PgFactRepository, PgUnitOfWork, supersede, invalidate, type Fact } from "../../src/memory/index.js";
import { ExportBankHandler, PgExportStore } from "../../src/portability/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, factFixture, scopeFor, tenant } from "../helpers/fixtures.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describeWithDb("ExportBankHandler (Postgres)", () => {
  let db: TestDb;
  const bank = bankFixture("bank-export", "vangelis");
  const other = { ...bankFixture("bank-other"), tenantId: "t2" as never };

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    const banks = new PgBankRepository(db.pool);
    await banks.create(bank);
    await banks.create(other);
    // One superseded chain and one retracted fact, written through the unit of work.
    await new PgUnitOfWork(db.pool).run(async (tx) => {
      const berlin = factFixture(bank.id, "f-berlin", "lives in Berlin", new Date("2026-01-10T00:00:00Z"));
      const lisbon: Fact = { ...factFixture(bank.id, "f-lisbon", "lives in Lisbon", new Date("2026-06-15T00:00:00Z")), predicate: { subject: "user", predicate: "lives_in", object: "Lisbon" } };
      const moved = supersede(berlin, lisbon);
      if (!moved.ok) throw new Error("fixture");
      await tx.facts.insert(berlin);
      await tx.facts.insert(moved.value.replacement);
      await tx.facts.update(moved.value.old);
      const wrong = invalidate(factFixture(bank.id, "f-wrong", "sky is green", new Date("2026-02-01T00:00:00Z")), "contradicted", new Date("2026-02-02T00:00:00Z"));
      if (!wrong.ok) throw new Error("fixture");
      await tx.facts.insert(wrong.value);
    });
  });

  const handler = () => new ExportBankHandler(new PgBankRepository(db.pool), new PgFactRepository(db.pool), scopeAccessPolicy, new PgExportStore(db.pool), new PgAuditLog(db.pool), systemClock);

  it("exports the whole bank, records the export and audits ids, counts and digest only", async () => {
    const r = await handler().handle(scopeFor(bank.id, ["read"]), { bankId: bank.id, format: "jsonl" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.contentType).toBe("application/x-ndjson; charset=utf-8");
    expect(r.value.factCount).toBe(2);
    expect(r.value.tombstoneCount).toBe(1);
    const lines = r.value.content.trim().split("\n").map((l) => JSON.parse(l) as { record: string; id?: string });
    expect(lines.map((l) => l.record)).toEqual(["header", "fact", "tombstone", "fact"]);
    expect(lines.map((l) => l.id)).toEqual([undefined, "f-berlin", "f-wrong", "f-lisbon"]);
    // jsonb reorders keys on the way in; the export must put them back in schema order.
    expect(r.value.content).toContain('"predicate":{"subject":"user","predicate":"lives_in","object":"Lisbon"},"topic":"Lives in"');

    const recorded = await new PgExportStore(db.pool).listByBank(scopeFor(bank.id));
    expect(await new PgExportStore(db.pool).listByBank({ ...scopeFor(bank.id), tenantId: "t2" as never })).toEqual([]);
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toMatchObject({ id: r.value.exportId, tenantId: tenant, bankId: bank.id, principalId: "alice", format: "jsonl", schemaVersion: "bank-export.v1", factCount: 2, tombstoneCount: 1, bytes: Buffer.byteLength(r.value.content), contentSha256: sha256(r.value.content) });

    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["export.produced"]);
    expect(audit[0]?.details).toEqual({ exportId: r.value.exportId, format: "jsonl", facts: 2, tombstones: 1, bytes: recorded[0]!.bytes, sha256: recorded[0]!.contentSha256 });
    expect(JSON.stringify(audit[0]?.details)).not.toContain("Berlin");
    expect(verifyChain(audit, sha256)).toBeUndefined();
  });

  it("renders every format; paste formats carry only current facts and are recorded too", async () => {
    const md = await handler().handle(scopeFor(bank.id), { bankId: bank.id, format: "markdown" });
    expect(md.ok && md.value.content).toContain("## Retracted");
    const claude = await handler().handle(scopeFor(bank.id), { bankId: bank.id, format: "claude-paste" });
    expect(claude.ok && claude.value.content).toBe("# Lives in\n[2026-06-15] - lives in Lisbon\n");
    const gemini = await handler().handle(scopeFor(bank.id), { bankId: bank.id, format: "gemini-paste" });
    expect(gemini.ok && gemini.value.content).toBe("lives in Lisbon\n");
    expect((await new PgExportStore(db.pool).listByBank(scopeFor(bank.id))).map((e) => e.format).sort()).toEqual(["claude-paste", "gemini-paste", "markdown"]);
  });

  it("requires read (write alone is not enough), denies other tenants' banks and reports unknown banks", async () => {
    const denied = await handler().handle(scopeFor(bank.id, ["write"]), { bankId: bank.id, format: "jsonl" });
    expect(!denied.ok && denied.error.kind).toBe("AccessDenied");
    const cross = await handler().handle({ ...scopeFor(other.id, ["admin"]), principalId: asPrincipalId("mallory") }, { bankId: other.id, format: "jsonl" });
    expect(!cross.ok && cross.error.kind).toBe("AccessDenied");
    const missing = await handler().handle(scopeFor("bank-ghost" as never, ["admin"]), { bankId: "bank-ghost" as never, format: "jsonl" });
    expect(!missing.ok && missing.error.kind).toBe("BankNotFound");
    expect(await new PgExportStore(db.pool).listByBank(scopeFor(bank.id))).toEqual([]);
    expect(await new PgAuditLog(db.pool).list(tenant)).toEqual([]);
  });
});

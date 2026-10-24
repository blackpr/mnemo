import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asBankId, asEpisodeId, asFactId, systemClock } from "../../src/shared-kernel/index.js";
import { PgAuditLog, scopeAccessPolicy } from "../../src/governance/index.js";
import {
  createBank,
  DuplicateEpisodeError,
  DuplicateFactError,
  PgBankRepository,
  PgEpisodeRepository,
  PgFactRepository,
  PgOutboxRelay,
  PgUnitOfWork,
  RecordEpisodeHandler,
  supersede,
  switchEngine,
} from "../../src/memory/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, episodeFixture, factFixture, scopeFor, tenant } from "../helpers/fixtures.js";

describeWithDb("Memory Postgres adapters", () => {
  let db: TestDb;
  const bankA = bankFixture("bank-a");
  const bankB = bankFixture("bank-b");

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    const banks = new PgBankRepository(db.pool);
    await banks.create(bankA);
    await banks.create(bankB);
  });

  it("round-trips a bank (engine included); create refuses duplicates; update changes status, policy and engine", async () => {
    const banks = new PgBankRepository(db.pool);
    expect(await banks.get(bankA.id)).toEqual(bankA);
    expect(bankA.engine).toBe("pgvector");
    await expect(banks.create(bankA)).rejects.toThrow();
    await banks.update({ ...bankA, status: "frozen" });
    expect((await banks.get(bankA.id))?.status).toBe("frozen");
    await banks.update(switchEngine({ ...bankA, status: "frozen" }, "honcho"));
    expect((await banks.get(bankA.id))).toMatchObject({ status: "frozen", engine: "honcho" });
    expect(createBank(asBankId("bank-h"), bankA.tenantId, bankA.subjectId, new Date(), {}, "hindsight").engine).toBe("hindsight");
    expect(() => switchEngine(bankA, "")).toThrow(/engine name/);
    await expect(db.pool.query("UPDATE memory.banks SET engine = '' WHERE id = $1", [bankA.id])).rejects.toThrow(/banks_engine_name/);
  });

  it("episodes are append-only: duplicates rejected, UPDATE refused by the database", async () => {
    const episodes = new PgEpisodeRepository(db.pool);
    await episodes.append(episodeFixture(bankA.id, "ep-1", "I switched to neovim", undefined, "src:1"));
    await expect(episodes.append(episodeFixture(bankA.id, "ep-1", "again", undefined, "src:2"))).rejects.toBeInstanceOf(DuplicateEpisodeError);
    await expect(episodes.append(episodeFixture(bankA.id, "ep-2", "again", undefined, "src:1"))).rejects.toBeInstanceOf(DuplicateEpisodeError);
    await expect(db.pool.query("UPDATE memory.episodes SET text = 'tampered' WHERE id = 'ep-1'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("DELETE FROM memory.episodes WHERE id = 'ep-1'")).rejects.toThrow(/erasure/);
  });

  it("episode reads are scoped to the bank", async () => {
    const episodes = new PgEpisodeRepository(db.pool);
    await episodes.append(episodeFixture(bankA.id, "ep-1", "secret of A"));
    expect(await episodes.get(scopeFor(bankA.id), asEpisodeId("ep-1"))).toBeDefined();
    expect(await episodes.get(scopeFor(bankB.id), asEpisodeId("ep-1"))).toBeUndefined();
    expect(await episodes.getMany(scopeFor(bankB.id), [asEpisodeId("ep-1")])).toEqual([]);
    expect(await episodes.listByBank(scopeFor(bankB.id))).toHaveLength(0);
  });

  it("facts: insert, duplicate, scoped get, getMany, listCurrent with bi-temporal supersession", async () => {
    const facts = new PgFactRepository(db.pool);
    const t0 = new Date("2026-01-10T00:00:00Z");
    const t1 = new Date("2026-06-10T00:00:00Z");
    const a = factFixture(bankA.id, "f-a", "editor is vscode", t0);
    const b = factFixture(bankA.id, "f-b", "editor is neovim", t1);
    await facts.insert(a);
    await facts.insert(b);
    await expect(facts.insert(a)).rejects.toBeInstanceOf(DuplicateFactError);

    expect(await facts.get(scopeFor(bankB.id), asFactId("f-a"))).toBeUndefined();
    expect((await facts.getMany(scopeFor(bankA.id), [asFactId("f-a"), asFactId("f-b"), asFactId("nope")])).map((f) => f.id).sort()).toEqual(["f-a", "f-b"]);

    const s = supersede(a, b);
    if (!s.ok) throw new Error("supersede failed");
    await facts.update(s.value.old);
    await facts.update(s.value.replacement);

    const current = await facts.listCurrent(scopeFor(bankA.id), new Date("2026-10-01T00:00:00Z"));
    expect(current.map((f) => f.id)).toEqual(["f-b"]);

    const oldRow = await facts.get(scopeFor(bankA.id), asFactId("f-a"));
    expect(oldRow?.validity.validTo).toEqual(t1);
    expect(oldRow?.transaction.retractedAt).toBeUndefined();
    expect(oldRow?.supersededBy).toBe("f-b");
    // Point in time: in March the old fact was current.
    expect((await facts.listCurrent(scopeFor(bankA.id), new Date("2026-03-01T00:00:00Z"))).map((f) => f.id)).toEqual(["f-a"]);
    expect((await facts.get(scopeFor(bankA.id), asFactId("f-b")))?.supersedes).toBe("f-a");

    await expect(db.pool.query("DELETE FROM memory.facts WHERE id = 'f-a'")).rejects.toThrow(/erasure/);
  });

  it("database rejects a fact without provenance even if the domain layer were bypassed", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO memory.facts (id, bank_id, statement, valid_from, recorded_at, provenance)
         VALUES ('bad', $1, 'x', now(), now(), '{"sourceEpisodeIds": [], "writerPrincipalId": "p", "confirmation": "asserted"}')`,
        [bankA.id],
      ),
    ).rejects.toThrow();
  });

  it("RecordEpisode writes episode, outbox event and audit entry in one transaction; relay delivers once", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    const r = await handler.handle(scopeFor(bankA.id), {
      id: asEpisodeId("ep-9"),
      bankId: bankA.id,
      kind: "conversation_turn",
      source: "claude-code",
      role: "user",
      text: "we picked postgres for the memory layer",
      occurredAt: new Date("2026-10-23T10:00:00Z"),
    });
    expect(r.ok).toBe(true);
    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.map((a) => a.action)).toEqual(["episode.recorded"]);

    const relay = new PgOutboxRelay(db.pool, { backoffMs: () => 0 });
    expect(await relay.pendingCount()).toBe(1);

    // Failing handler: the event stays pending, attempts bumped, nothing dead-lettered yet.
    const first = await relay.drainOnce(async () => {
      throw new Error("consumer down");
    });
    expect(first).toEqual({ delivered: 0, failed: 1, seen: 1 });
    expect(await relay.pendingCount()).toBe(1);

    const seen: string[] = [];
    const delivered = await relay.drainAll(async (events) => {
      for (const e of events) seen.push(`${e.type}:${JSON.stringify(e.payload)}`);
    });
    expect(delivered).toBe(1);
    expect(seen).toEqual([`memory.EpisodeRecorded:{"source":"claude-code","episodeId":"ep-9"}`]);
    expect(await relay.pendingCount()).toBe(0);
    expect(await relay.drainAll(async () => {})).toBe(0);
  });

  it("one poison event is dead-lettered after maxAttempts and does not block the others", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    for (const id of ["poison", "good-1", "good-2"]) {
      await handler.handle(scopeFor(bankA.id), { id: asEpisodeId(id), bankId: bankA.id, kind: "system_note", source: "t", text: id, occurredAt: new Date() });
    }
    const relay = new PgOutboxRelay(db.pool, { maxAttempts: 2, backoffMs: () => 0 });
    const consumer = async (events: readonly { payload: unknown }[]) => {
      for (const e of events) if ((e.payload as { episodeId: string }).episodeId === "poison") throw new Error("embedder exploded");
    };
    expect(await relay.drainOnce(consumer)).toEqual({ delivered: 2, failed: 1, seen: 3 });
    expect(await relay.pendingCount()).toBe(1);
    expect(await relay.deadLetterCount()).toBe(0);
    expect(await relay.drainOnce(consumer)).toEqual({ delivered: 0, failed: 1, seen: 1 });
    expect(await relay.pendingCount()).toBe(0);
    expect(await relay.deadLetterCount()).toBe(1);
    const { rows } = await db.pool.query<{ last_error: string; attempts: number }>("SELECT last_error, attempts FROM memory.outbox WHERE failed_at IS NOT NULL");
    expect(rows[0]?.attempts).toBe(2);
    expect(rows[0]?.last_error).toContain("embedder exploded");
    expect(await relay.requeueDeadLetters()).toBe(1);
    expect(await relay.pendingCount()).toBe(1);
  });

  it("a failed event backs off: pending but not due until next_attempt_at", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    await handler.handle(scopeFor(bankA.id), { id: asEpisodeId("flaky"), bankId: bankA.id, kind: "system_note", source: "t", text: "x", occurredAt: new Date() });
    const relay = new PgOutboxRelay(db.pool, { backoffMs: () => 60_000 });
    const failing = async () => {
      throw new Error("transient");
    };
    expect(await relay.drainOnce(failing)).toEqual({ delivered: 0, failed: 1, seen: 1 });
    expect(await relay.pendingCount()).toBe(1);
    expect(await relay.drainOnce(failing)).toEqual({ delivered: 0, failed: 0, seen: 0 });
    expect(await relay.deadLetterCount()).toBe(0);
    await db.pool.query("UPDATE memory.outbox SET next_attempt_at = now()");
    expect(await relay.drainAll(async () => {})).toBe(1);
  });

  it("duplicate externalRef comes back as a Result, and nothing else is written", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    const input = { bankId: bankA.id, kind: "system_note" as const, source: "t", text: "x", occurredAt: new Date(), externalRef: "ref:1" };
    expect((await handler.handle(scopeFor(bankA.id), { ...input, id: asEpisodeId("e1") })).ok).toBe(true);
    const dup = await handler.handle(scopeFor(bankA.id), { ...input, id: asEpisodeId("e2") });
    expect(dup).toEqual({ ok: false, error: { kind: "DuplicateEpisode", episodeId: "e2" } });
    expect(await new PgOutboxRelay(db.pool).pendingCount()).toBe(1);
    expect((await new PgAuditLog(db.pool).list(tenant)).length).toBe(1);
  });

  it("RecordEpisode is denied without write capability and writes nothing", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    const r = await handler.handle(scopeFor(bankA.id, ["read"]), {
      id: asEpisodeId("ep-denied"),
      bankId: bankA.id,
      kind: "conversation_turn",
      source: "test",
      text: "should not land",
      occurredAt: new Date(),
    });
    expect(r.ok).toBe(false);
    expect(await new PgOutboxRelay(db.pool).pendingCount()).toBe(0);
    expect(await new PgEpisodeRepository(db.pool).listByBank(scopeFor(bankA.id))).toHaveLength(0);
  });

  it("a principal from another tenant is denied on a bank even with a (mis)granted scope", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    const foreign = { ...scopeFor(bankA.id), tenantId: "other-tenant" as typeof tenant };
    const r = await handler.handle(foreign, { id: asEpisodeId("x"), bankId: bankA.id, kind: "system_note", source: "t", text: "x", occurredAt: new Date() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("AccessDenied");
  });

  it("unit of work rolls back everything when work throws", async () => {
    const uow = new PgUnitOfWork(db.pool);
    await expect(
      uow.run(async (tx) => {
        await tx.episodes.append(episodeFixture(bankA.id, "ep-rb", "rolled back"));
        await tx.outbox.publish([{ type: "x", occurredAt: new Date(), tenantId: bankA.tenantId, bankId: bankA.id, payload: {} }]);
        await tx.audit.append({ tenantId: tenant, bankId: bankA.id, principalId: "p" as never, action: "episode.recorded", details: {}, at: new Date() });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await new PgEpisodeRepository(db.pool).get(scopeFor(bankA.id), asEpisodeId("ep-rb"))).toBeUndefined();
    expect(await new PgOutboxRelay(db.pool).pendingCount()).toBe(0);
    expect(await new PgAuditLog(db.pool).list(tenant)).toEqual([]);
  });

  it("unknown bank is reported, not swallowed", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    const ghost = asBankId("ghost");
    const r = await handler.handle(scopeFor(ghost), { id: asEpisodeId("e"), bankId: ghost, kind: "system_note", source: "t", text: "x", occurredAt: new Date() });
    expect(r).toEqual({ ok: false, error: { kind: "BankNotFound" } });
  });
});

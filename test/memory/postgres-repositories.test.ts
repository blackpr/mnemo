import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { asBankId, asEpisodeId, asFactId, systemClock } from "../../src/shared-kernel/index.js";
import { scopeAccessPolicy } from "../../src/governance/index.js";
import {
  DuplicateEpisodeError,
  PgBankRepository,
  PgEpisodeRepository,
  PgFactRepository,
  PgOutboxRelay,
  PgUnitOfWork,
  RecordEpisodeHandler,
  supersede,
} from "../../src/memory/index.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, episodeFixture, factFixture, scopeFor } from "../helpers/fixtures.js";

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
    await banks.save(bankA);
    await banks.save(bankB);
  });

  it("round-trips a bank", async () => {
    const banks = new PgBankRepository(db.pool);
    const got = await banks.get(bankA.id);
    expect(got).toEqual(bankA);
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
    expect(await episodes.listByBank(scopeFor(bankB.id))).toHaveLength(0);
  });

  it("facts: insert, scoped get, getMany, listCurrent with bi-temporal supersession", async () => {
    const facts = new PgFactRepository(db.pool);
    const t0 = new Date("2026-01-10T00:00:00Z");
    const t1 = new Date("2026-06-10T00:00:00Z");
    const a = factFixture(bankA.id, "f-a", "editor is vscode", t0);
    const b = factFixture(bankA.id, "f-b", "editor is neovim", t1);
    await facts.insert(a);
    await facts.insert(b);

    expect(await facts.get(scopeFor(bankB.id), asFactId("f-a"))).toBeUndefined();
    expect((await facts.getMany(scopeFor(bankA.id), [asFactId("f-a"), asFactId("f-b"), asFactId("nope")])).map((f) => f.id).sort()).toEqual(["f-a", "f-b"]);

    const s = supersede(a, b, t1);
    if (!s.ok) throw new Error("supersede failed");
    await facts.update(s.value.old);
    await facts.update(s.value.replacement);

    const current = await facts.listCurrent(scopeFor(bankA.id), new Date("2026-10-01T00:00:00Z"));
    expect(current.map((f) => f.id)).toEqual(["f-b"]);

    const oldRow = await facts.get(scopeFor(bankA.id), asFactId("f-a"));
    expect(oldRow?.validity.validTo).toEqual(t1);
    expect(oldRow?.transaction.retractedAt).toEqual(t1);
    expect(oldRow?.supersededBy).toBe("f-b");
    expect(oldRow?.invalidation?.reason).toBe("superseded");
    expect(oldRow?.invalidation?.at).toEqual(t1);
    const newRow = await facts.get(scopeFor(bankA.id), asFactId("f-b"));
    expect(newRow?.supersedes).toBe("f-a");

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

  it("RecordEpisode writes the episode and the outbox event in one transaction; relay delivers once", async () => {
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

    const relay = new PgOutboxRelay(db.pool);
    expect(await relay.pendingCount()).toBe(1);

    const seen: string[] = [];
    // First handler fails: batch must stay unpublished.
    await expect(relay.drainOnce(async () => { throw new Error("consumer down"); })).rejects.toThrow("consumer down");
    expect(await relay.pendingCount()).toBe(1);

    const delivered = await relay.drainAll(async (events) => { for (const e of events) seen.push(`${e.type}:${JSON.stringify(e.payload)}`); });
    expect(delivered).toBe(1);
    expect(seen).toEqual([`memory.EpisodeRecorded:{"source":"claude-code","episodeId":"ep-9"}`]);
    expect(await relay.pendingCount()).toBe(0);
    expect(await relay.drainAll(async () => {})).toBe(0);
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

  it("unit of work rolls back everything when work throws", async () => {
    const uow = new PgUnitOfWork(db.pool);
    await expect(
      uow.run(async (tx) => {
        await tx.episodes.append(episodeFixture(bankA.id, "ep-rb", "rolled back"));
        await tx.outbox.publish([{ type: "x", occurredAt: new Date(), tenantId: bankA.tenantId, bankId: bankA.id, payload: {} }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await new PgEpisodeRepository(db.pool).get(scopeFor(bankA.id), asEpisodeId("ep-rb"))).toBeUndefined();
    expect(await new PgOutboxRelay(db.pool).pendingCount()).toBe(0);
  });

  it("unknown bank is reported, not swallowed", async () => {
    const handler = new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock);
    const ghost = asBankId("ghost");
    const r = await handler.handle(scopeFor(ghost), { id: asEpisodeId("e"), bankId: ghost, kind: "system_note", source: "t", text: "x", occurredAt: new Date() });
    expect(r).toEqual({ ok: false, error: { kind: "BankNotFound" } });
  });
});

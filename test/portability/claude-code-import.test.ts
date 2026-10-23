import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/shared-kernel/index.js";
import { PgAuditLog, scopeAccessPolicy } from "../../src/governance/index.js";
import { PgBankRepository, PgEpisodeRepository, PgUnitOfWork, RecordEpisodeHandler } from "../../src/memory/index.js";
import { externalRefFor, ImportDocumentsHandler, readClaudeCodeMemory, toNewEpisode } from "../../src/portability/index.js";
import { classify, frontmatterDate, parseFrontmatter } from "../../src/portability/infrastructure/claude-code/memory-dir-reader.js";
import { describeWithDb, setupTestDb, type TestDb } from "../helpers/postgres.js";
import { bankFixture, scopeFor, tenant } from "../helpers/fixtures.js";

const memoryFile = (modified: string, body: string) => `---\nname: compact-context\ndescription: "User expects proactive compaction"\nmetadata:\n  type: feedback\n  modified: ${modified}\n---\n\n${body}\n`;

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mem-claude-code-"));
  await mkdir(join(root, "projects", "p1", "memory"), { recursive: true });
  await mkdir(join(root, "repo", ".claude"), { recursive: true });
  await mkdir(join(root, "repo", "node_modules", "pkg", "memory"), { recursive: true });
  await mkdir(join(root, "repo", "src", "memory"), { recursive: true });
  await mkdir(join(root, "repo", ".git"), { recursive: true });
  await writeFile(join(root, "projects", "p1", "memory", "compact-context.md"), memoryFile("2026-07-30T08:26:00.684Z", "Compact before running out of context."));
  await writeFile(join(root, "projects", "p1", "memory", "broken-frontmatter.md"), "---\nname: [unclosed\n---\nStill worth importing.\n");
  await writeFile(join(root, "projects", "p1", "memory", "MEMORY.md"), "- [Compact context](compact-context.md) - compact proactively\n");
  await writeFile(join(root, "projects", "p1", "memory", "empty.md"), "   \n");
  await writeFile(join(root, "projects", "p1", "memory", "notes.txt"), "not markdown");
  await writeFile(join(root, "repo", "CLAUDE.md"), "# Project\nUse pnpm.\n");
  await writeFile(join(root, "repo", ".claude", "CLAUDE.local.md"), "Local overrides.\n");
  await writeFile(join(root, "repo", "README.md"), "# Not imported\n");
  await writeFile(join(root, "repo", "node_modules", "pkg", "memory", "decoy.md"), "---\nname: decoy\n---\nnever\n");
  await writeFile(join(root, "repo", "src", "memory", "README.md"), "# Memory context of some repo\n");
  await writeFile(join(root, "repo", ".git", "CLAUDE.md"), "never\n");
  await writeFile(join(root, "projects", "p1", "memory", "evil.md"), "---js\n{ pwned: (globalThis.__memPwned = true, 'yes') }\n---\nbody\n");
  const mtime = new Date("2026-05-05T05:05:05Z");
  await utimes(join(root, "repo", "CLAUDE.md"), mtime, mtime);
  return root;
}

describe("Claude Code memory reader", () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTree();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("classifies by name and location; a memory dir counts only as the root or under projects/<p>", () => {
    expect(classify("/h/.claude/projects/p/memory/foo.md", "/h/.claude")).toBe("memory");
    expect(classify("/h/.claude/projects/p/memory/foo.md", "/h/.claude/projects/p/memory")).toBe("memory");
    expect(classify("/repo/src/memory/README.md", "/repo")).toBeUndefined();
    expect(classify("/repo/memory/foo.md", "/repo/memory/")).toBe("memory");
    expect(classify("/repo/memory/foo.md", "/repo/memory/../memory")).toBe("memory");
    expect(classify("/x/memory/MEMORY.md", "/x")).toBe("index");
    expect(classify("/x/CLAUDE.md", "/x")).toBe("claude-md");
    expect(classify("/x/.claude/CLAUDE.local.md", "/x")).toBe("claude-md");
    expect(classify("/x/notes/foo.md", "/x")).toBeUndefined();
    expect(classify("/x/memory/foo.txt", "/x")).toBeUndefined();
  });

  it("never evaluates JavaScript frontmatter; such a file is imported whole", async () => {
    const docs = await readClaudeCodeMemory(root);
    const evil = docs.find((d) => d.path.endsWith("evil.md"))!;
    expect((globalThis as { __memPwned?: boolean }).__memPwned).toBeUndefined();
    expect(evil.frontmatter).toEqual({});
    expect(evil.body).toBe(evil.raw);
    expect(parseFrontmatter("---js\n{ a: (globalThis.__memPwned2 = true, 1) }\n---\nx")).toEqual({ frontmatter: {}, body: "---js\n{ a: (globalThis.__memPwned2 = true, 1) }\n---\nx" });
    expect((globalThis as { __memPwned2?: boolean }).__memPwned2).toBeUndefined();
    expect(parseFrontmatter("---constructor\nx\n---\nbody").frontmatter).toEqual({});
  });

  it("reading the memory directory itself works too", async () => {
    const docs = await readClaudeCodeMemory(join(root, "projects", "p1", "memory"));
    expect(docs.map((d) => d.kind)).toEqual(["index", "memory", "memory", "memory"]);
  });

  it("reads memory files, the index and the CLAUDE.md hierarchy; skips node_modules, non-matching and empty files; sorted by path", async () => {
    const docs = await readClaudeCodeMemory(root);
    expect(docs.map((d) => [d.path.slice(root.length), d.kind])).toEqual([
      ["/projects/p1/memory/MEMORY.md", "index"],
      ["/projects/p1/memory/broken-frontmatter.md", "memory"],
      ["/projects/p1/memory/compact-context.md", "memory"],
      ["/projects/p1/memory/evil.md", "memory"],
      ["/repo/.claude/CLAUDE.local.md", "claude-md"],
      ["/repo/CLAUDE.md", "claude-md"],
    ]);
    const compact = docs.find((d) => d.path.endsWith("compact-context.md"))!;
    expect(compact.frontmatter["name"]).toBe("compact-context");
    expect(compact.body.trim()).toBe("Compact before running out of context.");
    expect(compact.raw.startsWith("---\nname:")).toBe(true);
    expect(compact.modifiedAt.toISOString()).toBe("2026-07-30T08:26:00.684Z");
    const claudeMd = docs.find((d) => d.path.endsWith("/repo/CLAUDE.md"))!;
    expect(claudeMd.modifiedAt.toISOString()).toBe("2026-05-05T05:05:05.000Z");
    const broken = docs.find((d) => d.path.endsWith("broken-frontmatter.md"))!;
    expect(broken.frontmatter).toEqual({});
    expect(broken.body).toBe(broken.raw);
  });

  it("rejects a path that is not a directory", async () => {
    await expect(readClaudeCodeMemory(join(root, "repo", "CLAUDE.md"))).rejects.toThrow(/not a directory/);
  });

  it("frontmatter dates: top-level or metadata.modified, Date or string, invalid ignored", () => {
    expect(frontmatterDate({ modified: "2026-01-01T00:00:00Z" })?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(frontmatterDate({ metadata: { modified: new Date("2026-02-02T00:00:00Z") } })?.toISOString()).toBe("2026-02-02T00:00:00.000Z");
    expect(frontmatterDate({ modified: "yesterday" })).toBeUndefined();
    expect(frontmatterDate({})).toBeUndefined();
    expect(parseFrontmatter("no frontmatter here")).toEqual({ frontmatter: {}, body: "no frontmatter here" });
  });

  it("externalRef is path plus content digest: stable for the same content, new for edits", () => {
    const a = externalRefFor({ path: "/p/memory/a.md", raw: "one" });
    expect(a).toBe(externalRefFor({ path: "/p/memory/a.md", raw: "one" }));
    expect(a).toMatch(/^claude-code-memory:\/p\/memory\/a\.md@[0-9a-f]{16}$/);
    expect(a).not.toBe(externalRefFor({ path: "/p/memory/a.md", raw: "two" }));
    expect(a).not.toBe(externalRefFor({ path: "/q/memory/a.md", raw: "one" }));
  });

  it("maps a document to an imported_document episode that keeps the raw text", () => {
    const doc = { path: "/p/memory/a.md", kind: "memory" as const, frontmatter: { name: "a" }, body: "body", raw: "---\nname: a\n---\nbody", modifiedAt: new Date("2026-03-03T00:00:00Z") };
    const bank = bankFixture("bank-i");
    const episode = toNewEpisode(doc, bank.id, "ep-1" as never);
    expect(episode).toEqual({ id: "ep-1", bankId: bank.id, kind: "imported_document", source: "claude-code-memory", text: doc.raw, occurredAt: doc.modifiedAt, externalRef: externalRefFor(doc) });
  });
});

describeWithDb("ImportDocumentsHandler (Postgres)", () => {
  let db: TestDb;
  let root: string;
  const bank = bankFixture("bank-import");
  const scope = scopeFor(bank.id);

  beforeAll(async () => {
    db = await setupTestDb();
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.truncateAll();
    await new PgBankRepository(db.pool).create(bank);
    root = await makeTree();
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const handler = () => new ImportDocumentsHandler(new RecordEpisodeHandler(new PgUnitOfWork(db.pool), scopeAccessPolicy, systemClock));

  it("imports every document as an episode once; re-import skips; an edit imports a new version", async () => {
    const docs = await readClaudeCodeMemory(root);
    const first = await handler().handle(scope, bank.id, docs);
    expect(first.ok && first.value.imported.length).toBe(6);
    expect(first.ok && first.value.skipped).toEqual([]);

    const episodes = await new PgEpisodeRepository(db.pool).listByBank(scope);
    expect(episodes.length).toBe(6);
    expect(new Set(episodes.map((e) => e.kind))).toEqual(new Set(["imported_document"]));
    expect(new Set(episodes.map((e) => e.source))).toEqual(new Set(["claude-code-memory"]));
    const compact = episodes.find((e) => e.externalRef?.includes("compact-context.md"))!;
    expect(compact.occurredAt.toISOString()).toBe("2026-07-30T08:26:00.684Z");
    expect(compact.text).toContain("Compact before running out of context.");
    expect(compact.role).toBeUndefined();

    const again = await handler().handle(scope, bank.id, await readClaudeCodeMemory(root));
    expect(again.ok && again.value.imported).toEqual([]);
    expect(again.ok && again.value.skipped.length).toBe(6);
    expect(again.ok && again.value.skipped.map((s) => s.externalRef)).toContain(compact.externalRef);

    await writeFile(join(root, "repo", "CLAUDE.md"), "# Project\nUse npm now.\n");
    const third = await handler().handle(scope, bank.id, await readClaudeCodeMemory(root));
    expect(third.ok && third.value.imported.map((i) => i.path.slice(root.length))).toEqual(["/repo/CLAUDE.md"]);
    expect(third.ok && third.value.skipped.length).toBe(5);
    expect((await new PgEpisodeRepository(db.pool).listByBank(scope)).length).toBe(7);

    // Audited and published like any retain: one entry and one outbox event per imported episode, no facts.
    const audit = await new PgAuditLog(db.pool).list(tenant);
    expect(audit.filter((a) => a.action === "episode.recorded").length).toBe(7);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM memory.outbox")).rows[0].n).toBe(7);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM memory.facts")).rows[0].n).toBe(0);
  });

  it("stops at the first non-duplicate error and names the document", async () => {
    const docs = await readClaudeCodeMemory(root);
    const r = await handler().handle(scopeFor(bank.id, ["read"]), bank.id, docs);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error.kind).toBe("AccessDenied");
    expect(r.error.path).toBe(docs[0]!.path);
    expect((await new PgEpisodeRepository(db.pool).listByBank(scope)).length).toBe(0);
  });
});

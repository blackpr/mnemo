import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import matter from "gray-matter";
import type { ImportedDocument, ImportedDocumentKind } from "../../domain/imported-document.js";

/**
 * Reads a Claude Code memory tree. Point it at any of:
 *   ~/.claude/projects/<project>/memory   (one project's auto-memory files and MEMORY.md index)
 *   ~/.claude/projects                     (every project)
 *   a repository root                      (its CLAUDE.md hierarchy: CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, nested ones)
 * Only three kinds of file are taken; everything else (READMEs, notes) is ignored on purpose:
 *   memory    *.md directly inside a `memory` directory that is the root itself or sits at
 *             `projects/<project>/memory` (so a repository's own `src/memory/README.md` is not one)
 *   index     MEMORY.md
 *   claude-md CLAUDE.md or CLAUDE.local.md
 * Frontmatter is parsed with gray-matter restricted to YAML and JSON: its default engine table
 * also has a `javascript` engine that evals `---js` blocks, which would let an imported file run
 * code in the admin process. A file whose frontmatter does not parse is still imported, with the
 * whole text as body. Results are sorted by path so imports are deterministic.
 */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist"]);

const refuse = (lang: string) => ({
  parse: (): never => {
    throw new Error(`${lang} frontmatter is not allowed`);
  },
});
/** Passing options also bypasses gray-matter's process-lifetime cache keyed by file content. */
const MATTER_OPTIONS = { language: "yaml", engines: { javascript: refuse("javascript"), js: refuse("javascript"), coffee: refuse("coffee"), coffeescript: refuse("coffee") } };

export interface ReadOptions {
  /** Directory names never descended into. */
  readonly skipDirs?: ReadonlySet<string>;
}

export function classify(path: string, root: string): ImportedDocumentKind | undefined {
  const name = basename(path);
  if (name === "MEMORY.md") return "index";
  if (name === "CLAUDE.md" || name === "CLAUDE.local.md") return "claude-md";
  const dir = resolve(dirname(path));
  if (name.endsWith(".md") && basename(dir) === "memory" && (dir === resolve(root) || basename(dirname(dirname(dir))) === "projects")) return "memory";
  return undefined;
}

export async function readClaudeCodeMemory(dir: string, opts: ReadOptions = {}): Promise<readonly ImportedDocument[]> {
  const root = resolve(dir);
  const skip = opts.skipDirs ?? SKIPPED_DIRS;
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory`);

  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const paths = entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .filter((p) => !p.slice(root.length).split(/[\\/]/).some((seg) => skip.has(seg)))
    .filter((p) => classify(p, root) !== undefined)
    .sort();

  const docs: ImportedDocument[] = [];
  for (const path of paths) {
    const doc = await readDocument(path, root);
    if (doc) docs.push(doc);
  }
  return docs;
}

export async function readDocument(path: string, root: string): Promise<ImportedDocument | undefined> {
  const kind = classify(path, root);
  if (!kind) return undefined;
  const raw = await readFile(path, "utf8");
  if (raw.trim().length === 0) return undefined;
  const { frontmatter, body } = parseFrontmatter(raw);
  const modifiedAt = frontmatterDate(frontmatter) ?? (await stat(path)).mtime;
  return { path, kind, frontmatter, body, raw, modifiedAt };
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  try {
    const parsed = matter(raw, MATTER_OPTIONS);
    const data: unknown = parsed.data;
    const plain = typeof data === "object" && data !== null && (Object.getPrototypeOf(data) === Object.prototype || Object.getPrototypeOf(data) === null);
    return { frontmatter: plain ? (data as Record<string, unknown>) : {}, body: parsed.content };
  } catch {
    return { frontmatter: {}, body: raw };
  }
}

/** `modified` at the top level or under `metadata` (where Claude Code's auto-memory puts it). Must parse as a date. */
export function frontmatterDate(fm: Readonly<Record<string, unknown>>): Date | undefined {
  const metadata = fm["metadata"];
  const candidates = [fm["modified"], typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>)["modified"] : undefined];
  for (const c of candidates) {
    if (c instanceof Date && !Number.isNaN(c.getTime())) return c;
    if (typeof c === "string") {
      const d = new Date(c);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return undefined;
}

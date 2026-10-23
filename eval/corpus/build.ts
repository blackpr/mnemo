/**
 * Builds the eval corpus from the local Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl`).
 * Output (gitignored): `eval/corpus/normalized/<conversationId>.jsonl`, one turn per line, and
 * `eval/corpus/index.json` with per-conversation sizes. Prints corpus statistics only, never text.
 *
 *   npm run eval:build-corpus
 *
 * Env: EVAL_CORPUS_SOURCE (default ~/.claude/projects), EVAL_CORPUS_EXCLUDE (comma-separated project
 * slugs to skip, in addition to this repository's own sessions, so the eval does not study itself).
 * Sessions shorter than MIN_TURNS turns / MIN_USER_TURNS user turns / MIN_TOKENS tokens are skipped.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { approxTokens, normalizeTranscript } from "./normalize.js";
import { CORPUS_DIR, INDEX_PATH, type CorpusEntry, type CorpusIndex } from "./store.js";

const MIN_TURNS = 6;
const MIN_USER_TURNS = 3;
const MIN_TOKENS = 1_000;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Claude Code names a project folder after its absolute path with every non-alphanumeric character turned into "-". */
function projectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9-]/g, "-");
}

async function main(): Promise<void> {
  const source = process.env.EVAL_CORPUS_SOURCE ?? path.join(homedir(), ".claude", "projects");
  const excluded = new Set([projectSlug(REPO_ROOT), ...(process.env.EVAL_CORPUS_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);

  const projects = (await readdir(source, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const skippedProjects = projects.filter((p) => excluded.has(p));
  await rm(CORPUS_DIR, { recursive: true, force: true });
  await mkdir(CORPUS_DIR, { recursive: true });

  const index: CorpusEntry[] = [];
  const dropped: Record<string, number> = {};
  let files = 0;
  let tooSmall = 0;
  let totalTurns = 0;
  let userTurns = 0;
  let totalTokens = 0;
  let redactedLines = 0;
  let truncatedTurns = 0;
  const ids = new Set<string>();

  for (const project of projects) {
    if (excluded.has(project)) continue;
    const dir = path.join(source, project);
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      if (!(await stat(file)).isFile()) continue;
      files++;
      const conversationId = name.slice(0, -".jsonl".length);
      if (ids.has(conversationId)) throw new Error(`duplicate session id ${conversationId} across projects`);
      const result = normalizeTranscript(conversationId, (await readFile(file, "utf8")).split("\n"));
      for (const [k, v] of Object.entries(result.dropped)) dropped[k] = (dropped[k] ?? 0) + v;
      const tokens = result.turns.reduce((n, t) => n + approxTokens(t.text), 0);
      const users = result.turns.filter((t) => t.role === "user").length;
      const first = result.turns[0];
      const last = result.turns[result.turns.length - 1];
      if (!first || !last || result.turns.length < MIN_TURNS || users < MIN_USER_TURNS || tokens < MIN_TOKENS) {
        tooSmall++;
        continue;
      }
      ids.add(conversationId);
      await writeFile(path.join(CORPUS_DIR, `${conversationId}.jsonl`), result.turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
      index.push({
        conversationId,
        project: project.split("-").filter(Boolean).pop() ?? project,
        turns: result.turns.length,
        userTurns: users,
        approxTokens: tokens,
        startedAt: first.occurredAt,
        endedAt: last.occurredAt,
        redactedLines: result.redactedLines,
        truncatedTurns: result.truncatedTurns,
      });
      totalTurns += result.turns.length;
      userTurns += users;
      totalTokens += tokens;
      redactedLines += result.redactedLines;
      truncatedTurns += result.truncatedTurns;
    }
  }
  index.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.conversationId.localeCompare(b.conversationId));
  const out: CorpusIndex = { builtAt: new Date().toISOString(), source: "claude-code", conversations: index };
  await writeFile(INDEX_PATH, JSON.stringify(out, null, 2) + "\n");

  const dates = index.map((e) => e.startedAt).sort();
  const sizes = index.map((e) => e.approxTokens).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  console.log(`Corpus built from ${files} session file(s) in ${projects.length - skippedProjects.length} project folder(s); ${skippedProjects.length} folder(s) excluded.`);
  console.log(`Kept ${index.length} conversation(s) (${tooSmall} too small): ${totalTurns} turns (${userTurns} user, ${totalTurns - userTurns} assistant), about ${totalTokens.toLocaleString()} tokens; median conversation about ${median.toLocaleString()} tokens, largest ${(sizes[sizes.length - 1] ?? 0).toLocaleString()}.`);
  console.log(`Date span: ${dates[0]?.slice(0, 10) ?? "n/a"} to ${dates[dates.length - 1]?.slice(0, 10) ?? "n/a"}. Redacted ${redactedLines} line(s), truncated ${truncatedTurns} turn(s).`);
  console.log(`Dropped lines by reason: ${JSON.stringify(dropped)}`);
  console.log(`Written: ${CORPUS_DIR} and ${INDEX_PATH}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

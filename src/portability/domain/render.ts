import type { Fact } from "../../memory/index.js";
import { isCurrent } from "../../memory/index.js";
import { compareFacts, GENERAL_TOPIC, topicOf, type BankExport, type ExportFact, type ExportTombstone } from "./bank-export.js";

/**
 * Renderers: pure functions from a BankExport (or current Facts) to text. All deterministic:
 * same input, same bytes. Topics are sorted alphabetically with "General" last.
 */

export type ExportFormat = "jsonl" | "markdown" | "claude-paste" | "gemini-paste";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["jsonl", "markdown", "claude-paste", "gemini-paste"];

export const contentTypeOf = (format: ExportFormat): string =>
  format === "jsonl" ? "application/x-ndjson; charset=utf-8" : format === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";

export const fileExtensionOf = (format: ExportFormat): string => (format === "jsonl" ? "jsonl" : format === "markdown" ? "md" : "txt");

/** One JSON object per line, header first, trailing newline. Key order is fixed by construction in `buildBankExport`. */
export function renderJsonl(e: BankExport): string {
  return [e.header, ...e.records].map((r) => JSON.stringify(r)).join("\n") + "\n";
}

const day = (iso: string): string => iso.slice(0, 10);

/** Human-readable, grouped by topic, with the bi-temporal detail on each line. Retracted facts go last. */
export function renderMarkdown(e: BankExport): string {
  const facts = e.records.filter((r): r is ExportFact => r.record === "fact");
  const tombstones = e.records.filter((r): r is ExportTombstone => r.record === "tombstone");
  const at = e.header.exportedAt;
  const current = facts.filter((f) => f.validity.validFrom <= at && (f.validity.validTo === null || f.validity.validTo > at)).length;
  const out: string[] = [
    `# Memory export: ${e.header.bankId}`,
    "",
    `Subject \`${e.header.subjectId}\`. Exported ${e.header.exportedAt}. ${facts.length} fact(s): ${current} current, ${facts.length - current} closed; ${tombstones.length} retracted.`,
    "",
  ];
  for (const [topic, group] of groupByTopic(facts)) {
    out.push(`## ${topic}`, "");
    for (const f of group) {
      const closed = f.validity.validTo !== null ? ` until ${day(f.validity.validTo)}` : "";
      out.push(`- ${f.statement}`);
      out.push(`  - valid from ${day(f.validity.validFrom)}${closed}; recorded ${day(f.transaction.recordedAt)}; ${f.provenance.confirmation}; id \`${f.id}\``);
      if (f.supersedes !== null) out.push(`  - supersedes \`${f.supersedes}\``);
      if (f.supersededBy !== null) out.push(`  - superseded by \`${f.supersededBy}\``);
    }
    out.push("");
  }
  if (tombstones.length > 0) {
    out.push("## Retracted", "");
    for (const t of tombstones) {
      const note = t.invalidation.note !== null ? `: ${t.invalidation.note}` : "";
      out.push(`- ~~${t.statement}~~`);
      out.push(`  - retracted ${day(t.transaction.retractedAt)} (${t.invalidation.reason}${note}); was valid from ${day(t.validity.validFrom)}; id \`${t.id}\``);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Claude's memory import (Settings > Memory > Import) takes one code block of
 * "[date saved] - memory content" lines. Grouped by category with a heading line per group.
 * Only facts current at `at` are included: this is what the provider should believe now. The
 * stamp is `validFrom` (when it became true), the more useful date for a provider that has no
 * notion of validity; `recordedAt` (when we learned it) stays in the JSONL export.
 */
export function renderClaudePaste(facts: readonly Fact[], at: Date): string {
  const out: string[] = [];
  for (const [topic, group] of groupByTopic(currentSorted(facts, at), topicOf)) {
    out.push(`# ${topic}`);
    for (const f of group) out.push(`[${day(f.validity.validFrom.toISOString())}] - ${oneLine(f.statement)}`);
    out.push("");
  }
  return out.join("\n");
}

/** Gemini's import takes a plain preferences summary: one statement per line, nothing else. */
export function renderGeminiPaste(facts: readonly Fact[], at: Date): string {
  const lines = currentSorted(facts, at).map((f) => oneLine(f.statement));
  return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

const currentSorted = (facts: readonly Fact[], at: Date): Fact[] => facts.filter((f) => isCurrent(f, at)).sort(compareFacts);

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

function groupByTopic<T extends { readonly topic: string }>(items: readonly T[]): [string, T[]][];
function groupByTopic<T>(items: readonly T[], topic: (item: T) => string): [string, T[]][];
function groupByTopic<T>(items: readonly T[], topic: (item: T) => string = (i) => (i as { topic: string }).topic): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = topic(item);
    const g = groups.get(key);
    if (g) g.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === GENERAL_TOPIC ? 1 : b === GENERAL_TOPIC ? -1 : a.localeCompare(b, "en")));
}

/**
 * Pure normalization of one Claude Code session transcript (JSONL of conversation messages) into
 * the corpus schema `{conversationId, turnIndex, role, text, occurredAt}`.
 *
 * Kept: human-authored user turns and the assistant's text replies. Dropped: tool calls, tool
 * results, thinking, system/meta/summary lines, sidechains (subagent transcripts), slash-command
 * echoes and interruption markers. Consecutive turns of one role are merged (the assistant's
 * streamed message arrives as several lines). Secrets, email addresses and absolute home paths
 * are redacted before anything is written. No network, no filesystem: testable on synthetic lines.
 */
import { looksLikeSecret } from "../../src/memory/application/write-extracted-facts.js";

export type Role = "user" | "assistant";

export interface Turn {
  readonly conversationId: string;
  readonly turnIndex: number;
  readonly role: Role;
  readonly text: string;
  readonly occurredAt: string;
}

export interface NormalizeResult {
  readonly turns: readonly Turn[];
  /** Why lines were dropped, by reason, for the corpus stats. */
  readonly dropped: Readonly<Record<string, number>>;
  readonly redactedLines: number;
  readonly truncatedTurns: number;
}

/** A single pasted file or log can dwarf the conversation; the arms and the question drafter see the same cut. */
export const MAX_TURN_CHARS = 12_000;

/** Tags Claude Code wraps around command echoes, local command output, IDE context and reminders (never user prose). */
const STRIP_WITH_CONTENT = ["system-reminder", "local-command-stdout", "local-command-stderr", "local-command-caveat", "command-name", "command-message", "command-args", "bash-input", "bash-stdout", "bash-stderr", "task-notification", "ide_selection", "ide_opened_file", "ide_diagnostics"];
/** Tags whose inner text is the user's own (keep it, drop the wrapper). */
const STRIP_TAGS_ONLY = ["pasted_content", "pasted_text"];

const INTERRUPTION = /^\[Request interrupted by user[^\]]*\]$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HOME_PATH = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g;
/**
 * Secrets these transcripts carry that `looksLikeSecret` (tuned for extracted facts) does not catch:
 * this project's own API keys (`mem_` + 32 url-safe chars), bearer tokens in pasted headers, and
 * passwords in connection URLs (`postgres://user:pass@host`).
 */
const TRANSCRIPT_SECRETS = [/\bmem_[A-Za-z0-9_-]{32}\b/, /\bBearer\s+\S{16,}/i, /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i];

export function redact(text: string): { text: string; redactedLines: number } {
  let redactedLines = 0;
  const lines = text.split("\n").map((line) => {
    if (looksLikeSecret(line) || TRANSCRIPT_SECRETS.some((p) => p.test(line))) {
      redactedLines++;
      return "[redacted]";
    }
    return line.replace(EMAIL, "[email]").replace(HOME_PATH, "~");
  });
  return { text: lines.join("\n"), redactedLines };
}

export function cleanUserText(raw: string): string {
  let text = raw;
  for (const tag of STRIP_WITH_CONTENT) text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"), "");
  for (const tag of STRIP_TAGS_ONLY) text = text.replace(new RegExp(`</?${tag}(?:\\s[^>]*)?>`, "g"), "");
  text = text.trim();
  if (INTERRUPTION.test(text)) return "";
  return text;
}

interface RawLine {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown };
}

/** Text of a message: a string, or the `text` blocks of a content array (tool_use / tool_result / thinking blocks are not text). */
function textOf(content: unknown): { text: string; onlyToolResults: boolean } {
  if (typeof content === "string") return { text: content, onlyToolResults: false };
  if (!Array.isArray(content)) return { text: "", onlyToolResults: false };
  const texts: string[] = [];
  let toolResults = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b.type === "tool_result") toolResults++;
  }
  return { text: texts.join("\n"), onlyToolResults: texts.length === 0 && toolResults > 0 };
}

export function normalizeTranscript(conversationId: string, lines: Iterable<string>): NormalizeResult {
  const dropped: Record<string, number> = {};
  const drop = (reason: string) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
  };
  const merged: { role: Role; text: string; occurredAt: string }[] = [];
  let redactedLines = 0;
  let truncatedTurns = 0;
  let lastSeen = "1970-01-01T00:00:00.000Z";

  for (const line of lines) {
    if (line.trim() === "") continue;
    let o: RawLine;
    try {
      o = JSON.parse(line) as RawLine;
    } catch {
      drop("unparsable");
      continue;
    }
    if (o.type !== "user" && o.type !== "assistant") {
      drop(typeof o.type === "string" ? `type:${o.type}` : "type:unknown");
      continue;
    }
    if (o.isSidechain === true) {
      drop("sidechain");
      continue;
    }
    if (o.isMeta === true) {
      drop("meta");
      continue;
    }
    const role: Role = o.type;
    if (o.message?.role !== role) {
      drop("role_mismatch");
      continue;
    }
    const { text: rawText, onlyToolResults } = textOf(o.message.content);
    if (onlyToolResults) {
      drop("tool_result");
      continue;
    }
    const text = role === "user" ? cleanUserText(rawText) : rawText.trim();
    if (text === "") {
      drop(role === "user" ? "user_empty_after_cleaning" : "assistant_no_text");
      continue;
    }
    if (typeof o.timestamp === "string" && !Number.isNaN(Date.parse(o.timestamp))) lastSeen = new Date(o.timestamp).toISOString();
    const previous = merged[merged.length - 1];
    if (previous && previous.role === role) previous.text = `${previous.text}\n\n${text}`;
    else merged.push({ role, text, occurredAt: lastSeen });
  }

  const turns: Turn[] = merged.map((m, turnIndex) => {
    const r = redact(m.text);
    redactedLines += r.redactedLines;
    let text = r.text;
    if (text.length > MAX_TURN_CHARS) {
      truncatedTurns++;
      text = `${text.slice(0, MAX_TURN_CHARS)}\n…[truncated ${text.length - MAX_TURN_CHARS} characters]`;
    }
    return { conversationId, turnIndex, role: m.role, text, occurredAt: m.occurredAt };
  });
  return { turns, dropped, redactedLines, truncatedTurns };
}

/** Rough token count for sizing and spend estimates (about four characters per token for English and code). */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

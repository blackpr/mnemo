/**
 * Read side of the corpus: where the normalized conversations and the index live, and how the
 * question drafter and the arms load them. The build script writes these; nothing else does.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Turn } from "./normalize.js";

export interface CorpusEntry {
  readonly conversationId: string;
  /** Last path segment of the project folder (never the full slug, which contains the home path). */
  readonly project: string;
  readonly turns: number;
  readonly userTurns: number;
  readonly approxTokens: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly redactedLines: number;
  readonly truncatedTurns: number;
}

export interface CorpusIndex {
  readonly builtAt: string;
  readonly source: string;
  readonly conversations: readonly CorpusEntry[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = path.join(here, "normalized");
export const INDEX_PATH = path.join(here, "index.json");

export async function readIndex(): Promise<CorpusIndex> {
  try {
    return JSON.parse(await readFile(INDEX_PATH, "utf8")) as CorpusIndex;
  } catch (e) {
    throw new Error(`no corpus index at ${INDEX_PATH}; run \`npm run eval:build-corpus\` first (${e instanceof Error ? e.message : String(e)})`);
  }
}

export async function loadConversation(conversationId: string): Promise<Turn[]> {
  if (!/^[A-Za-z0-9_-]+$/.test(conversationId)) throw new Error(`invalid conversation id ${JSON.stringify(conversationId)}`);
  const text = await readFile(path.join(CORPUS_DIR, `${conversationId}.jsonl`), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Turn);
}

/** How a turn is shown to a model, in every arm and in the drafter, so the question set and the answers see the same text. */
export function renderTurn(t: Turn): string {
  return `[${t.turnIndex}] ${t.role} (${t.occurredAt}):\n${t.text}`;
}

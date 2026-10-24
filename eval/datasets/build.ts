/**
 * Builds a public benchmark's corpus and question subset from the raw download (eval/datasets/raw,
 * gitignored; fetch instructions and pinned revisions in SOURCES.md):
 *
 *   node --import tsx eval/datasets/build.ts longmemeval-s   # -> eval/datasets/corpus/longmemeval-s/, eval/questions/longmemeval-s.jsonl
 *   node --import tsx eval/datasets/build.ts locomo          # -> eval/datasets/corpus/locomo/,        eval/questions/locomo.jsonl
 *
 * Subset sizes and the seed come from the environment (defaults are the recorded run):
 *   LME_PER_TYPE=4 LME_USERS=4   LOCOMO_CONVERSATIONS=4 LOCOMO_PER_CATEGORY=2   EVAL_DATASET_SEED=20261024
 * A `sample.json` manifest (seed, sizes, which questions and sessions went where) is written next to
 * each corpus. The raw file is parsed with zod and nothing in it is executed or templated.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseQuestionsJsonl } from "../questions/schema.js";
import { writeCorpus } from "./common.js";
import { convertLocomo, locomoFileSchema } from "./locomo.js";
import { convertLongMemEval, lmeFileSchema } from "./longmemeval.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = path.join(here, "raw");
export const CORPUS_ROOT = path.join(here, "corpus");
const QUESTIONS_DIR = path.join(here, "..", "questions");

const env = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
};
const seed = env("EVAL_DATASET_SEED", 20261024);
const perType = env("LME_PER_TYPE", 4);
const users = env("LME_USERS", 4);
if (users === 0 || perType % users !== 0) throw new Error(`LME_PER_TYPE (${perType}) must be a positive multiple of LME_USERS (${users}) so every user gets the same type mix`);

async function main(dataset: string | undefined): Promise<void> {
  let built;
  let source: string;
  if (dataset === "longmemeval-s") {
    const raw = lmeFileSchema.parse(JSON.parse(await readFile(path.join(RAW_DIR, "longmemeval_s_cleaned.json"), "utf8")));
    built = convertLongMemEval(raw, { perType, users, seed });
    source = "longmemeval-s (xiaowu0162/longmemeval-cleaned, longmemeval_s_cleaned.json)";
  } else if (dataset === "locomo") {
    const raw = locomoFileSchema.parse(JSON.parse(await readFile(path.join(RAW_DIR, "locomo10.json"), "utf8")));
    built = convertLocomo(raw, { conversations: env("LOCOMO_CONVERSATIONS", 4), perCategory: env("LOCOMO_PER_CATEGORY", 2), seed });
    source = "locomo (snap-research/locomo, data/locomo10.json)";
  } else {
    throw new Error("usage: build.ts <longmemeval-s|locomo>");
  }
  const corpusDir = path.join(CORPUS_ROOT, dataset);
  const index = await writeCorpus(corpusDir, source, built.conversations);
  const questionsPath = path.join(QUESTIONS_DIR, `${dataset}.jsonl`);
  const jsonl = built.questions.map((q) => JSON.stringify(q)).join("\n") + "\n";
  parseQuestionsJsonl(jsonl); // round-trip through the schema (unique ids, valid asOf) before writing
  await writeFile(questionsPath, jsonl);
  await writeFile(path.join(corpusDir, "sample.json"), JSON.stringify(built.manifest, null, 2) + "\n");
  const totalTokens = index.conversations.reduce((n, c) => n + c.approxTokens, 0);
  console.log(JSON.stringify({ dataset, seed, conversations: index.conversations.length, chunks: index.conversations.reduce((n, c) => n + c.turns, 0), approxTokens: totalTokens, questions: built.questions.length, byDatasetCategory: built.manifest.byDatasetCategory, corpusDir, questionsPath }, null, 2));
}

await main(process.argv[2]);

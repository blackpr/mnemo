/**
 * Pre-model triage: conversation turns that cannot carry a fact about the Subject are skipped
 * before the model call, with the reason in the run ledger. Deliberately conservative (when in
 * doubt, extract). Skipped: a turn with no letters or digits, a short acknowledgement ("ok
 * thanks"), nothing but fenced code, a stack trace with no prose around it, a JSON document whose
 * strings hold no natural language or names. Never skipped: any turn that answers an assistant
 * question ("nope" after "Are you still vegan?" may contradict a stored fact), single words that are
 * not acknowledgements ("Lisbon", "34"), unspaced scripts (each Han, kana or Hangul character counts
 * as a word), imported documents (Subject-authored by definition, whatever their shape).
 */
export type TriageReason = "too_short" | "acknowledgement" | "code_only" | "json_only" | "stack_trace";

/** What triage needs to know about the episode just before the trigger, if any. */
export interface PrecedingTurn {
  readonly role?: string | undefined;
  readonly text: string;
}

const FENCED_CODE = /```[\s\S]*?```/g;
/** A frame has a file position with line AND column, or Python's `File "...", line N`, and nothing else on the line. */
const STACK_FRAME = /^\s*(at\s+(\S.*\s)?\(?[^()\s]+:\d+:\d+\)?|File ".*", line \d+(, in .*)?)\s*$/;
/** The header and footer lines a trace carries: "Error: boom", "TypeError: x", "Traceback (most recent call last):", "ValueError: x". */
const TRACE_HEADER = /^\s*(Traceback \(most recent call last\):|[\w.$]*(Error|Exception)\b.*)$/;
const ACKNOWLEDGEMENTS = new Set(
  "ok okay k kk thanks thank thx ty you yes yeah yep yup sure cool great nice awesome perfect fine good done got it please bye hi hello hey lol haha hmm oh ah wow sounds alright understood noted go ahead continue proceed next".split(" "),
);
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function skipReason(text: string, kind: string = "conversation_turn", preceding?: PrecedingTurn): TriageReason | undefined {
  if (kind === "imported_document") return undefined;
  const trimmed = text.trim();
  const words = wordsOf(trimmed);
  const answersQuestion = preceding !== undefined && preceding.role === "assistant" && preceding.text.includes("?");

  if (!answersQuestion) {
    if (words.length === 0) return "too_short";
    if (words.length <= 3 && words.every((w) => ACKNOWLEDGEMENTS.has(w.toLowerCase()))) return "acknowledgement";
  }

  const withoutCode = trimmed.replace(FENCED_CODE, "").trim();
  if (withoutCode !== trimmed && wordsOf(withoutCode).length < 2) return "code_only";

  const lines = trimmed.split("\n").filter((l) => l.trim() !== "");
  const frames = lines.filter((l) => STACK_FRAME.test(l)).length;
  if (frames >= 2) {
    const prose = lines.filter((l) => !STACK_FRAME.test(l) && !TRACE_HEADER.test(l)).join(" ");
    if (wordsOf(prose).length < 3) return "stack_trace";
  }

  if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) {
    try {
      const v = JSON.parse(trimmed) as unknown;
      if (typeof v === "object" && v !== null && !stringsOf(v).some(carriesLanguage)) return "json_only";
    } catch {
      // not JSON: fall through
    }
  }
  return undefined;
}

/** Runs of letters or digits count as words; a contraction ("I'm", "don't") is one word; each Han, kana or Hangul character is a word. */
function wordsOf(s: string): string[] {
  const runs = s.replace(/(\p{L})['’](\p{L})/gu, "$1$2").match(/\p{L}+|\p{N}+/gu) ?? [];
  return runs.flatMap((r) => (UNSPACED.test(r) ? [...r] : [r]));
}

function stringsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(stringsOf);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(stringsOf);
  return [];
}

/** A JSON string value that a person might have written about themselves: a phrase (three whitespace-separated words), a capitalized name, or unspaced script. Paths and ids ("a.ts:1") are one token. */
function carriesLanguage(s: string): boolean {
  return s.trim().split(/\s+/).filter((t) => /\p{L}/u.test(t)).length >= 3 || /(?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,}/u.test(s) || UNSPACED.test(s);
}

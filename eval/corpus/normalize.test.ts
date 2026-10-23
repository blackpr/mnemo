import { describe, expect, it } from "vitest";
import { cleanUserText, MAX_TURN_CHARS, normalizeTranscript, redact } from "./normalize.js";

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const user = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: "user", timestamp: "2026-05-01T10:00:00.000Z", message: { role: "user", content }, ...extra });
const assistant = (content: unknown, extra: Record<string, unknown> = {}) => line({ type: "assistant", timestamp: "2026-05-01T10:00:05.000Z", message: { role: "assistant", content }, ...extra });

describe("normalizeTranscript", () => {
  it("keeps human turns and assistant text, drops tool traffic, meta, sidechains and summaries", () => {
    const r = normalizeTranscript("c1", [
      line({ type: "summary", summary: "ignored" }),
      user("Use pnpm for this repo, not npm."),
      assistant([{ type: "thinking", thinking: "hmm" }, { type: "tool_use", id: "t1", name: "Bash", input: {} }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
      assistant([{ type: "text", text: "Done: switched" }]),
      assistant([{ type: "text", text: "the scripts to pnpm." }]),
      user("Caveat: local commands", { isMeta: true }),
      user("sidechain prompt", { isSidechain: true }),
      line({ type: "file-history-snapshot" }),
      "not json",
      "",
    ]);
    expect(r.turns.map((t) => [t.turnIndex, t.role, t.text])).toEqual([
      [0, "user", "Use pnpm for this repo, not npm."],
      [1, "assistant", "Done: switched\n\nthe scripts to pnpm."],
    ]);
    expect(r.turns[0]?.occurredAt).toBe("2026-05-01T10:00:00.000Z");
    expect(r.dropped).toEqual({ "type:summary": 1, assistant_no_text: 1, tool_result: 1, meta: 1, sidechain: 1, "type:file-history-snapshot": 1, unparsable: 1 });
  });

  it("strips command echoes and reminders from user text and drops what is left empty", () => {
    expect(cleanUserText("<command-name>/clear</command-name>\n<local-command-stdout>cleared</local-command-stdout>")).toBe("");
    expect(cleanUserText("<system-reminder>\nmulti\nline\n</system-reminder>What is the capital?")).toBe("What is the capital?");
    expect(cleanUserText('<pasted_content id="x">pasted text</pasted_content>')).toBe("pasted text");
    expect(cleanUserText("[Request interrupted by user for tool use]")).toBe("");
    const r = normalizeTranscript("c2", [user("<command-name>/help</command-name>"), user("real question"), assistant([{ type: "text", text: "answer" }])]);
    expect(r.turns.map((t) => t.text)).toEqual(["real question", "answer"]);
    expect(r.dropped).toEqual({ user_empty_after_cleaning: 1 });
  });

  it("redacts secrets, email addresses and home paths", () => {
    const r = redact("token sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop\nmail me at someone@example.com from /Users/jane/code and /home/jane/x");
    expect(r.text).toBe("[redacted]\nmail me at [email] from ~/code and ~/x");
    expect(r.redactedLines).toBe(1);
    const own = redact(["key mem_abcdefghijklmnopqrstuvwxyz012345", 'curl -H "Authorization: Bearer abcdefghijklmnopqrstu"', "DATABASE_URL=postgres://mem:s3cret@localhost:5433/mem", "see postgres://localhost:5433/mem (no password)"].join("\n"));
    expect(own.text.split("\n")).toEqual(["[redacted]", "[redacted]", "[redacted]", "see postgres://localhost:5433/mem (no password)"]);
    expect(own.redactedLines).toBe(3);
  });

  it("truncates oversized turns and counts them", () => {
    const r = normalizeTranscript("c3", [user("x".repeat(MAX_TURN_CHARS + 50)), assistant([{ type: "text", text: "ok" }])]);
    expect(r.truncatedTurns).toBe(1);
    expect(r.turns[0]?.text.endsWith("…[truncated 50 characters]")).toBe(true);
  });
});

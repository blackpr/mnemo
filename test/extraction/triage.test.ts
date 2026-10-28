import { describe, expect, it } from "vitest";
import { skipReason } from "../../src/extraction/index.js";

describe("extraction triage (skip before the model call)", () => {
  it("skips what cannot carry a fact", () => {
    expect(skipReason("   \n  ")).toBe("too_short");
    expect(skipReason("👍")).toBe("too_short");
    expect(skipReason("ok")).toBe("acknowledgement");
    expect(skipReason("thanks, bye")).toBe("acknowledgement");
    expect(skipReason("OK thanks!")).toBe("acknowledgement");
    expect(skipReason("yes please, go ahead")).toBeUndefined(); // four words: to the model
    expect(skipReason("```ts\nconst x = 1;\nexport default x;\n```")).toBe("code_only");
    expect(skipReason("here:\n```\nnpm install\n```")).toBe("code_only");
    expect(skipReason(JSON.stringify({ tool: "grep", matches: ["a.ts:1", "b.ts:2"], exit: 0 }))).toBe("json_only");
    expect(skipReason("Error: boom\n    at run (/app/src/x.ts:10:5)\n    at main (/app/src/y.ts:20:3)\n    at node:internal/main:1:1")).toBe("stack_trace");
    expect(skipReason('Traceback (most recent call last):\n  File "a.py", line 3, in <module>\n  File "b.py", line 9, in f\nValueError: x')).toBe("stack_trace");
  });

  it("is conservative: terse facts, single words, unspaced scripts, schedules, file lists, prose around code or a trace, profile JSON, imported documents all go to the model", () => {
    for (const text of [
      "I'm vegan", "I use Vim", "Call me Max", "Nope, Lisbon", "I'm 34", "Lisbon", "34", "Vegan.", "I moved to Lisbon", "my cat is Mina", "I use neovim, not vscode", "Vivo em Lisboa agora",
      "我搬到里斯本了", "我是素食主义者", "リスボンに引っ越しました", "리스본으로 이사했어요",
      "at 9:00 gym\nat 12:30 lunch with Ana\nat 18:00 call mom", "src/app.ts:12\nsrc/db.ts:40\nsrc/api.ts:3 are the files I own at work",
      JSON.stringify({ name: "Vangelis", city: "Athens", diet: "vegan" }),
    ]) {
      expect(skipReason(text), text).toBeUndefined();
    }
    expect(skipReason("Here is the config I settled on for my blog:\n```yaml\ntheme: minimal\n```\nI like it minimal.")).toBeUndefined();
    expect(skipReason('{"a":1} is what my API returns and I hate it')).toBeUndefined();
    expect(skipReason("TypeError: x is undefined\n    at a (/s/a.ts:1:1)\n    at b (/s/b.ts:2:2)\n    at c (/s/c.ts:3:3)\n    at d (/s/d.ts:4:4)\nI'm building this for my thesis at TU Delft, deadline is March 3.")).toBeUndefined();
    expect(skipReason("ok", "imported_document")).toBeUndefined();
    expect(skipReason(JSON.stringify({ exit: 0 }), "imported_document")).toBeUndefined();
  });

  it("a reply to an assistant question is never skipped as short or an acknowledgement", () => {
    const question = { role: "assistant", text: "Are you still vegan?" };
    for (const reply of ["nope", "yes", "no thanks", "correct", "ok"]) expect(skipReason(reply, "conversation_turn", question), reply).toBeUndefined();
    expect(skipReason("ok thanks", "conversation_turn", { role: "assistant", text: "Here is the fix." })).toBe("acknowledgement");
    expect(skipReason("ok thanks", "conversation_turn", { role: "user", text: "Are you there?" })).toBe("acknowledgement");
  });
});

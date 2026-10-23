import { readFile } from "node:fs/promises";
import Ajv2020Module from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { asEpisodeId, asFactId, asPrincipalId } from "../../src/shared-kernel/index.js";
import { assertFact, invalidate, supersede, type Fact } from "../../src/memory/index.js";
import { buildBankExport, renderClaudePaste, renderGeminiPaste, renderJsonl, renderMarkdown, topicOf, type ExportRecord } from "../../src/portability/index.js";
import { bankFixture, factFixture } from "../helpers/fixtures.js";

// Both packages are CommonJS with `module.exports = X; exports.default = X`: the default import is the module object under NodeNext.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

const bank = bankFixture("bank-x", "vangelis");
const at = new Date("2026-10-23T12:00:00Z");

/** A realistic bank: one superseded chain, one predicate-tagged fact, one retracted fact, one future-dated fact. */
function sampleFacts(): readonly Fact[] {
  const berlin = factFixture(bank.id, "f-berlin", "Vangelis lives in Berlin", new Date("2026-01-10T09:00:00Z"));
  const lisbon = factFixture(bank.id, "f-lisbon", "Vangelis lives in Lisbon", new Date("2026-06-15T10:00:00Z"));
  const moved = supersede(berlin, lisbon);
  if (!moved.ok) throw new Error("fixture");
  const editor = assertFact(
    {
      id: asFactId("f-editor"),
      bankId: bank.id,
      statement: "Vangelis's editor is neovim",
      predicate: { subject: "user", predicate: "prefers_editor", object: "neovim" },
      validity: { validFrom: new Date("2026-03-02T18:00:00Z") },
      provenance: {
        sourceEpisodeIds: [asEpisodeId("ep-3")],
        writerPrincipalId: asPrincipalId("system:extractor"),
        extractor: { provider: "anthropic", model: "claude-opus-5-5", version: "v1" },
        triggerEpisodeId: asEpisodeId("ep-3"),
        confirmation: "confirmed",
        faithfulness: 0.95,
      },
    },
    new Date("2026-03-02T18:00:05Z"),
  );
  if (!editor.ok) throw new Error("fixture");
  const wrong = invalidate(factFixture(bank.id, "f-wrong", "The sky is green", new Date("2026-02-01T00:00:00Z")), "contradicted", new Date("2026-02-02T00:00:00Z"), "subject said otherwise");
  if (!wrong.ok) throw new Error("fixture");
  const future = factFixture(bank.id, "f-future", "Vangelis will speak at a conference in December", new Date("2026-12-01T00:00:00Z"));
  // Deliberately out of order: the export must sort.
  return [future, editor.value, wrong.value, moved.value.replacement, moved.value.old];
}

describe("BankExport v1", () => {
  it("every JSONL line validates against schema/bank-export.v1.json; header counts match", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(await readFile("src/portability/schema/bank-export.v1.json", "utf8")));
    const lines = renderJsonl(buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts: sampleFacts(), exportedAt: at })).split("\n");
    expect(lines.at(-1)).toBe("");
    const records = lines.slice(0, -1).map((l) => JSON.parse(l) as ExportRecord);
    for (const r of records) expect(validate(r), JSON.stringify({ record: r.record, errors: validate.errors })).toBe(true);
    const header = records[0];
    expect(header?.record).toBe("header");
    if (header?.record !== "header") throw new Error("no header");
    expect(header.counts).toEqual({ facts: 4, tombstones: 1 });
    expect(records.filter((r) => r.record === "fact").length).toBe(4);
    expect(records.filter((r) => r.record === "tombstone").length).toBe(1);
  });

  it("the schema rejects a fact line with a retractedAt and a tombstone without invalidation", async () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(await readFile("src/portability/schema/bank-export.v1.json", "utf8")));
    const e = buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts: sampleFacts(), exportedAt: at });
    const fact = e.records.find((r) => r.record === "fact")!;
    const tomb = e.records.find((r) => r.record === "tombstone")!;
    expect(validate({ ...fact, transaction: { ...fact.transaction, retractedAt: at.toISOString() } })).toBe(false);
    const { invalidation: _drop, ...noInvalidation } = tomb as typeof tomb & { invalidation: unknown };
    expect(validate(noInvalidation)).toBe(false);
    expect(validate({ ...fact, extra: 1 })).toBe(false);
    expect(validate({ ...fact, provenance: { ...fact.provenance, faithfulness: 1.5 } })).toBe(false);
    expect(validate({ ...tomb, invalidation: { ...tomb.invalidation, reason: "bored" } })).toBe(false);
  });

  it("an empty bank exports a header-only JSONL and a Markdown summary with no sections", () => {
    const e = buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts: [], exportedAt: at });
    expect(renderJsonl(e)).toBe(JSON.stringify(e.header) + "\n");
    expect(e.header.counts).toEqual({ facts: 0, tombstones: 0 });
    const md = renderMarkdown(e);
    expect(md).toContain("0 fact(s): 0 current, 0 closed; 0 retracted.");
    expect(md).not.toContain("## ");
    expect(renderClaudePaste([], at)).toBe("");
  });

  it("is deterministic and totally ordered regardless of input order", () => {
    const facts = sampleFacts();
    const a = renderJsonl(buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts, exportedAt: at }));
    const b = renderJsonl(buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts: [...facts].reverse(), exportedAt: at }));
    expect(a).toBe(b);
    const ids = a.split("\n").slice(1, -1).map((l) => (JSON.parse(l) as { id: string }).id);
    expect(ids).toEqual(["f-berlin", "f-wrong", "f-editor", "f-lisbon", "f-future"]);
  });

  it("keeps bi-temporal detail, supersession links and tombstone content", () => {
    const e = buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts: sampleFacts(), exportedAt: at });
    const byId = new Map(e.records.map((r) => [r.id, r]));
    const berlin = byId.get(asFactId("f-berlin"))!;
    expect(berlin.record).toBe("fact");
    expect(berlin.validity).toEqual({ validFrom: "2026-01-10T09:00:00.000Z", validTo: "2026-06-15T10:00:00.000Z" });
    expect(berlin.supersededBy).toBe("f-lisbon");
    expect(byId.get(asFactId("f-lisbon"))?.supersedes).toBe("f-berlin");
    const editor = byId.get(asFactId("f-editor"))!;
    expect(editor.topic).toBe("Prefers editor");
    expect(editor.provenance).toEqual({
      sourceEpisodeIds: ["ep-3"],
      writerPrincipalId: "system:extractor",
      extractor: { provider: "anthropic", model: "claude-opus-5-5", version: "v1" },
      triggerEpisodeId: "ep-3",
      confirmation: "confirmed",
      faithfulness: 0.95,
    });
    const wrong = byId.get(asFactId("f-wrong"))!;
    expect(wrong.record).toBe("tombstone");
    if (wrong.record !== "tombstone") throw new Error("expected tombstone");
    expect(wrong.statement).toBe("The sky is green");
    expect(wrong.transaction.retractedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(wrong.invalidation).toEqual({ reason: "contradicted", at: "2026-02-02T00:00:00.000Z", note: "subject said otherwise" });
  });

  it("topicOf humanizes the predicate and falls back to General", () => {
    expect(topicOf({ predicate: { subject: "u", predicate: "prefers_editor", object: "x" } })).toBe("Prefers editor");
    expect(topicOf({ predicate: { subject: "u", predicate: "lives-in", object: "x" } })).toBe("Lives in");
    expect(topicOf({ predicate: { subject: "u", predicate: "  ", object: "x" } })).toBe("General");
    expect(topicOf({})).toBe("General");
  });

  it("Markdown groups by topic with General last, lists retracted facts separately, and is stable", () => {
    const e = buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts: sampleFacts(), exportedAt: at });
    const md = renderMarkdown(e);
    expect(md).toBe(renderMarkdown(buildBankExport({ bankId: bank.id, subjectId: bank.subjectId, facts: [...sampleFacts()].reverse(), exportedAt: at })));
    const headings = md.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual(["## Prefers editor", "## General", "## Retracted"]);
    expect(md).toContain("# Memory export: bank-x");
    expect(md).toContain("4 fact(s): 2 current, 2 closed; 1 retracted.");
    expect(md).toContain("- Vangelis lives in Berlin\n  - valid from 2026-01-10 until 2026-06-15; recorded 2026-01-10; asserted; id `f-berlin`\n  - superseded by `f-lisbon`");
    expect(md).toContain("- ~~The sky is green~~\n  - retracted 2026-02-02 (contradicted: subject said otherwise)");
    expect(md.indexOf("Vangelis lives in Berlin")).toBeLessThan(md.indexOf("Vangelis lives in Lisbon"));
  });

  it("Claude paste format: [date] - content lines grouped by category, current facts only", () => {
    const text = renderClaudePaste(sampleFacts(), at);
    expect(text).toBe(["# Prefers editor", "[2026-03-02] - Vangelis's editor is neovim", "", "# General", "[2026-06-15] - Vangelis lives in Lisbon", ""].join("\n"));
    expect(text).not.toContain("Berlin"); // closed by supersession
    expect(text).not.toContain("sky"); // retracted
    expect(text).not.toContain("December"); // not yet valid
  });

  it("Gemini paste format: plain statements, one per line, multi-line statements flattened", () => {
    const facts = [...sampleFacts(), factFixture(bank.id, "f-multi", "Likes\n  coffee", new Date("2026-04-01T00:00:00Z"))];
    expect(renderGeminiPaste(facts, at)).toBe("Vangelis's editor is neovim\nLikes coffee\nVangelis lives in Lisbon\n");
    expect(renderGeminiPaste([], at)).toBe("");
  });
});

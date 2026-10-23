# Portability (supporting subdomain)

Makes the Bank the system of record for memory across providers.

## Export
- `BankExport` v1: JSONL, one Fact per line with validity, transaction time, provenance, supersession links and tombstones; plus a deterministic Markdown rendering grouped by topic.
- Versioned JSON Schema in `schema/bank-export.v1.json`.
- Every export is recorded in `portability.exports` and audited (`export.produced`).

## Import adapters
All imports create **Episodes** with `source` provenance. They never create Facts directly; extraction runs as usual.

| Adapter | Input | Notes |
|---|---|---|
| `claude-code-memory` | `~/.claude/projects/<project>/memory/*.md` with frontmatter, `MEMORY.md` index, `CLAUDE.md` hierarchy | Already plain Markdown and machine-local |
| `claude-chat-export` | claude.ai data export | Chat history; memory itself is only available as text Claude writes out |
| `gemini-takeout` | Google Takeout chat export | Same caveat |
| `chatgpt-export` | ChatGPT data export ZIP | |

## Render into provider import formats
Generate the paste-import block for Claude (`[date] - memory content`, grouped by category) and for Gemini from a Bank, so provider memory can be re-seeded from our store at any time.

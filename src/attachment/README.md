# Attachment (generic subdomain)

Protocol adapters only. No domain model. Each translates an external protocol into
application commands and queries from `src/memory` and `src/governance`, and nothing else.

| Folder | Protocol | Status | Reaches |
|---|---|---|---|
| `rest/` | HTTP JSON | first (the eval harness needs it) | SDKs, harness |
| `mcp/` | MCP remote streamable-HTTP with OAuth; tools `recall`, `retain`, `list_facts`, `confirm`, `dispute`, `export` | second | Claude Desktop/Code, Gemini CLI, Cursor, VS Code, ChatGPT Developer Mode |
| `anthropic-memory-tool/` | Anthropic memory tool file ops over a virtual `/memories` tree rendered from Facts | third | Any Claude 4+ API app |
| `openai-proxy/` | OpenAI-compatible chat endpoint that injects recall and retains turns | later | Anything speaking the OpenAI API |

Rules:
- Resolve a `Scope` from credentials via Governance before calling anything.
- Never return engine text; only Facts and Episodes read under the Scope.
- Every served recall writes an audit entry with ids only.

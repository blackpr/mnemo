# Retain policy: how assistants and memory layers decide what to remember (as of 2026-10-28)

Source-date legend: **[current]** dated or evidently updated within about six months of 2026-10-28; **[stale?]** older than about six months, may have changed; **[undated]** no date on the page (fetched 2026-10-28); **[unofficial]** leaked prompt or third-party write-up; **[anecdotal]** single user, single deployment or vendor-competitor claim; **[snippet]** seen only in a search-result summary, page not fetched.

## 1. How the big assistants decide what to save (ChatGPT, Claude, Gemini)

### Takeaway
All three combine an always-honoured explicit path ("remember that ...") with a narrow implicit path whose test is durability ("true for months or years", useful in a future conversation), plus an exclusion list (short-lived task details, redundant or random facts, text the user is only translating, sensitive categories unless explicitly asked). Claude goes further and has a never-save list even on request; Gemini's Saved Info is documented as explicit-only. None of them asks the user for approval before saving by default; review is after the fact (view, edit, delete).

### Cited Findings
**ChatGPT (bio tool), unofficial leaked prompts**
- GPT-5-era leaked prompt (prompt states current date 2025-09-29) **[unofficial][stale?]**: use the bio tool when "the user is requesting for you to save, remember, forget, or delete information" and always call it then; also "Anytime the user shares information that will likely be true for months or years", with "from now on" / "going forward" as signals — [Zei33 gist](https://gist.github.com/Zei33/415224187a1632f78e959a2e57ad838c)
- Same prompt: call the tool before replying with a phrase such as "noted" (i.e. never claim to have saved without saving) — [Zei33 gist](https://gist.github.com/Zei33/415224187a1632f78e959a2e57ad838c)
- Same prompt, do-not-save list: "Overly-personal details that could feel creepy", "Short-lived facts that won't matter soon", "Random details that lack clear future relevance", "Redundant information that we already know about the user", and information "pulled from text the user is trying to translate or rewrite" — [Zei33 gist](https://gist.github.com/Zei33/415224187a1632f78e959a2e57ad838c)
- Same prompt: sensitive categories (race/ethnicity/religion, precise geolocation, political affiliation, health incl. mental health and sex life) are not saved unless the user explicitly requests it; explicit save/forget requests override the exclusions; if it is unclear whether the user wants something saved, the model "must ask the user for clarification" — [Zei33 gist](https://gist.github.com/Zei33/415224187a1632f78e959a2e57ad838c)
- Earlier 2025 leaks used blunter wording: "DO NOT SAVE SHORT TERM INFORMATION." (Mar 2025) and "DO NOT USE THE BIO TOOL TO SAVE SENSITIVE INFORMATION." (May 2025, GPT-4o) **[unofficial][stale?][snippet]** — [r/PromptEngineering, Mar 2025](https://redlib.ssps.io/r/PromptEngineering/comments/1j5mca4/i_made_chatgpt_45_leak_its_system_prompt); [r/PromptEngineering, May 2025](https://redlib.ssps.io/r/PromptEngineering/comments/1kseb8o/just_made_gpt4o_leak_its_system_prompt/mtm0h65/?context=3)
- Official: OpenAI's 2025-10-15 release notes describe automatic memory management that keeps the most relevant saved memories "top of mind" and pushes less important ones to the background (ranked by recency and how often a topic comes up) to avoid hitting "memory full"; users can turn it off and manually prioritise/deprioritise **[stale?][snippet]**; the Memory FAQ returned HTTP 403 to the fetcher — [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes); [Memory FAQ](https://help.openai.com/en/articles/8590148-memory-in-chatgpt-remembering-what-you-chat-about)
- Users still report "memory full" warnings; one reports a ~73–74 KB saved-memory list triggering it **[anecdotal]** — [OpenAI community](https://community.openai.com/t/please-increase-the-capacity-of-legacy-saved-memories/1394689); [OpenAI community](https://community.openai.com/t/memory-full-chatgpt-memory-is-full-you-can-forget-existing-memories-to-make-space/1213437)

**Claude (claude.ai) and Anthropic guidance**
- Claude saves memory "as individual topics during chats, rather than summarizing conversations after they end"; it saves on its own and on request; the legacy experience was a synthesis "updated every 24 hours" **[current: page "Updated this week"]** — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Focus: role and professional context, people and places in the user's work, communication and technical preferences, ongoing project details — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Sensitive topics (health, religion, politics and similar) are excluded unless the user turns on "Include sensitive topics in memory"; government ID numbers, criminal history, financial account numbers and immigration status are never saved "even if you ask" — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Incognito chats are not saved to memory; deleting a chat does not delete memory derived from it; users edit/delete topics in Settings — [Claude Help Center](https://support.claude.com/en/articles/11817273); [search summary of same article](https://support.claude.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context) **[snippet]**
- Claude Code auto memory saves four typed kinds of note: `user` (role, expertise, working preferences), `feedback` (corrections and confirmed approaches), `project` (work, deadlines, decisions "that Claude can't derive from the code or git history"), `reference` (where external information lives) **[current]** — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Claude Code skips anything derivable from the codebase ("architecture, file paths, or debugging fixes") and anything already in CLAUDE.md; "Claude doesn't save something every session"; "remember that ..." requests are saved to auto memory — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Claude Code caps the always-loaded `MEMORY.md` index at 200 lines / 25 KB and, near the cap, tells Claude to "merge or drop stale entries"; writes stamp a `modified` timestamp; the UI shows "Saved 2 memories" — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- API memory tool: the auto-injected system prompt tells Claude to view memory first and "record status / progress / thoughts" (task-progress oriented, not user-profile oriented); Anthropic suggests scoping with "Only write down information relevant to <topic> in your memory system" **[undated; examples use claude-opus-5-5, so current]** — [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- Same docs: "Claude usually refuses to write sensitive information to memory files. For stronger guarantees, add validation that strips sensitive data before your handler writes"; recommend size caps and "Periodically delete memory files that haven't been accessed in a long time" — [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)

**Gemini**
- Saved Info (now under "Personal context") is filled when the user adds items or asks Gemini to remember something in chat; the help page does not describe automatic saving; Gemini won't save info that may violate the Prohibited Use Policy; not available under 18 or in Gemini Live **[undated, ©2026]** — [Gemini Apps Help](https://support.google.com/gemini/answer/16413516)
- A separate past-chats feature reportedly renamed "Memory" in March 2026, requiring Keep Activity **[unofficial][snippet]** — [ai-toolbox guide](https://www.ai-toolbox.co/gemini-management-and-productivity/gemini-memory-saved-info-2026)

### Inferences
- The shared policy shape is: (1) explicit request → always save, even trivia; (2) implicit → only if durable for months+ and not redundant; (3) hard exclusions for transient task state and sensitive categories; (4) ask when unclear; (5) never claim "noted" without a write. This maps directly onto `mem`'s current instruction ("durable ... a decision, a preference, a change") but `mem` lacks the explicit exclusion list, the redundancy rule, the sensitive-category rule and the "ask when unclear" rule.
- Claude Code's "skip what is derivable from the code" rule is the coding-client analogue of "skip transient task details"; it is worth copying for Claude Code sessions, where most turns are about code.
- Anthropic moved claude.ai from a 24-hour batch synthesis to in-chat topic saves, which suggests that for a consumer product they preferred immediacy and per-topic granularity over nightly batching (the help page gives no reason, so this is a reading, not a stated rationale).

### Gaps
- OpenAI's current (late 2026) bio/memory instructions are not published; the newest leak found is dated 2025-09-29. The official Memory FAQ was not readable (HTTP 403).
- No published Google guidance on what Gemini's model is told not to save; no official Gemini system-prompt text found.
- No first-party statement found from any vendor on save frequency (memories per conversation).

## 2. Memory frameworks' guidance, defaults and evidence on junk (Mem0, Zep/Graphiti, Letta, LangMem, Supermemory)

### Takeaway
Frameworks converge on "narrow the extraction prompt, add negative examples that return nothing, and gate before storage". The best public evidence on junk is a single-deployment audit of Mem0 (97.8% junk over 10,134 entries) whose largest junk sources were system-prompt restating, cron/heartbeat noise, architecture dumps and transient task state, and whose most damaging failure was a recall→re-extraction feedback loop. Write-time gates reportedly cut junk substantially but no framework claims to have solved it.

### Cited Findings
**Mem0 junk audit (issue #4573)** **[opened 2026-03-27, closed 2026-06-05; anecdotal: one human, one agent, 32 days]**
- 10,134 entries reviewed; ~224 survived (186 rewritten, 38 kept as-is); 97.8% junk overall; 96.9% in the 6,264-entry manual pass and 89.6% in the final Claude Sonnet 4.6 batch (first 20 days used gemma2:2b) — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Junk by category: boot-file / system-prompt restating ~3,200 (52.7%); heartbeat/cron/system noise ~700 (11.5%); architecture dumps ~500 (8.2%); transient task state ~450 (7.4%); hallucinated user profiles ~315 (5.2%); identity confusion ~200 (3.3%); security/privacy leaks ~130 (2.1%); wrong locations ~60; fabricated lifestyle ~50 — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Feedback loop: 808 entries said "User prefers Vim" (191 exact copies) though nobody used Vim; recalled memories were re-extracted as new facts — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Author's diagnosis: "The extraction prompt is the bottleneck, not the model" — a stronger model extracted more faithfully and therefore more indiscriminately; no quality gate, no negative examples, no REJECT action, no identity awareness, role boundaries flattened — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Fixes proposed: mark recalled memories so extraction skips them; quality gate between extraction and storage; negative few-shots; REJECT action; identity-aware, user-only extraction; drop `role == "system"`; extract assistant content only when the user confirms it — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Reported results: after four config changes (NONE-by-default update prompt, dedup threshold 0.98→0.90, user-only extraction) a 48-hour sample was still 46.6% junk (34/73), attribution not isolated; a commenter's write-time gate cut stored junk 45% at 30 days with no recall loss across 18 runs (2026-09-16) and noted true-but-never-asked facts survive at 90 days **[anecdotal]** — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Closure cited shipped features (ADD-only single-pass algorithm April 2026, memory decay / recency ranking May 2026, temporal reranking June 2026) and said prompt permissiveness, feedback-loop prevention and identity-aware extraction remain "ongoing areas of improvement" — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Related open issues (from this repo's earlier landscape notes, not re-fetched): #7283 proposing a faithfulness check before memory write (2026-09-11), #4956 on ADD-only extraction surfacing stale/contradictory facts (2026-04-24) — [mem0 #7283](https://github.com/mem0ai/mem0/issues/7283); [mem0 #4956](https://github.com/mem0ai/mem0/issues/4956)

**Mem0 docs**
- Custom extraction prompt (`custom_instructions`, formerly `custom_fact_extraction_prompt`): state the exact allowed fact types; include negative few-shots that return `{"facts": []}` (greetings, small talk, off-domain statements such as "I like going to hikes" in a support bot); "Overly broad prompts let unrelated facts through"; test on real transcripts, re-run regression samples after each prompt edit, spot-check stored memories, version prompts **[undated]** — [Mem0 docs: custom fact extraction](https://docs.mem0.ai/open-source/features/custom-fact-extraction-prompt)
- Platform "selective memory" takes plain-text `includes` / `excludes` (e.g. exclude "food preferences"); 15 default categories, replaceable per project; categories are applied at ingestion and not re-tagged later; a newer doc warns per-call category overrides are not supported on the managed API **[snippet; sources conflict on per-call overrides]** — [Mem0 selective memory](https://docs.mem0.ai/platform/features/selective-memory); [Mem0 custom categories](https://docs.mem0.ai/platform/features/custom-categories)

**Zep / Graphiti**
- Graphiti invalidates outdated facts with temporal logic and keeps them as history rather than deleting **[undated]** — [Zep vs Graphiti](https://help.getzep.com/zep-vs-graphiti); [Zep paper, Jan 2025](https://arxiv.org/pdf/2501.13956.pdf) **[stale?]**
- Zep Cloud has "fact rating instructions" (an instruction plus high/medium/low examples) to rate facts for relevance, used to filter at retrieval **[snippet; third-party mirror, field names unverified]** — [n8n Zep node mirror](https://frontend-f26.pages.dev/package/n8n-nodes-zep/zep/Graph:Update%20Graph)

**Letta**
- Sleep-time agents (2025-04-21) **[stale?]**: a background agent edits the primary agent's core memory asynchronously; the primary agent cannot edit core memory itself; use a stronger, slower model for the sleep-time agent; frequency is configurable and "higher frequency uses more tokens"; rationale: incrementally formed memories "may become messy and disorganized over time" — [Letta blog: sleep-time compute](https://letta.com/blog/sleep-time-compute)
- Current Letta Code "Dreaming": background subagents "review recent conversations, consolidate useful lessons, and update memory"; trigger after N completed agent steps or on context compaction; an "Agent reviews before applying" option "uses more model tokens"; memory is git-backed files (MemFS) **[undated]** — [Letta docs: sleep-time](https://docs.letta.com/guides/agents/architectures/sleeptime)
- Community guide lists consolidation tasks: merge fragments, dedupe blocks, archive/prune outdated info; notes added LLM cost **[snippet][anecdotal]** — [Letta forum](https://forum.letta.com/t/sleeptime-agents-for-memory-consolidation-best-practices-guide/154)

**LangMem**
- Hot-path (agent-initiated) writes "add perceptible latency"; background extraction after a conversation or after inactivity adds no latency and gives "higher recall"; over-extraction "could lead to reduced precision"; profiles (one schema'd document) avoid "extraneous information" vs collections that need reconciliation **[undated; LangMem launched early 2025, stale?]** — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)

**Supermemory**
- Ingestion-time filter prompt (`shouldLLMFilter` + `filterPrompt`) naming content to index and to skip; a June 2026 changelog adds a per-space "what to remember" context that steers extraction **[snippet]** — [Supermemory customization](https://supermemory.ai/docs/concepts/customization.md); [Supermemory rules](https://supermemory.ai/docs/concepts/rules)
- Inferred memories (derived from patterns) carry `isInference: true` and sit in a review queue (`GET .../inferred`, up to 50, ordered by `parentCount`); `approve` clears the flag, `decline` forgets, `undo` reverts **[undated]** — [Supermemory memory review](https://supermemory.ai/docs/recall/memory-review)

### Inferences
- `mem` already blocks the two biggest Mem0 junk sources by construction (user-authored text only, so no boot-file/system-prompt restating and no assistant content; triage skips acknowledgements, code-only turns, stack traces, contentless JSON). The residual Mem0 categories most relevant to `mem` are transient task state (7.4%), hallucinated/identity-confused profiles (8.5% combined) and the recall→retain feedback loop.
- The feedback loop is a live risk for model-initiated `retain` over MCP: the model sees `recall` output in context and may paraphrase it back into a `retain` call. `mem` cannot verify authorship on claude.ai/ChatGPT/Gemini, so a server-side guard (reject or no-op a retain whose content mostly restates currently believed facts, or require the verbatim user quote) is the MCP-era version of "mark recalled memories so extraction skips them".
- Negative few-shots and a REJECT/NONE-by-default write path are cheap and repeatedly recommended; `mem`'s write policy already dedupes/supersedes/retracts, so the remaining gap is an explicit "reject: not durable" outcome recorded in the ledger.

### Gaps
- No independent, multi-user junk audit of any framework found; #4573 is one deployment and its improvements are self-reported.
- No official Zep/Graphiti guidance found on over-saving; fact-rating details came from a mirror.
- No published precision numbers for Letta sleep-time consolidation or Supermemory filters.

## 3. Tool-description and MCP-instructions design: does wording change how often models call a tool?

### Takeaway
Wording demonstrably changes agent behaviour (Anthropic: "small refinements ... dramatic improvements"; a 2026 study: augmented MCP descriptions +5.85 pp median task success but +67% steps and regressions in a sixth of cases), but no controlled study was found that measures memory-tool call frequency under different wordings. MCP server `instructions` are only a hint that clients MAY put in the system prompt, so the policy must also live in the `retain` tool description itself.

### Cited Findings
- Anthropic: describe a tool "to a new hire on your team", make implicit context explicit, use unambiguous parameter names; "Even small refinements to tool descriptions can yield dramatic improvements"; Sonnet 3.5's SWE-bench Verified result followed precise tool-description refinements; a description fix stopped Claude appending "2025" to search queries **[2025-09-11, stale?]** — [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Same post: prefer few well-designed tools over overlapping ones; evaluate with realistic tasks and track tool-call counts and errors; read transcripts — [Anthropic: Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- MCP `InitializeResult.instructions`: "Instructions describing how to use the server and its features ... It can be thought of like a 'hint' to the model. For example, this information MAY be added to the system prompt." **[spec 2025-06-18; later revisions may exist, not checked]** — [MCP schema 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/schema)
- MCP `ToolAnnotations` (`title`, `readOnlyHint` default false, `destructiveHint` default true, `idempotentHint` default false, `openWorldHint` default true) are "hints ... not guaranteed"; "Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers"; the spec's own `openWorldHint` example says a memory tool's domain is closed — [MCP schema 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/schema)
- "MCP Tool Descriptions Are Smelly!" (856 tools, 103 servers): 97.1% of descriptions have at least one smell, 56% fail to state purpose clearly; augmenting all components raised task success by a median 5.85 pp and partial goal completion 15.12%, but execution steps rose 67.46% and performance regressed in 16.67% of cases; compact component combinations often kept reliability with fewer tokens **[v1 2026-02-16, v3 2026-05-31, current]** — [arXiv 2602.14878](https://arxiv.org/abs/2602.14878)
- A companion study of 10,831 MCP servers defines 18 description-smell categories **[snippet]** — [arXiv 2602.18914](https://arxiv.org/abs/2602.18914v1)
- Claude Code: CLAUDE.md/memory are "context, not enforced configuration"; "The more specific and concise your instructions, the more consistently Claude follows them"; anything that must happen at a fixed point should be a hook, which runs "regardless of what Claude decides" — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Explicit-trigger and ask-first patterns in shipped products: ChatGPT always honours save/forget requests and asks when unclear (leak **[unofficial][stale?]**) — [Zei33 gist](https://gist.github.com/Zei33/415224187a1632f78e959a2e57ad838c); Claude Code saves on "remember that ..." — [Claude Code docs: memory](https://code.claude.com/docs/en/memory); Gemini Saved Info saves when asked — [Gemini Apps Help](https://support.google.com/gemini/answer/16413516)

### Inferences
- Because `instructions` may be dropped by some clients, the decisive "call retain only for X; never for Y" text belongs in the `retain` description (and briefly in `recall`'s), with `instructions` repeating it. The 67% step inflation finding argues for keeping the description compact: a short durability test, a short exclusion list, and two or three examples rather than a long essay.
- Annotation choices that follow the spec: `recall`/`list_facts` `readOnlyHint: true`; `retain` `readOnlyHint: false`, `destructiveHint: false` (additive), `openWorldHint: false`; `dispute_fact` arguably `destructiveHint: true`. Whether any of claude.ai, ChatGPT or Gemini changes confirmation prompts based on these is unverified.
- Description wording for `retain` that the evidence supports: (a) "Call when the user asks you to remember/forget something — always"; (b) "Otherwise only for statements likely true for months: decisions, preferences, changes to their tools, people, places, projects"; (c) "Never for: the current task's steps, code, errors, things you said, facts you just got from recall, text the user is translating/editing, health/religion/politics/ID/financial numbers unless explicitly asked"; (d) "Pass the user's own words verbatim"; (e) "If unsure, ask the user"; (f) "Do not say you'll remember something without calling retain".

### Gaps
- No controlled measurement found of how often Claude, GPT or Gemini call a memory tool under different description wordings; `mem` would need its own eval (e.g. replay of real transcripts through each client, counting retain calls and judging them against a labelled set).
- arXiv 2605.23916 (deliberate description optimisation for tool selection) was surfaced but not read; results unknown — [arXiv 2605.23916](https://arxiv.org/pdf/2605.23916)
- Whether claude.ai, ChatGPT and Gemini inject MCP `instructions` into the system prompt was not verified for any of them.

## 4. Hooks for memory capture and recall injection (Claude Code; Codex CLI, Gemini CLI, Cursor)

### Takeaway
Claude Code hooks give deterministic capture points with the transcript path in every payload; `UserPromptSubmit` and `SessionStart` can inject recall, `SessionEnd` cannot inject and has a 1.5 s default budget, and handlers can run async or call an MCP tool directly. Open-source memory plugins (claude-mem, Hindsight) capture whole sessions or tool observations and compress them with an LLM; the reported pitfalls are token overhead from injected context, per-tool-call hook latency, LLM-judged (non-deterministic) noise filtering and privacy exposure of code and secrets. Codex CLI and Gemini CLI now have comparable hooks; Cursor was not covered.

### Cited Findings
**Claude Code hooks reference** **[current]**
- Events include per-session `SessionStart`, `SessionEnd`, `Setup`; per-turn `UserPromptSubmit`, `Stop`, `StopFailure`; tool-level `PreToolUse`, `PostToolUse` etc.; `PreCompact`/`PostCompact`; `SubagentStop`, and more — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- `SessionStart` (sources `startup`, `resume`, `clear`, `compact`, `fork`): stdout and `additionalContext` are added to context; supports only `command` and `mcp_tool` handlers — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- `UserPromptSubmit`: stdout/`additionalContext` injected; exit 2 blocks the prompt; default timeout 30 s — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- `Stop`: input includes `transcript_path` and `last_assistant_message`; can block to keep Claude working — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- `PreCompact` (matcher `manual`/`auto`) can block compaction; `SessionEnd` (reasons `clear`, `resume`, `logout`, `prompt_input_exit`, `other`) output is not injected and all SessionEnd hooks share a 1.5 s budget, raisable to 60 s via per-hook `timeout` — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- Handler types: `command` (supports `async: true`, not timeout-enforced, and `asyncRewake`), `http`, `mcp_tool` (calls a tool on a configured MCP server), `prompt` (single-turn Claude evaluation, default 30 s), `agent` (experimental subagent) — [Claude Code hooks](https://code.claude.com/docs/en/hooks)

**claude-mem** **[current: v15.4.0, ~104k stars]**
- Uses SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd; captures tool-usage observations plus AI-generated semantic summaries ("everything your agent does during sessions"), compressed by an LLM (Agent SDK; hosted observer, own OpenRouter/Gemini key, or the user's Anthropic plan); injects relevant past context at session start; `<private>` tags keep content out of storage; optional cloud sync — [claude-mem](https://github.com/thedotmack/claude-mem)
- On Gemini CLI, claude-mem uses SessionEnd to mark the session complete and trigger a summary, SessionStart to inject context **[snippet]** — [claude-mem Gemini CLI setup](https://docs.claude-mem.ai/gemini-cli/setup.md)
- Reported costs **[anecdotal / competitor claims]**: ~5,150 compression tokens per session on v13.2.0 and hooks firing on nearly every model action — [dev.to](https://dev.to/harrisonsec/agent-memory-is-a-cache-coherence-problem-4jmk); a hooks-on vs hooks-off A/B costing the same $5.56 with first-prompt cache reads more than doubled by SessionStart injection (2026-03-14) — [Reddit snapshot](https://reddit.sentinel-team.org/posts/1rsh7oi/snapshots/2026-03-14T00%3A11%3A38.395735Z); a competitor claims ~42k tokens of plugin context per session — [claude-historian comparison](https://glama.ai/mcp/servers/@Vvkmnn/claude-historian/blob/5523c7a4febebd9cb3e54990eb6bc693ee206aa5/COMPARISON.md); claude-mem's skip/keep decision is an LLM prompt while a lighter fork uses deterministic code filters — [claude-mem-lite](https://awesome.ecosyste.ms/projects/github.com%2Fsdsrss%2Fclaude-mem-lite); per-tool-call hooks add ~50–200 ms and pose code-upload/cross-project leak risk — [tutorial](https://openclaweco-website-build.pages.dev/tutorial/claude-memory-tutorial/lesson-10/)

**Codex CLI, Gemini CLI, Hindsight**
- Codex CLI added experimental hooks in v0.114.0 (March 2026): SessionStart, Stop, UserPromptSubmit, configured in `.codex/hooks.json`, behind a flag **[snippet; article 404 on fetch]** — [Codex hooks deep dive](https://codex.danielvaughan.com/2026/03/26/codex-cli-hooks-deep-dive); official page exists but was not read — [OpenAI docs: hooks](https://developers.openai.com/es-419/docs/hooks)
- Hindsight's Codex integration: SessionStart warms the daemon, UserPromptSubmit auto-recalls (configurable timeout and score floors), Stop auto-retains with "Full-session retain with session-level upsert using session ID as document ID"; later versions retain structured tool calls and filter synthetic AGENTS startup messages **[undated]** — [Hindsight Codex changelog](https://hindsight.vectorize.io/changelog/integrations/codex)
- Gemini CLI has SessionStart and SessionEnd hooks from v0.26.0 **[snippet]** — [Gemini CLI hooks reference (mirror)](https://www.mintlify.com/google-gemini/gemini-cli/reference/hooks); [hook comparison](https://lilting.ch/en/articles/gemini-cli-hooks-research)
- This repo's spike measured Hindsight's write cost as far from linear: a 64-turn conversation cost 1.09M LLM tokens (consolidation batches of 5–8 memories at ~17k input each) — `/Users/blackpr/code/mem/STATUS.md`

### Inferences
- For `mem` in Claude Code the cleanest capture point is `SessionEnd` (plus `PreCompact` for long sessions) with an `async` command or `mcp_tool` handler that only enqueues the transcript path/user turns and returns, so the 1.5 s budget is not an issue; extraction then runs in `mem`'s existing worker. `Stop` fires every turn and would recreate per-message volume.
- `UserPromptSubmit` is the natural recall-injection point (30 s timeout, output injected), but injected recall text then sits in the transcript; any transcript-based extraction must exclude injected `additionalContext`/system-reminder blocks or it recreates Mem0's Vim loop. Hindsight's filtering of synthetic AGENTS messages is the same fix.
- Whole-transcript capture (claude-mem, Hindsight) maximises recall of tool/code events, which is exactly the content `mem` wants to exclude (code, stack traces, architecture). A `mem` hook should pass user-authored turns only, which `mem`'s extractor already enforces.
- A `prompt`-type hook on `UserPromptSubmit` could act as a cheap "does this prompt state something durable?" classifier before calling `retain`, but it is still a model call per prompt; deterministic triage first is cheaper.

### Gaps
- Cursor hooks: no source found in this session.
- No independent measurement of claude-mem's memory precision or of hook-based capture junk rates.
- Whether Codex's hook payload includes a transcript path was not confirmed (article unreachable).

## 5. Periodic summarisation, consolidation, review queues and decay

### Takeaway
Batch/background extraction trades freshness for higher recall and no user-facing latency (LangMem, Letta), and it concentrates cost into fewer, larger calls; vendors pair it with decay or deprioritisation rather than deletion (ChatGPT, Mem0, Anthropic's expiry advice). Human approval queues exist in enterprise agent platforms and Supermemory (for inferred memories), typically with pending items excluded or flagged and auto-expiring after about a week, but no major consumer assistant gates memory behind approval; they rely on visible saves plus edit/delete.

### Cited Findings
- LangMem: background formation "after a period of inactivity" adds no latency and favours recall; hot path favours immediacy — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- Letta: sleep-time agent with a stronger model, configurable frequency, more tokens at higher frequency; Letta Code triggers consolidation after N steps or on compaction; review-before-apply costs more tokens — [Letta blog](https://letta.com/blog/sleep-time-compute) **[stale?]**; [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime)
- claude.ai switched from a legacy synthesis "updated every 24 hours" to saving topics as you chat — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- ChatGPT deprioritises less relevant memories by recency and frequency instead of deleting them; users can manually prioritise — [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) **[stale?][snippet]**
- Mem0 added memory decay (recency-aware ranking) in May 2026 — [mem0 #4573 closing comment](https://github.com/mem0ai/mem0/issues/4573)
- Anthropic recommends expiring memory files not accessed in a long time — [Memory tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- Claude Code keeps memory quality by a hard index budget (200 lines / 25 KB) and reminders to merge or drop stale entries — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Review queues: Supermemory's inferred-memory queue (approve/decline/undo) — [Supermemory memory review](https://supermemory.ai/docs/recall/memory-review); Automation Anywhere and Odin store detected memories as pending for admin approval, showing the triggering message and a confidence score, expiring after 7 days **[snippet]** — [Automation Anywhere](https://ai-kb.automationanywhere.com/agents/memory-managing); [Odin](https://learn.getodin.ai/agents/memory-managing); memsmith models a `PendingConfirmation` state **[snippet]** — [memsmith](https://pypi.org/project/memsmith/)
- Write-time gating vs decay: one practitioner reports a write gate cut stored junk 45% at 30 days with no recall loss, and that true-but-unused facts still survive at 90 days, which a write gate should not remove **[anecdotal]** — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- `mem`'s own cost data: `extract-v3` averages 11,629 input tokens per extraction call on session-sized LoCoMo episodes; 114 calls cost 6.32 USD write (about 0.055 USD per call); uncached context is about 72% of remaining write cost, and a tighter `EXTRACTION_CONTEXT_CHARS` is the next lever — `/Users/blackpr/code/mem/eval/RESULTS.md`; `/Users/blackpr/code/mem/STATUS.md`

### Inferences
- `mem` already has the review primitives (`list_facts`, `confirm_fact`, `dispute_fact`); a review queue is mostly a fact status (`candidate`) plus a recall rule (exclude, or include flagged like Supermemory's `isInference`) and an expiry (the ~7-day convention seen above).
- Batch extraction over a whole session's user turns gives the extractor more context to judge durability (a preference restated three times vs a one-off), which per-statement extraction cannot see; this is the quality argument for end-of-session batching, separate from the cost argument.
- Decay belongs at ranking time (recency/frequency), not deletion, given the "true but unused facts" observation; `mem`'s bi-temporal model can support "deprioritise" without losing history.

### Gaps
- No published head-to-head of per-message vs end-of-session extraction precision/recall/cost for user memory found.
- No data on review-queue fatigue (approval rates, abandonment) for single-user personal memory.

## 6. Retain-policy options for `mem`, with pros, cons and expected call volume

### Takeaway
Three options are supported by the evidence: (A) model-initiated retain with a strict, compact policy and server-side guards (the ChatGPT/Claude pattern); (B) explicit-only retain (the Gemini Saved Info pattern); (C) hook-driven end-of-session batch extraction for Claude Code into a candidate/review state (the Letta/LangMem background pattern plus a Supermemory-style queue). A per-prompt capture hook (every user message → retain) is the Mem0 firehose that the 97.8% audit argues against.

### Cited Findings
- Durability test, exclusions, explicit override and ask-when-unclear are what ChatGPT's bio tool uses — [Zei33 gist](https://gist.github.com/Zei33/415224187a1632f78e959a2e57ad838c) **[unofficial][stale?]**
- Claude saves implicitly during chats, with sensitive topics opt-in and a never-save list — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Gemini Saved Info is documented as user-added or on request — [Gemini Apps Help](https://support.google.com/gemini/answer/16413516)
- Claude Code auto memory "doesn't save something every session" — [Claude Code docs: memory](https://code.claude.com/docs/en/memory)
- Hook capture points, async handlers, `mcp_tool` handler, SessionEnd 1.5 s budget — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- Background extraction: no latency, higher recall; over-extraction lowers precision — [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- Junk drivers and feedback loop — [mem0 #4573](https://github.com/mem0ai/mem0/issues/4573)
- Per-call extraction cost ≈ 0.055 USD on session-sized episodes (extract-v3) — `/Users/blackpr/code/mem/eval/RESULTS.md`

### Inferences
**Option A: model-initiated retain, strict policy, server guards (tightened status quo)**
- Policy text in the `retain` description (not only `instructions`): explicit "remember/forget" → always; otherwise only statements likely true for months (decisions, preferences, changes, people, places, tools, projects); never transient task steps, code, errors, assistant output, facts just returned by `recall`, translated/edited text, sensitive categories unless explicitly asked; pass verbatim user words; ask if unsure; never claim "noted" without calling it.
- Server guards: reject/no-op when the text mostly restates current facts (feedback-loop guard), exact-duplicate retains within a session, and a per-session soft cap; record `rejected:<reason>` in the ledger.
- Pros: works on all four clients; matches what users already expect from ChatGPT/Claude; facts available immediately; cost scales with genuinely durable statements.
- Cons: recall of durable facts depends on each model's compliance, which varies by client and is unmeasured; models can paraphrase rather than quote; `instructions` may be ignored by some clients.
- Expected volume (estimate, not measured): 0–3 retains per conversation, a handful per day across clients; at ≤0.055 USD per call worst case, well under 1 USD/day. Needs a `mem` eval counting retain calls per client on replayed transcripts.

**Option B: explicit-only retain**
- `retain` is called only on explicit user triggers ("remember that ...", "from now on ...", "forget ..."), optionally with an `explicit: true` flag that raises confidence and bypasses the durability filter (as ChatGPT does for explicit requests).
- Pros: highest precision, near-zero junk, predictable and cheap, easiest to explain; consistent across clients because trigger phrases are easy for every model to detect.
- Cons: misses implicit durable facts (job change mentioned in passing, a new tool adopted), so memory grows slowly and depends on user habit; weaker than what ChatGPT/Claude do natively, which may make `mem` feel worse as a daily driver.
- Expected volume (estimate): 0–2 calls per day.

**Option C: hook-driven end-of-session batch extraction with a candidate/review state (Claude Code), alongside A or B on other clients**
- `SessionEnd` (and `PreCompact`) async handler enqueues the session's user-authored turns (excluding injected recall/system-reminder content) as one Episode batch; one extraction call per session judges durability across the whole session; resulting facts land as `candidate` (excluded from recall, or returned flagged), reviewed via `list_facts` + `confirm_fact`/`dispute_fact`, auto-expiring after ~7 days if not confirmed (or auto-promoted if restated in a later session).
- Pros: deterministic capture that does not rely on model compliance; one larger call per session instead of many; whole-session context helps separate durable from transient; matches Letta/LangMem background design and claude-mem/Hindsight hook practice.
- Cons: Claude Code (and Codex/Gemini CLI) only; coding sessions are mostly code and task state, so many sessions yield nothing; facts arrive late; transcripts carry secrets and private code (needs `mem`'s secret detection and a `<private>`-style opt-out); review fatigue; per-call input grows with session length (bounded by `EXTRACTION_CONTEXT_CHARS`).
- Expected volume (estimate): one call per Claude Code session end or compaction, e.g. 5–15 per day for a heavy user, each larger than a single-statement call; plus a few minutes of review per week.

**Not recommended: per-prompt capture hook (UserPromptSubmit/Stop → retain every user message)**
- Reproduces per-message extraction; volume equals user prompts (tens per session); triage removes acknowledgements and code but not transient task statements, which were 7.4% of Mem0's junk and are the majority of coding-session prose.

### Gaps
- Real per-client retain call rates under Option A wording are unknown; no published data found, so `mem` needs its own replay eval.
- Single-statement (short episode) extraction cost under extract-v3 was not measured in `eval/RESULTS.md` (measurements are for session-sized chunks).
- No evidence found on how users of a personal memory layer respond to review queues over months.

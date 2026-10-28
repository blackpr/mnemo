# What existing AI memory products show users and let them do in their UIs (to inform the `mem` GUI)

Research date: 2026-10-28. Staleness rule: anything dated before about 2026-04-28 is flagged **[STALE?]**. "Undated" means the page carries no date; it was fetched on 2026-10-28 and is assumed current. **[ANECDOTAL]** marks forum, HN, and blog sentiment. help.openai.com refused automated fetches (HTTP 403), so OpenAI help-center and release-note content below comes from search-engine snippets of those pages. It was not read directly; re-check it in a browser before relying on exact wording.

## Key Question 1: Per product, what can the user see, search, filter, edit, delete, export and audit? Is provenance shown? Is history or supersession shown? Is there a log of which app read or wrote what?

### Takeaway
None of the consumer assistants (ChatGPT, Claude, Gemini) show per-memory provenance ("this came from chat X, quote Y"), validity intervals, or a log of which app read or wrote a memory. They offer a flat list or summary with edit and delete, plus at most a per-response "what was used" indicator (ChatGPT's book icon) or a change list (Gemini's "Memory history"). The developer and self-hosted tools fill parts of the gap: OpenMemory had a per-memory, per-app access log and pause/archive states (now sunset); Supermemory has an approve/decline/undo review queue for inferred memories and an `isLatest` supersession model; Zep and Graphiti model bi-temporal facts with episode provenance but expose them mainly through a read-only graph visualizer; Letta now keeps memory in git, which gives version history. No product found combines all of these, so `mem`'s planned v1 (provenance, as-of, supersession history, audit log, erasure receipts) is ahead of every surveyed UI.

### Cited Findings

#### Feature matrix (each cell backed by the bullets below)

| Capability | ChatGPT | Claude (consumer) | Gemini | Mem0 OpenMemory (sunset) | Mem0 self-hosted server dashboard | Supermemory | Letta | Zep / Graphiti |
|---|---|---|---|---|---|---|---|---|
| See a list or summary | Saved memories list plus a memory summary page (June 2026) | "Your memory" as Topics | Memory summary (US, paid AI plan, English) | Memories table plus dashboard stats | Memories table plus detail sheet | Documents browser plus memory graph | Core memory blocks (old ADE); MemFS files | Graph visualizer (Zep); Graphiti has no UI |
| Search or filter | Search and sort by recency (Oct 2025) | Not documented | Not documented | Filter by app, category, archived; sort by text, app, date | Filter by user ID | Filtering in documents browser; API search | Archival search (old ADE); MemFS search mod | Via read-only visualizer assistant |
| Edit | Yes; reprioritize | Edit icon per topic; or ask in chat | Only by prompting ("Use prompts to update your info") | Edit content | No edit control found (delete only) | Update via API | Edit blocks (ADE); edit files (MemFS) | Not in visualizer (read-only) |
| Delete | Per item, clear all, or "Delete and turn off memory" from the summary | Delete per topic; Reset (irreversible); Pause | Edit summary; to really forget, delete every chat containing the info | Delete; pause; archive | Delete with confirmation modal | Forget by IDs or by meaning, with dry-run preview | Edit or delete blocks | API |
| Export | Not found for memory | Copy text, or ask Claude to write memories out verbatim; memory is in data export | Not found | Not found in UI | Export page locked (Cloud upsell: JSON/CSV/Pydantic) | API document list | Git repo | API |
| Provenance per item | No; per-response "memory sources" book icon | No; citations only when Claude searches past chats | No; you "just ask Gemini" whether past chats were used. Daily brief items have "Check an item's source" | Source app per memory | `user_id` and `agent_id` on detail | `parentCount` and `metadata.source: "derive"` on inferred memories | Git commits | Facts link to source episodes |
| History or supersession | No (auto-managed) | No version history documented | "Memory history" list of when info was added or modified | State-change history table (`MemoryStatusHistory`) in the data model | No | `updates` / `extends` / `derives` relations plus `isLatest` | Git version history for every memory edit | `valid_at` / `invalid_at` / `expired_at` / `created_at` per fact |
| Read/write log by app | No | No | No (Gemini Apps Activity is chat history) | Per-memory access log (app, time, access type); per-app created/accessed counts | API request log (method, path, status, latency, key type) | Not found; docs tell you to keep your own audit log | Not found | Dashboard "debug logs, API logs" |

#### ChatGPT (OpenAI)
- ChatGPT has two memory systems: "Saved memories are details users explicitly ask ChatGPT to remember, while reference chat history lets ChatGPT use information from past chats." They live under Settings > Personalization > Memory. — [OpenAI Memory FAQ (search snippet; fetch blocked)](https://help.openai.com/en/articles/8983136-what-is-memory)
- Memory sources: users can "see what sources were used to personalize a response such as custom instructions, past chats, files, and memories by tapping the book icon below the response." This is the only per-response provenance in any consumer product surveyed. — [OpenAI Memory FAQ (search snippet)](https://help.openai.com/en/articles/8983136-what-is-memory)
- Memory summary page: "You can delete the memories shown on your memory summary page and turn memory off by selecting Delete and turn off memory from the three-dot menu. This does not delete your past chats." The summary "does not necessarily include every detail or source that Memory can reference." — [OpenAI Memory FAQ (search snippet)](https://help.openai.com/en/articles/8983136-what-is-memory)
- Full erasure means deleting every place the information appears: "past chats, archived chats, files, the memory summary, and disconnect any connected apps that may contain that information." — [OpenAI Memory FAQ (search snippet)](https://help.openai.com/en/articles/8983136-what-is-memory)
- Release notes, 4 June 2026: memories are now updated automatically, with ChatGPT tracking the details it judges most important. Users can switch back to the old system via Settings > Memory > Saved memories. The rollout started with Plus and Pro in the US. 11–12 June 2026: deleting summary memories and turning memory off from the three-dot menu. — [ChatGPT release notes (search snippet; fetch blocked)](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- Third-party commentary separates the two transparency features: the summary is preventive (review before it shapes answers), and sources are reactive (tied to one response). It also lists completeness, sensitive topics, scope controls and export as open questions. Dated 6 June 2026. — [Webiano Digital](https://webiano.digital/chatgpt-memory-summary-turns-personalization-into-something-users-can-inspect/)
- 15 Oct 2025: automatic management of saved memories (addressing "memory full"). Users can search and sort memories by recency and reprioritize them. Plus/Pro, web. **[STALE?]** — [AlternativeTo, Oct 2025](https://alternativeto.net/news/2025/10/chatgpt-enhances-memory-management-for-plus-and-pro-users)
- A pre-launch report mentioned date filters and restoring removed memories. This is speculative and unconfirmed. **[STALE?]** — [TestingCatalog](https://testingcatalog.com/openai-prepares-automatic-memory-management-for-chatgpt)
- "Memory updated" notice: hover it, then click "Manage memories" to review or forget. Deleting a chat does not erase its memories; you must delete the memory itself. **[STALE?, Feb 2024]** — [OpenAI blog: Memory and new controls](https://openai.com/index/memory-and-new-controls-for-chatgpt/)
- Project-only memory shipped in August 2025 (noted by Simon Willison as the scoping he had asked for). **[STALE?]** — [Simon Willison, 21 May 2025, with later note](https://simonwillison.net/2025/May/21/chatgpt-new-memory/)
- Temporary Chat neither uses nor creates memories. — [Webiano, citing OpenAI Temporary Chat FAQ](https://webiano.digital/chatgpt-memory-summary-turns-personalization-into-something-users-can-inspect/)

#### Claude (Anthropic)
- Current location: Settings > Your Claude > "Manage" next to "Your memory". Memory is organised as **Topics**; select one to read it, use the edit icon to change it, or "Delete" to remove it. You can also tell Claude in chat what to remember, change or forget. Legacy layout: Settings > Capabilities > "View and manage memory", with a pencil icon for custom instructions. Page says "Updated this week" (late Oct 2026). — [Claude Help Center: memory](https://support.claude.com/en/articles/11817273)
- Per-project memory: each project has its own memory and also uses account memory from non-project chats, but not other projects' memory. Toggle "Use account memory" off on a project to isolate it. Project memory is deleted with the project. — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Incognito (ghost icon): not saved to memory or history, and not searched later. — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Pause keeps memory but stops use and creation. Reset "permanently deletes all memories, including project memories" and "cannot be undone." — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Update cadence: the current experience saves memory "as you chat"; the legacy experience was a summary "updated every 24 hours." — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Provenance: the article does not say entries show their source chat. Citations to original chats appear only when Claude searches past chats. In the current experience, deleting a conversation does **not** remove memory entries generated from it (legacy removed them from the synthesis). No version history is described. — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Import: paste another assistant's memory dump into Settings > Your Claude > "Start import" > "Add to memory". Claude extracts entries and stores them on submit; review happens afterwards in the memory panel. A "See what Claude learned about you" button opens a chat. Labelled "experimental". Export means copying text from the panel or asking Claude to write memories out verbatim; memory entries are included in data exports. No structured export format is documented. "Updated this week." — [Claude Help Center: import/export](https://support.claude.com/en/articles/12123587-importing-and-exporting-your-memory-from-claude)
- A secondary guide describes an "Include sensitive topics in memory" option and Topics with edit and delete icons. Undated. — [Engadget](https://engadget.com/2246397/how-to-edit-claude-memory)

#### Gemini (Google)
- Memory of past chats: a toggle under Personal context (Android article) or Personal Intelligence (newer articles). Requires Keep Activity. To check whether Gemini used past chats: "just ask Gemini, 'Did you use any info from past chats?'" (no UI indicator). To delete something Gemini knows, delete all chats with that info from Gemini Apps Activity; to correct it, correct Gemini in chat. For connected apps you must both delete the chats **and** disconnect the app. Undated. — [Gemini Help: past chats](https://support.google.com/gemini/answer/16598469?hl=en)
- Memory summary (US, active Google AI plan, English, web and mobile): Settings > Personal Intelligence > Memory summary. Use it to "view, edit, and delete what Gemini Apps understands about you." Editing is done by prompts ("Use prompts to update your info"; e.g. "Remove my old phone number from your memory"), and Gemini may ask follow-up questions. **"Memory history"** (top right) lets you "Review the list of changes to find out when specific information was added or modified." Undated. — [Gemini Help: Memory summary](https://support.google.com/gemini/answer/18617127?hl=en)
- Daily brief items can be marked complete, dismissed or rated, and "Check an item's source" opens a popup with the item's source. Undated. — [Gemini Help: daily brief](https://support.google.com/gemini/answer/17077455?hl=en)
- Connected Apps: Gmail, Calendar, Drive, Photos, Wallet, YouTube, Search. Data is used to "create personal insights about you, your relationships"; you choose apps at opt-in and manage them in Connected Apps settings. Undated. — [Gemini Help: Connected Apps](https://support.google.com/gemini/answer/16836988?hl=en); [Gemini Help: connect apps](https://support.google.com/gemini/answer/16598406?hl=en)
- Third-party reports: "Saved info" became "Instructions for Gemini"; "past chats" was renamed "Memory" on 26 Mar 2026; Personal Intelligence launched 14 Jan 2026. Not verified against Google docs. **[STALE?]** — [ai-toolbox](https://www.ai-toolbox.co/gemini-management-and-productivity/gemini-memory-saved-info-2026); [AI Fire](https://www.aifire.co/p/google-gemini-personal-intelligence-2026-setup-privacy-guide)
- Gemini Enterprise (official): "Managed saved memories" > Manage > view; you can delete saved memories or disable their use. — [Google Cloud docs](https://docs.cloud.google.com/gemini/enterprise/docs/personalization)

#### Mem0 OpenMemory (self-hosted MCP memory with a Next.js UI): sunset
- Sunset announced in issue #4923 (22 Apr 2026). Removed from the monorepo on 29 Jul 2026 (PR #6530) and archived read-only at mem0ai/openmemory. "For local self-hosted memory with a dashboard, `server/` ... is the supported path." — [mem0 PR #6530](https://github.com/mem0ai/mem0/pull/6530); [issue #4923](https://github.com/mem0ai/mem0/issues/4923)
- UI as of the last snapshot (commit 2026-06-18), read from source:
  - **Memories table**: columns for memory text, categories, source app, created on. Filters by app and category plus a "show archived" toggle; sort by Memory, App Name or Created On. Row actions: Edit, Pause, Archive, Delete. Paused and archived rows are visually dimmed and tagged. There is a "Create memory" dialog.
  - **Memory detail page**: Edit button and a "Change State" menu (Active, Pause, Archive); an **Access Log** panel listing app and `accessed_at`, with a "Pause Access" button; a "Related memories" panel.
  - **Apps page / app detail**: Access Status, Total Memories Created, Total Memories Accessed, First Accessed, Last Accessed, and a "Pause Access / Unpause Access" toggle.
  — [archived source tree at 1dcee15](https://github.com/mem0ai/mem0/tree/1dcee153b96b396e5f2d77d148fe605c26f4449e/openmemory/ui/app)
- Data model: `MemoryState` = active, paused, archived, deleted (soft, with `archived_at` and `deleted_at`). `MemoryStatusHistory` stores old_state, new_state, changed_by and changed_at. `MemoryAccessLog` stores memory_id, app_id, accessed_at and access_type. `AccessControl` stores subject, object and effect. `ArchivePolicy` stores days_to_archive. — [models.py at 1dcee15](https://github.com/mem0ai/mem0/blob/1dcee153b96b396e5f2d77d148fe605c26f4449e/openmemory/api/app/models.py)
- Trust bug: "MCP Server and Web UI Show Different Memory Content After Updates." **[STALE?, Aug 2025]** — [mem0 #3371](https://github.com/mem0ai/mem0/issues/3371). The UI and API also disagreed on a field name. **[STALE?]** — [mem0 #3331](https://github.com/mem0ai/mem0/issues/3331)

#### Mem0 self-hosted server dashboard (the replacement; last commit 2026-10-05)
- Pages: memories, entities, requests, analytics, api-keys, categories, configuration, export, settings, webhooks. — [mem0 repo tree: server/dashboard](https://github.com/mem0ai/mem0/tree/main/server/dashboard/src/app)
- Memories: a table (Content, User, Agent, Created), a "Filter by User ID" box, Delete with a confirmation modal, and a "Memory Detail" side sheet showing the memory text, id, user_id and agent_id. No edit string found. Entities: type, memories, last active, delete. Requests: an API request log (Time, Method, Path, Status, Latency, Auth = API Key or Admin Key) with Total Requests, Success Rate and Avg Latency. — [memories page](https://github.com/mem0ai/mem0/blob/main/server/dashboard/src/app/(root)/dashboard/memories/page.tsx); [requests page](https://github.com/mem0ai/mem0/blob/main/server/dashboard/src/app/(root)/dashboard/requests/page.tsx)
- The Export page ("Export your memories in JSON, CSV, or Pydantic schema format") and the Categories page render a `LockedPage` in self-hosted mode, so they are Cloud-only. — [export page](https://github.com/mem0ai/mem0/blob/main/server/dashboard/src/app/(root)/dashboard/export/page.tsx)

#### Supermemory
- Memory graph: a React component (`@supermemory/memory-graph`) with documents as rectangles, memories as hexagons, and edges for relationships and similarity. It has a "console" variant with a space selector, uses a Canvas 2D renderer, and supports pan, zoom and drag. Rewritten 30 Dec 2025; an interactive graph app was added to the MCP server on 9 Mar 2026. **[STALE?]** for both changelog dates. The console also has a documents browser for "viewing, filtering, and managing" ingested content. — [Supermemory memory graph docs](https://supermemory.ai/docs/integrations/memory-graph); [Supermemory changelog](https://supermemory.ai/docs/changelog)
- Supersession model: **Updates** means a new fact replaces an old one for search, and "history can remain for audit". **Extends** adds detail and both stay valid. **Derives** means an inferred fact never stated directly. `isLatest` keeps retrieval on the current fact "without erasing the past". Time-based forgetting covers things like "exam tomorrow". Undated. — [Supermemory graph memory](https://supermemory.ai/docs/concepts/graph-memory.md)
- **Review queue**: derived facts are flagged `isInference: true` until someone confirms them. `GET .../inferred` returns up to 50 unreviewed items ordered by `parentCount` ("How many source memories this was derived from. Higher = stronger signal"). Actions are **Approve** (flag cleared), **Decline** (forgotten, removed from search), and **Undo** (returned to the queue; a declined memory is un-forgotten). Undated. — [Supermemory: review inferred memories](https://supermemory.ai/docs/recall/memory-review.md)
- Forgetting: forget by IDs, or "forget by meaning" (`forgetMatching`) with a required `dryRun` preview, then apply exactly the previewed IDs. The docs warn: "keep your own record of `dryRun` next to audit logs." This implies there is no built-in audit trail of forgets. Undated. — [Supermemory memory operations](https://supermemory.ai/docs/recall/memory-operations.md)

#### Letta (formerly MemGPT)
- The original ADE is deprecated and replaced by a new ADE at chat.letta.com. The old ADE's right panel let you "View and edit the persistent knowledge your agent maintains" (core memory blocks), search archival memory, and inspect the context window. Undated. — [Letta ADE overview](https://docs.letta.com/guides/ade/overview)
- Memory is now **MemFS**, a git repository per agent: "Every memory edit is committed to the MemFS git repository. This provides version history, conflict resolution..." Run `/memory` in the CLI or inspect `$MEMORY_DIR` "to review what it saved." Undated. — [Letta MemFS](https://docs.letta.com/concepts/memfs/index.md); [Letta Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)
- Background "dreaming" consolidates memory. The option "Agent reviews before applying" makes a second agent review proposed updates, but "does not ask you for approval." — [Letta Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)
- A competitor's critique says agent self-editing can overwrite a block ("Lives in Boston" becomes "SF") with no record. This predates or ignores MemFS and is vendor-biased. **[ANECDOTAL]** — [EverMind blog](https://evermind.ai/blogs/letta-alternative)

#### Zep / Graphiti
- Facts sit on edges with four timestamps: `created_at` ("when Zep learned..."), `valid_at` (when it became true), `invalid_at` (when it stopped being true), and `expired_at` (when Zep learned it stopped). Facts are "extracted from one or more episodes." The context block renders ranges such as "(2024-11-14 02:03:58+00:00 - present)". `valid_at` and `invalid_at` do not by themselves establish that a fact is true. Undated. — [Zep help: facts](https://help.getzep.com/facts)
- Changelog, 13 Jul 2026: more accurate validity dates (no longer dating future plans into the future, and no longer invalidating facts on soft deadlines). Dashboard URLs now use Zep-generated IDs. — [Zep changelog 2026-07-13](https://help.getzep.com/changelog/2026/7/13)
- The dashboard has a graph visualizer. Its assistant is **read-only**, can find "the source episodes behind a fact", and highlights cited nodes and facts on the canvas. Limited rollout. Undated. — [Zep graph visualizer assistant](https://help.getzep.com/graph-visualizer-assistant)
- The Graphiti README (repo pushed 2026-10-28) says: Zep offers a "Dashboard with graph visualization, debug logs, API logs", while Graphiti says "Build your own tools". Episodes are "(provenance)... Every derived fact traces back here". Its example fact format is "Kendra loves Adidas shoes (as of March 2026)." — [getzep/graphiti README](https://github.com/getzep/graphiti)

### Inferences
- `mem` already has the data that the products above only partly expose (validity interval, recorded-at, provenance episode ids, writer, extractor model, status, supersession links, audit log, erasure receipts). The GUI's job is mostly to show it, not to invent new concepts.
- The closest structural precedent for each v1 screen:
  - **facts list**: OpenMemory's memories table (filters by app and category, state badges, row actions)
  - **as-of search**: Zep's "(date - present)" ranges and Graphiti's "(as of March 2026)"
  - **confirm / dispute**: Supermemory's approve / decline / undo
  - **history**: Gemini's "Memory history" change list plus Letta's git history
  - **audit log**: OpenMemory's per-memory Access Log and per-app stats
  - **export and erase**: nobody does this well. Claude's export is copy-paste, and mem0's self-hosted export is locked.
- `mem` is single-user, so OpenMemory's per-app "Pause Access" maps to per-writer or per-client controls rather than multi-user ACLs.

### Gaps
- I could not read help.openai.com directly (403), so exact current ChatGPT controls (summary edit mechanics, whether search and sort survived the June 2026 auto-update, project-memory UI) rest on search snippets.
- I found no official screenshot or description of ChatGPT's or Claude's per-entry metadata (dates, source chat) in the memory list.
- The new Letta ADE (chat.letta.com) UI for viewing MemFS history or diffs is undocumented in what I read. It is unknown whether the web app shows commit history.
- The Supermemory console UI for the review queue and for update chains (whether the console shows "updates" history) is undocumented. Only the API is documented.
- Zep's dashboard rendering of `valid_at` / `invalid_at` (e.g. greyed-out invalid edges, a time filter) is not described in the docs I read.
- I did not verify whether OpenMemory's UI rendered `MemoryStatusHistory`; it exists in the data model.
- Gemini's "Instructions for Gemini" (formerly Saved info) article (answer 16598625) was not read.

## Key Question 2: What do users and reviewers complain about or praise in these UIs?

### Takeaway
The dominant complaints are surprise and context-collapse (memories applied where they don't belong), stale or wrong memories that users cannot easily see or fix, lack of control over what is stored or used, and deletion that doesn't really delete (or UI and storage disagreeing). Praise centres on being able to inspect and edit, and on scoped (project-only) memory. Most sentiment evidence is from 2025 and anecdotal.

### Cited Findings
- Simon Willison objected that ChatGPT's chat-history memory builds a "dossier" injected into every conversation without explicit permission or a way to manage it. It added a "Half Moon Bay" sign to an unrelated image and contaminated an experiment. He had to extract the hidden profile by asking for it as JSON. He wanted per-project scoping, which OpenAI shipped in Aug 2025. **[STALE?, May 2025] [ANECDOTAL]** — [Simon Willison](https://simonwillison.net/2025/May/21/chatgpt-new-memory/)
- Axios: a reporter got an image with a wedding ring although they were no longer married. Memory "can lead to awkward or even insensitive results, since you can never be sure exactly what the AI does or doesn't know about you." **[STALE?, Jul 2025]** — [Axios](https://www.axios.com/2025/07/11/chatgpt-memory-update)
- OpenAI community bug threads: memory entries persisting or duplicating after delete, memory wiped unexpectedly, "new memory feature is not very good". **[STALE?, 2024–2025] [ANECDOTAL]** — [community.openai.com: memory broken](https://community.openai.com/t/chatgpt-memory-broken-at-the-moment/1108272); [cleared by itself](https://community.openai.com/t/chatgpt-memory-has-been-cleared-by-itself/780857); [not very good](https://community.openai.com/t/new-memory-feature-is-not-very-good/935802)
- "Memory full" was a known pain point, addressed by auto-management in Oct 2025. **[STALE?]** — [AlternativeTo](https://alternativeto.net/news/2025/10/chatgpt-enhances-memory-management-for-plus-and-pro-users)
- HN comments on Claude and Claude Code memory **[ANECDOTAL; dates mixed 2025–2026]**:
  - memory pulls in "obsolete info that muddies the waters" — [HN 48777419](https://news.ycombinator.com/item?id=48777419)
  - remembering previous hallucinations and bringing them back; turned memory off — [HN 48917293](https://news.ycombinator.com/item?id=48917293)
  - "isn't really 'remembering' anything", just search over history — [HN 49380281](https://news.ycombinator.com/item?id=49380281)
  - little control over what is stored or when it is used, and some praise ("love" the implementation; flat markdown memory files "work better than you'd expect"). These come from a search summary of HN results. I did not verify which comment is in which thread, so the two threads below are where they likely appear, not confirmed locations: [HN: Claude Memory thread (c. Oct 2025)](https://news.ycombinator.com/item?id=45684134); [HN: Claude's memory architecture is the opposite of ChatGPT's (c. Sep 2025)](https://news.ycombinator.com/item?id=45214908) **[STALE?]**
- Privacy: a widely shared post on tricking Claude into leaking remembered "secrets". — [HN 48916975](https://news.ycombinator.com/item?id=48916975) **[ANECDOTAL]**
- Built-in trust caveats in official docs:
  - ChatGPT's summary "does not necessarily include every detail or source that Memory can reference" — [OpenAI Memory FAQ (snippet)](https://help.openai.com/en/articles/8983136-what-is-memory)
  - in Claude's current experience, deleting a chat doesn't remove memory derived from it — [Claude Help Center](https://support.claude.com/en/articles/11817273)
  - Gemini says forgetting requires deleting every chat containing the info, and disconnecting apps — [Gemini Help](https://support.google.com/gemini/answer/16598469?hl=en)
- OpenMemory self-hosters hit "MCP Server and Web UI Show Different Memory Content After Updates" — [mem0 #3371](https://github.com/mem0ai/mem0/issues/3371) **[STALE?]**. They also hit stacked self-hosting regressions (May 2026) — [mem0 #5275](https://github.com/mem0ai/mem0/issues/5275). The product was then sunset ([mem0 PR #6530](https://github.com/mem0ai/mem0/pull/6530)).
- A Gemini user explains keeping "Personal Intelligence" off despite repeated prompts to enable it (undated in results). **[ANECDOTAL]** — [Android Central](https://www.androidcentral.com/apps-software/ai/gemini-keeps-asking-me-to-turn-on-personal-intelligence-but-im-keeping-it-off-sort-of)

### Inferences
- "Surprise" is the core failure: users learn what the memory believes only when it misfires. `mem`'s GUI should make the belief state inspectable *before* it is used, with provenance one click away, and should make "where did this come from" answerable without asking the model (unlike Gemini's "just ask Gemini").
- Deletion that leaves derived facts behind (Claude current, ChatGPT and Gemini multi-place deletion) erodes trust. `mem`'s erasure with receipts, cascading from episodes to the facts derived from them, is a differentiator worth surfacing visibly: show what will be removed, then show a receipt.
- UI and store drift (OpenMemory #3371) suggests the GUI should read through the same API and audit path as MCP clients, and show "last refreshed" state.

### Gaps
- I found little 2026-dated, high-quality user research on memory UIs. Most sentiment is 2025 and anecdotal. Reddit threads did not surface in searches.
- I found no reviews of Supermemory's console, Zep's dashboard or Letta's new ADE from end users, as opposed to vendors or developers.

## Key Question 3: Good examples of UIs for bi-temporal or versioned data that fit "what replaced what"

### Takeaway
No AI memory product ships a polished as-of time-travel UI. The best references are: Gemini's "Memory history" change list (when added or modified); Zep's and Graphiti's "valid from – to / present" range notation with episode provenance; Supermemory's updates/extends/derives relation types with `isLatest`; Letta's git-backed history; generic version-history UIs (Notion page history with restore and snapshot diffs); and bitemporal visualizers that plot valid time against transaction time on a 2D chart.

### Cited Findings
- Gemini: "Memory history" lets you "Review the list of changes to find out when specific information was added or modified." — [Gemini Help: Memory summary](https://support.google.com/gemini/answer/18617127?hl=en)
- Zep renders fact validity as "(start – present)" ranges in its context block and separates "when it was true" (`valid_at` / `invalid_at`) from "when Zep learned it" (`created_at` / `expired_at`). — [Zep help: facts](https://help.getzep.com/facts)
- Graphiti: "each fact ... has a validity window: when it became true, and when (if ever) it was superseded", with "full temporal history" and episodes as provenance. — [Graphiti README](https://github.com/getzep/graphiti)
- Supermemory: Updates (replace for search, history kept for audit), Extends (both valid), Derives (inferred), and `isLatest`. — [Supermemory graph memory](https://supermemory.ai/docs/concepts/graph-memory.md)
- Letta MemFS: every memory edit is a git commit, which gives version history. — [Letta MemFS](https://docs.letta.com/concepts/memfs/index.md)
- Notion page history: open the "..." menu, then "Page history"; pick a version and click "Restore". A newer "snapshot diffs" feature compares any two snapshots, with the diff appearing when two are selected. Third-party sources, undated, not confirmed on Notion's help centre. — [Super.so guide](https://super.so/blog/how-to-check-notion-page-history-and-restore-versions); [CreateWith: Notion snapshot diffs](https://www.createwith.com/tool/notion/updates/notion-adds-snapshot-diffs-to-version-history-for-easier-change-tracking)
- bitempura-viz "visualize[s] the 2D valid time and transaction time history" of bitemporal records. Its author notes this Snodgrass-style 2D chart is underused. Repo active Sept 2026. — [elh/bitempura-viz](https://github.com/elh/bitempura-viz)
- A bitemporal explorer spec uses a 2D grid (valid time × transaction time) with two crosshair sliders. The result at their intersection is the as-of answer. Undated. — [Bitemporal explorer MicroSim](https://dmccreary.github.io/context-graph/sims/bitemporal-explorer/)
- XTDB has written on DIY bitemporality as a design problem (not read in full). — [XTDB blog](https://www.xtdb.com/blog/diy-bitemporality-challenge)

### Inferences
- For "what replaced what", a per-fact vertical **history timeline** is the most transferable pattern. It mirrors Gemini's change list and Notion's version list, and each node shows: the value, the valid-from/to range, recorded-at, writer and model, status changes (confirmed/disputed), and the episode quote that caused it. The superseding fact links forward and the superseded fact links back, like Supermemory's `updates` relation.
- Use a single "as of" date picker in v1 (it answers "what did memory believe on date X"). A 2D valid-time × recorded-time view (bitempura-viz style) is a power-user polish item. Keep the two times visually distinct, following Zep's "true when" vs "learned when" split.
- Represent current vs superseded facts the way `isLatest` does: the current fact is shown by default, with superseded facts behind a "show history" toggle (cf. OpenMemory's "show archived" filter).
- A diff view (Notion snapshot diffs, git) suits corrections where the text changed. Highlight old vs new value side by side.

### Gaps
- No primary-source screenshots of Zep's dashboard showing invalidated edges.
- No first-party Notion help page was retrieved.
- I did not survey Git GUIs (blame and history views) or Datomic/XTDB consoles in depth.

## Key Question 4: Which patterns build trust (source quotes, confidence, which app wrote it, review queue, undo), and what concrete UI patterns should `mem` copy or avoid?

### Takeaway
The trust-building patterns that exist in shipping products are:
- per-response "what was used" (ChatGPT book icon)
- per-item "check source" (Gemini daily brief)
- source app and access log per memory (OpenMemory)
- a review queue ordered by evidence strength, with approve/decline/**undo** (Supermemory)
- dry-run preview before semantic deletion (Supermemory)
- reversible states (pause/archive) instead of only hard delete (OpenMemory)
- git-style history (Letta)

The anti-patterns are: lossy summaries, edit-only-by-prompting, irreversible resets, deletion that leaves derived data, locked export, and asking the model to self-report what it used.

### Cited Findings
- Per-response provenance: ChatGPT's book icon shows custom instructions, past chats, files and memories used for a response. — [OpenAI Memory FAQ (snippet)](https://help.openai.com/en/articles/8983136-what-is-memory)
- Per-item source: Gemini daily brief has "Check an item's source" in a popup, plus mark complete, dismiss and feedback controls. — [Gemini Help: daily brief](https://support.google.com/gemini/answer/17077455?hl=en)
- Which app wrote or read it: OpenMemory shows a source app per memory, a per-memory Access Log, and per-app "Total Memories Created / Accessed, First / Last Accessed" with "Pause Access". — [OpenMemory UI source](https://github.com/mem0ai/mem0/tree/1dcee153b96b396e5f2d77d148fe605c26f4449e/openmemory/ui/app)
- Confidence or evidence strength: Supermemory's review queue is ordered by `parentCount` ("Higher = stronger signal") and marks guesses with `isInference`. — [Supermemory memory review](https://supermemory.ai/docs/recall/memory-review.md)
- Review plus undo: Approve / Decline / Undo, where Undo "un-forgets a declined memory". — [Supermemory memory review](https://supermemory.ai/docs/recall/memory-review.md)
- Preview before destructive bulk action: `forgetMatching` requires `dryRun`; apply the exact previewed IDs to avoid drift. — [Supermemory memory operations](https://supermemory.ai/docs/recall/memory-operations.md)
- Reversible states: OpenMemory's active / paused / archived / deleted states with timestamps and a state-change history table. — [OpenMemory models.py](https://github.com/mem0ai/mem0/blob/1dcee153b96b396e5f2d77d148fe605c26f4449e/openmemory/api/app/models.py)
- Version history: Letta commits every memory edit to git. — [Letta MemFS](https://docs.letta.com/concepts/memfs/index.md)
- Agent-side review is not user review: Letta's "Agent reviews before applying ... does not ask you for approval." — [Letta Memory & dreaming](https://docs.letta.com/configuration/memory/index.md)
- Import without a review step: Claude stores imported entries on submit, with review only afterwards. — [Claude import/export](https://support.claude.com/en/articles/12123587-importing-and-exporting-your-memory-from-claude)
- Irreversible reset: Claude's Reset "cannot be undone." — [Claude Help Center](https://support.claude.com/en/articles/11817273)
- Model self-report instead of UI: Gemini says to "just ask Gemini" whether past chats were used. — [Gemini Help](https://support.google.com/gemini/answer/16598469?hl=en)
- Edit only via prompts: Gemini's memory summary edits run through prompts, not direct field edits. — [Gemini Help: Memory summary](https://support.google.com/gemini/answer/18617127?hl=en)
- Locked export in self-hosted: the mem0 server's Export page is a `LockedPage`. — [mem0 export page](https://github.com/mem0ai/mem0/blob/main/server/dashboard/src/app/(root)/dashboard/export/page.tsx)
- A read-only graph assistant that cites source episodes and highlights them on the canvas (Zep) is a model for "explain this fact" without risking edits. — [Zep graph visualizer assistant](https://help.getzep.com/graph-visualizer-assistant)
- Temporal fields don't equal truth: Zep warns that `valid_at` / `invalid_at` do not establish that a fact is true. Show status (confirmed/disputed) separately from validity. — [Zep help: facts](https://help.getzep.com/facts)

### Inferences

#### Patterns worth copying (minimum GUI first, polish later)
1. **v1: facts table with state badges and filters.** Columns for statement, status (asserted / confirmed / disputed), valid from–to (or "present"), recorded-at, writer, and a source-episode count. Filters: status, writer/client, bank, "include superseded" (cf. OpenMemory filters and the "show archived" toggle; Supermemory `isLatest`).
2. **v1: fact detail drawer with provenance.** Show the verbatim source-episode quote(s) with links to the episode, plus extractor model and writer (cf. Zep's source episodes, Gemini's "check source", ChatGPT's book icon). Answer "where did this come from" from data, never by asking the model.
3. **v1: confirm / dispute / correct inline, with undo.** Use toast-level undo after each action (Supermemory Undo). "Correct" creates a superseding fact rather than editing in place, and the old fact shows as superseded.
4. **v1: per-fact history timeline.** Show the supersession chain with both time axes labelled separately ("true from/to" vs "recorded at"), plus status changes (Gemini Memory history, Zep's four timestamps, Notion version list).
5. **v1: "as of" date picker on search.** Results show what was believed on that date, with a banner "Viewing memory as of 2026-03-01" and a one-click return to now.
6. **v1: audit log view.** Filter by client or writer, operation (read/write), and fact or episode. Add a per-fact "accessed by" panel (OpenMemory Access Log) and per-client summary cards (created / accessed counts, first / last seen).
7. **v1: erase with preview and receipt.** Dry-run listing the episodes and derived facts to be removed (Supermemory dryRun), explicit confirmation, then a downloadable receipt. Make the cascade to derived facts explicit, the opposite of Claude's leftover-memory behaviour.
8. **v1: export as a first-class, unlocked button** per bank (JSONL / Markdown), the opposite of mem0's locked export and Claude's copy-paste.
9. **Polish: review queue for newly extracted facts.** Order by evidence (number of source episodes, extractor confidence if available), with approve / dispute / undo (Supermemory's queue). Optionally hold low-evidence facts as "asserted, unreviewed".
10. **Polish: graph or 2D bitemporal view, and side-by-side diff for corrections** (Supermemory graph, Zep visualizer, bitempura-viz, Notion snapshot diffs).
11. **Polish: per-client pause** (OpenMemory "Pause Access") and per-response "what memory was used" in clients.

#### Mistakes to avoid
- A lossy prose summary as the primary view (ChatGPT and Claude legacy summaries are admitted to be incomplete). Show the actual fact records.
- Edit only through chat prompts (Gemini). Provide direct controls.
- Irreversible bulk reset without preview or receipt (Claude Reset).
- Deleting a source without handling derived facts (Claude current experience), or scattering deletion across many places (ChatGPT, Gemini).
- Relying on the model to say what it used (Gemini "just ask").
- Imports or agent self-reviews that commit without owner review (Claude import, Letta "Agent reviews").
- UI and store drift (OpenMemory #3371) and locked export (mem0 self-hosted).

### Gaps
- No product shows extractor-model or confidence scores to end users. Supermemory's `parentCount` is the closest. No user evidence was found on whether showing confidence raises or lowers trust.
- No quantitative data on review-queue fatigue, i.e. how many facts per day a user will actually review.
- I found no product with a hash-chained or tamper-evident audit log UI to borrow from. `mem`'s chain verification display will need its own design.

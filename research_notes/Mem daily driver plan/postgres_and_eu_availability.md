# Hosted Postgres for mem on Vercel, and what living in the EU changes

Research date: 2026-10-29. Web only, no code changes.

How dates are shown: "page date" is a date printed on the page. "read" is the day I fetched it. Most vendor docs and pricing pages print no date. For those, the read date (2026-10-29) is the only date there is. Lines marked **inference** are my reasoning and do not come from a source.

Context: mem runs Postgres 17 with pgvector (HNSW, 1536 dims) through `pg`. It uses `FOR UPDATE SKIP LOCKED` and `pg_advisory_xact_lock`. The migration runner also takes a session-level `pg_advisory_lock`. One person's data, under 1 GB for years. Tim is in the EU and wants to deploy on Vercel.

---

## Part A: hosted Postgres

### 1. Neon Free plan today

| Fact | Value | Source (date) |
|---|---|---|
| Storage | 1 GB of Postgres storage per project, 20 GB total across all projects | https://neon.com/docs/introduction/plans (no page date; read 2026-10-29); https://neon.com/pricing (no page date; read 2026-10-29) |
| Storage raised recently | Changed from 0.5 GB to 1 GB per project | https://neon.com/docs/changelog (entry dated 2026-10-02) |
| Compute | 100 CU-hours per project per month | plans doc; pricing page |
| Minimum compute | 0.25 CU (about 1 GB RAM) is "the default compute size for Free plan projects". Autoscaling can go up to 2 CU (8 GB RAM) on Free | pricing page FAQ; plans doc |
| Wall-clock hours | "At 0.25 CU, 100 CU-hours covers about 400 hours of active compute, more than half the hours in a month." At the 2 CU ceiling it would be 50 hours | pricing page FAQ; plans doc ("enough to run a 0.25 CU compute in a project for 400 hours/month") |
| Autosuspend | 5 minutes of inactivity. Always on and cannot be disabled on Free | https://neon.com/docs/introduction/scale-to-zero (no page date; read 2026-10-29); plans doc |
| Cold start after suspend | "Activation generally takes a few hundred milliseconds." Slightly longer if the project has been idle for more than 7 days. The first queries are slower because buffers are cold | https://neon.com/docs/introduction/compute-lifecycle (no page date; read 2026-10-29) |
| Session state on suspend | Connections close. Session settings, temp tables, prepared statements, advisory locks and LISTEN/NOTIFY are lost | compute-lifecycle doc |
| Point-in-time restore | 6 hours, capped at 1 GB-month of change history, no charge. 1 manual snapshot. Scheduled backups are paid only | plans doc ("Free: No charge, 6-hour limit, capped at 1 GB of change history") |
| Egress | 5 GB public network transfer per project per month | plans doc |
| Projects, branches | 100 projects, 10 branches per project | plans doc |
| When a limit is hit | "When you run out of CU-hours or public network transfer, your compute is suspended until the next billing period or until you upgrade." Over the storage cap, "inserts, updates, and deletes" fail until space is freed or you upgrade. "None of these limits delete your data." | plans doc FAQ "What happens if I exceed my Free plan limits?" |
| Inactivity deletion | Only Free projects in the deprecated Azure regions that have been inactive 90+ days face deletion (from 2026-10-05). I found no inactivity deletion rule for AWS regions | https://neon.com/docs/introduction/regions (read 2026-10-29) |

**Inference for mem:** anything that queries the database more often than every 5 minutes keeps the compute awake. Examples are a cron job, a health check, or a job-queue poll. Kept awake all month at 0.25 CU, the compute uses about 182.5 CU-hours (730 h × 0.25). That is more than the 100 included, so it would be suspended around day 16. On Free, mem must let the database idle: no frequent cron polling or uptime pings that touch Postgres. Set the compute's autoscaling maximum to 0.25 CU so a heavy query cannot burn hours at 1–2 CU. With real personal use (bursts plus a 5-minute tail), usage should be well under 100 CU-hours. For example, 4 awake hours a day at 0.25 CU is about 30 CU-hours a month.

**Inference:** on Free, the 1 GB per project includes indexes. A 1536-dim `vector` is about 6 KB, and the HNSW index adds a similar amount again. That puts the ceiling somewhere in the tens of thousands of facts. It is fine for years at personal scale, but it is a hard stop for writes rather than a bill.

### 2. Neon regions

| Fact | Source (date) |
|---|---|
| AWS regions: us-east-1, us-east-2, us-west-2, **eu-central-1 (Frankfurt)**, eu-west-2 (London, which is in the UK and not the EU), ap-southeast-1, ap-southeast-2, sa-east-1 | https://neon.com/docs/introduction/regions (NAT IP list on that page "last updated October 7, 2026"; read 2026-10-29) |
| Frankfurt is the only EU-member-state region. Azure regions (including `azure-gwc`) are deprecated and new projects can't be created there | regions doc |
| "You can create a project in any region listed above." No plan restriction is stated for Postgres, so a Free project can pick Frankfurt. Only the AI Gateway needs a paid plan | regions doc |
| The region is fixed at creation and cannot be changed later (you would migrate to a new project) | regions doc |
| Neon's install form on Vercel offers regions `cle1, iad1, pdx1, fra1, lhr1, syd1, sin1, gru1`, so Frankfurt can be picked there too | https://vercel.com/marketplace/neon (install schema embedded in the page; read 2026-10-29) |
| Vercel Functions run in `iad1` (Washington, D.C.) by default for new projects. Hobby gets one function region, so set it to `fra1` to sit next to Neon Frankfurt | https://vercel.com/docs/functions/configuring-functions/region (page date `last_updated: 2026-08-11`) |

### 3. Neon pgvector

| Fact | Source (date) |
|---|---|
| `vector` version by Postgres major: PG14–PG17 **0.8.0**, PG18 **0.8.6**. Install with `CREATE EXTENSION vector;` | https://neon.com/docs/extensions/pg-extensions (no page date; read 2026-10-29) |
| HNSW is supported. HNSW dimension limits: `vector` up to 2,000, `halfvec` up to 4,000. So 1536-dim `vector` HNSW works | https://neon.com/docs/extensions/pgvector (no page date; read 2026-10-29) |
| `maintenance_work_mem` defaults by compute size. If the graph does not fit, the build slows with a NOTICE. `max_parallel_maintenance_workers` defaults to 2 | pgvector doc |
| Postgres 17.11 and 18.6 became available on Neon on 2026-08-18 | https://neon.com/docs/changelog (entry 2026-08-28) |
| The changelog also mentions a separate `lakebase_vector` extension. mem does not need it | changelog (2026-08-21, 2026-09-25 entries) |

### 4. Neon connection pooling

| Fact | Source (date) |
|---|---|
| PgBouncer in **transaction mode** (`pool_mode=transaction`) | https://neon.com/docs/connect/connection-pooling (no page date; read 2026-10-29) |
| Unsupported on pooled connections: `SET`/`RESET`, `LISTEN`/`NOTIFY`, `WITH HOLD CURSOR`, SQL-level `PREPARE`/`DEALLOCATE`, temp tables with `PRESERVE/DELETE ROWS`, `LOAD`, **session-level advisory locks** | pooling doc; matches PgBouncer's own feature map https://www.pgbouncer.org/features.html (no table date; read 2026-10-29) |
| Protocol-level prepared statements **are** supported (PgBouncer 1.22+, `max_prepared_statements=1000`). SQL `PREPARE`/`EXECUTE` are not | pooling doc |
| A `SET search_path` is lost on the next transaction. The fixes are a direct connection, schema-qualified names, or `ALTER ROLE ... SET` | pooling doc |
| The direct string is always there: "The pooled endpoint is always available. The toggle just switches the displayed connection string between the pooled hostname (with the `-pooler` suffix) and the direct hostname." Neon recommends direct connections for migrations and `pg_dump` | pooling doc |
| The Vercel integration injects `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct), plus `PGHOST_UNPOOLED` and similar | https://neon.com/docs/guides/vercel-managed-integration (no page date; read 2026-10-29) |
| Limits: `max_client_conn` 10,000. `default_pool_size` is 90% of `max_connections` (`max_connections` is 104 at 0.25 CU). Queue wait timeout 120 s. Not configurable | pooling doc |

**Inference for mem:**
- `FOR UPDATE SKIP LOCKED` and `pg_advisory_xact_lock` live inside one transaction, so they work on the pooled URL.
- The migration runner's session-level `pg_advisory_lock` must use `DATABASE_URL_UNPOOLED`.
- Per-query tuning such as `hnsw.ef_search` should be `SET LOCAL` inside the transaction, or set at role level, not a plain `SET`.
- node-postgres only uses protocol-level prepared statements when a query has a `name`, and those are supported.

### 5. Neon on the Vercel Marketplace

| Fact | Source (date) |
|---|---|
| "Vercel Postgres is no longer available." Existing stores were moved to Neon in December 2024. New projects install a Postgres integration from the Marketplace | https://vercel.com/docs/postgres (page date `last_updated: 2026-01-13`) |
| Neon is the provider that replaced Vercel Postgres. It is now one of five native Postgres integrations on the Marketplace: Neon, Amazon Aurora PostgreSQL, Supabase, Nile, Prisma Postgres | https://vercel.com/marketplace?category=storage&search=postgres (read 2026-10-29) |
| Billing: the **Vercel-Managed** integration ("Create New Neon Account") routes "all billing through your Vercel invoice". The Neon-Managed integration (link an existing Neon account) bills through Neon | https://neon.com/docs/guides/vercel-managed-integration; https://neon.com/docs/guides/vercel-overview (no page dates; read 2026-10-29) |
| Plans in the Vercel flow: "Configuration and Plan" lets you choose a region and then "pick a plan". The listing says "Plans starting at $0" and "Free plan with generous quotas". Plan changes apply to **all** databases in the installation | Neon Vercel-managed doc; Vercel Neon listing (read 2026-10-29) |
| Region choice: yes. The install form includes `fra1` | Vercel Neon listing install schema (read 2026-10-29) |
| Whether Free limits are identical: the current Neon and Vercel pages do **not** say so. Older Neon docs (pre-2026, surfaced by search) said Vercel-created accounts get "the same features and Neon pricing plans" as direct sign-ups | search result for neon.tech/docs/guides/vercel-native-integration (older version; read 2026-10-29). Not confirmed on current pages |
| Vercel-managed limits: no `neon login` (use an API key), no Neon project transfer in or out, members map from Vercel roles, and plan or compute changes are made in the Vercel dashboard | Neon Vercel-managed doc |
| Branding: Neon now calls the database "Lakebase Postgres" (Vercel listing: "built to scale on Lakebase Postgres") | Vercel Neon listing; Neon docs |

### 6. Neon's cheapest paid plan (Launch)

| Fact | Source (date) |
|---|---|
| Pay for what you use, with **no monthly minimum**. Invoices under $0.50 aren't collected | plans doc; pricing page |
| Compute **$0.106 per CU-hour**. Storage **$0.35 per GB-month** | pricing page; plans doc |
| Instant restore (PITR) history **up to 7 days** (default 1 day on paid plans), billed **$0.20 per GB-month** of change history. 100 manual snapshots. Scheduled daily/weekly/monthly backups at $0.09/GB-month | pricing page; plans doc |
| Scale to zero after 5 min, **can be disabled** on Launch. Scale (the next tier, $0.222/CU-hour) makes it configurable from 1 minute to always on, with 30 days of history | plans doc; https://neon.com/docs/introduction/scale-to-zero |
| Always-on floor: "the minimum CU-hours a database can use in a month is about 182.5 (about 730 hours in a month × 0.25 minimum CU size)" | pricing page FAQ ("Low load" example) |
| Neon's "typical spend" for Launch is $15/mo, based on 140 CU-hours and 1 GB | pricing page |
| Spending limits were renamed to spending notifications (alerts at 80% and 100%), so there is no hard cap on Launch | https://neon.com/docs/changelog (entry 2026-07-31) |

**Realistic cost for mem (inference from the prices above):**
- **Always on** at 0.25 CU: 182.5 × $0.106 = $19.35 compute, plus about $0.35 for 1 GB of storage, plus a few cents of restore history. **About $20 a month.**
- **Launch with scale-to-zero left on:** you pay for the awake time only. Light personal use (20–60 CU-hours) comes to about **$2–7 a month**, with a 7-day restore window. That is the cheapest way to get real backups on Neon.

### 7. Supabase as an alternative

| Fact | Source (date) |
|---|---|
| Free: 500 MB database size per project, shared CPU with 500 MB RAM, 5 GB egress, **limit of 2 active projects** | https://supabase.com/pricing (no page date; read 2026-10-29) |
| Pause rule: "Free projects are paused after 1 week of inactivity." Paid projects can't be paused. A paused project can be restored from the dashboard within a 1-year window. After that you can download the backup | pricing page; https://supabase.com/docs/guides/platform/upgrading (read 2026-10-29) |
| Backups on Free: "Automatic backups: Not included in free". No PITR. Supabase recommends Free projects export regularly with `supabase db dump` | pricing page; https://supabase.com/docs/guides/platform/backups (read 2026-10-29) |
| EU regions: Frankfurt `eu-central-1`, Ireland `eu-west-1`, Paris `eu-west-3`, Stockholm `eu-north-1`. London and Zurich exist but are outside the EU. The "Europe" general region "includes London and Zurich", so pick a specific region for EU residency | https://supabase.com/docs/guides/platform/regions (read 2026-10-29) |
| pgvector is supported (`create extension vector`), with HNSW index docs | https://supabase.com/docs/guides/database/extensions/pgvector; https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes (read 2026-10-29) |
| Postgres 17 is the platform default for new projects (search summary of a Supabase changelog entry). Postgres 14 support ended 2026-07-01 | https://supabase.com/changelog/45827-deprecation-notice-support-for-postgres-14-ending-on-1st-july-2026 (via search, 2026-10-29) |
| Connections: the shared pooler (Supavisor) is IPv4. Transaction mode on port 6543 is for serverless and "doesn't support prepared statements". Session mode is on port 5432. Direct connections are IPv6 unless you buy the IPv4 add-on (Pro+) | https://supabase.com/docs/guides/database/connecting-to-postgres (read 2026-10-29) |
| On the Vercel Marketplace as a native integration. The region list includes `fra1`, `dub1`, `cdg1`, `arn1` (plus `lhr1` and Zurich) | https://vercel.com/marketplace/supabase (install schema; read 2026-10-29) |
| **Cheapest paid: Pro, from $25/month.** It includes $10 of compute credits ("enough to cover one Micro instance": shared CPU, 1 GB RAM, 60 direct / 200 pooler connections), 8 GB disk per project then $0.125/GB, 250 GB egress, daily backups kept 7 days, and no pausing. PITR is an add-on at $100/month per 7 days of retention | pricing page |

**Inference for mem:**
- On Free, a week without any request pauses the database, and it needs a manual restore. A vacation could take mem offline.
- On Free, the IPv6-only direct connection means the migration runner's session lock would go through the IPv4 shared pooler in session mode.
- The app's pooled traffic must turn off named prepared statements in transaction mode.

### 8. Other Vercel Marketplace Postgres providers (pgvector confirmed only)

- **Prisma Postgres:** pgvector confirmed ("Prisma Postgres supports standard PostgreSQL extensions", example `CREATE EXTENSION IF NOT EXISTS vector;`; https://www.prisma.io/docs/postgres/database/postgres-extensions, read 2026-10-29). Free plan: 200k operations/month, 2 GB, 50 databases, no backups (Starter at $10/mo adds 7-day daily backups; https://www.prisma.io/pricing, read 2026-10-29). EU regions: Frankfurt and Paris according to prisma.io pages, but this came from a search summary and I did not read the region page directly. Usage is metered per operation (every query counts).
- **Nile:** pgvector 0.8.0 "out of the box", with HNSW and IVFFlat (https://thenile.dev/docs/extensions/vector.md, read 2026-10-29). Its API region enum lists `AWS_EU_CENTRAL_1` (https://thenile.dev/docs/api-reference/databases/list-available-regions.md). Free: 1 GB, 50M query tokens, "the db never pauses". Pro is $15/mo (https://www.thenile.dev/pricing, read 2026-10-29). It is built around tenant-aware tables, which mem does not need.
- **Amazon Aurora PostgreSQL** (listed): the free side is $100 of AWS credits for 6 months, billed by AWS and not Vercel. That is not a lasting free tier. The Vercel page does not mention pgvector, so it is skipped.
- **Xata:** not among the Postgres integrations on the Vercel Marketplace as of 2026-10-29.

---

### 7b. Supabase details checked by the coordinator (2026-10-29)

| Fact | Source (read date) |
|---|---|
| Serverless functions should use "Shared pooler, transaction mode", because "These environments open many short-lived connections." The shared pooler "is IPv4-only on every plan" | https://supabase.com/docs/guides/database/connecting-to-postgres (read 2026-10-29) |
| Port 5432 reaches a direct connection or the shared pooler in session mode; port 6543 reaches the pooler in transaction mode | same |
| Transaction mode loses session-level state between transactions: `set`/`reset`, session-level advisory locks, `listen`/`notify`, temporary tables. Cursors work only inside one transaction. Prepared statements are not supported, and query pipelining is not supported | same |
| Inactivity: a Free project is paused when it "does not receive sufficient user database activity over the past week". "A few user requests to the database each day" is typically enough. The page does not say whether scheduled or automated queries count | https://supabase.com/docs/guides/platform/project-pausing (read 2026-10-29) |
| Owners get a warning email about a week before the pause and a confirmation after it. A paused project can be resumed from the dashboard for up to 1 year, with data and configuration | same |
| Supabase Cron jobs can run "anywhere from every second to once a year" and can make HTTP requests. The page does not say whether Cron is on the Free plan, and its only HTTP example calls a Supabase Edge Function | https://supabase.com/docs/guides/cron (read 2026-10-29) |

## Part B: what the EU changes for consumer AI apps

### 9. ChatGPT custom MCP connectors

| Fact | Source (date) |
|---|---|
| Setup: chatgpt.com/plugins → "+" → **Add custom MCP server** → **Create as a plugin**. "ChatGPT supports both read and write tools from your server." Access: "Use ChatGPT on the web." Write actions need confirmation by default. Tools without `readOnlyHint` are treated as writes. SSE and streaming HTTP. OAuth, no-auth, or mixed | https://developers.openai.com/api/docs/guides/custom-mcp-server (no page date; read 2026-10-29) |
| The developer docs and learn.chatgpt.com give **no plan or region eligibility**. They only say workspace permissions and security restrictions apply | same page; https://developers.openai.com/plugins/deploy/connect-chatgpt.md; https://learn.chatgpt.com/docs/extend/mcp.md (read 2026-10-29) |
| Plan eligibility (official help center article, which returns 403 to automated reads, so this comes from search-engine excerpts only): "Custom MCP server connections and full MCP support are available for ChatGPT **Business and Enterprise/Edu** customers on ChatGPT web." **Pro** can connect custom MCP servers with **read/fetch permissions** only. On Business, only admins and owners can create and publish them. **Plus is not mentioned** in the excerpts | https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt (search snippets, 2026-10-29; the search tool described the page as about 12 days old) |
| Secondary reporting agrees. gradually.ai (2026-10-25) says "Full MCP support including write actions is rolling out in beta on the Business, Enterprise, and Edu plans", Pro is limited to read and fetch, and plugins replaced the app directory on July 9, 2026. mcp.so (2026-10-15) says Free is "generally not available" and Plus/Pro "has varied". Community forum posts report that "Custom MCP is no longer on the list for Plus accounts" | https://www.gradually.ai/en/chatgpt-plugins/ ; https://mcp.so/blog/chatgpt-mcp-setup ; https://community.openai.com/t/mcp-server-tools-now-in-chatgpt-developer-mode/1357233 (thread pages undated in search) |
| EU history: apps launched in October 2025 "outside of the European Economic Area, Switzerland, and the United Kingdom". The 2025-12-18 app-directory release note says apps are available to all logged-in users, "with availability and functionality varying by plan and region". The Enterprise/Edu notes add that some apps or capabilities "may not be available in certain regions (including the EEA, GB, or Switzerland)" | https://help.openai.com/en/articles/6825453-chatgpt-release-notes and https://help.openai.com/en/articles/10128477-chatgpt-enterprise-and-edu-release-notes (search snippets, 2026-10-29) |
| I found **no official statement** that custom MCP servers are blocked, or allowed, for EEA users. A blog post (doxychat, 2026-10-02) says apps are still unavailable in the EEA, Switzerland and the UK, but it quotes the October 2025 launch line, so it may be stale | https://www.doxychat.com/en/blog/2026-10-02-chatgpt-apps-sdk-eu-business-chatbot/ |
| Only matters for publishing: "projects with EU data residency cannot submit plugins with MCP servers for review" | https://developers.openai.com/plugins/llms-full.txt (Submission section; read 2026-10-29) |

**Bottom line (partly inference):** mem needs a write tool (`retain`). Official text confirms full MCP with writes only on **Business/Enterprise/Edu**. Pro is read/fetch only, and Plus is unclear and likely excluded. Whether any of this works from an EEA account is **unverified**. Tim should test with his own account at chatgpt.com/plugins.

### 10. Claude (claude.ai and mobile)

| Fact | Source (date) |
|---|---|
| "Custom connectors using remote MCP are available on Claude, Cowork, and Claude Desktop for users on Free, Pro, Max, Team, and Enterprise plans." | https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp ("Updated over 4 weeks ago"; read 2026-10-29) |
| **Free cap:** "Free users are limited to one custom connector." | same; also https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities ("Updated over a week ago"; read 2026-10-29) |
| Write tools are allowed (tools can be "Creating, modifying, or deleting data in connected applications") | 11175166 |
| Mobile: a connector added on web or desktop is "available to use the next time you log in to your account on Claude for iOS or Android." "Installing connectors on mobile is currently in beta—Claude Desktop and web remain the primary path for custom connectors." | 11176164 |
| No regional restriction on connectors is mentioned. The server must be reachable from Anthropic's IP ranges on the public internet | 11175166 |
| All 27 EU member states are listed as supported Claude.ai locations | https://www.anthropic.com/claude-ai-locations (page shows effective date "Nov 12, 2026"; read 2026-10-29) |

Result: Tim can use mem from Claude in the EU on Free (one custom connector) or Pro, on web, desktop and, once added, mobile.

### 11. Gemini app

| Fact | Source (date) |
|---|---|
| Custom apps (MCP) eligibility: "Be 18 or over and in the US", signed in with a personal Google Account (not work or school), "Only available in English", Keep Activity on. You connect on gemini.google.com, and the app then works on mobile too. "Gemini requires manual confirmation for any write actions." | https://support.google.com/gemini/answer/17209137 (no page date; read 2026-10-29) |
| **Confirmed: US-only.** It is not available to Tim in the EU | same |
| Import from other AI platforms (memory and chats): "This feature is currently not available in: The EEA, Switzerland, or the United Kingdom." | https://support.google.com/gemini/answer/16868299 (no page date; read 2026-10-29) |
| **Confirmed: memory import is unavailable in the EEA.** It launched in late March 2026 | https://9to5google.com/2026/03/26/gemini-import/ (2026-03-26) |

### 12. Memory import and export in Claude and ChatGPT

| Fact | Source (date) |
|---|---|
| Claude: "Memory imports are available for Free, Pro, Max, Team, and Enterprise plans on the web and Claude Desktop." Import works by pasting text from another provider and is labelled experimental. Export means viewing memory in Settings or asking Claude to "Write out your memories of me verbatim" and saving the text yourself. There is no file format | https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude ("Updated this week"; read 2026-10-29) |
| Claude memory: "on by default for Free, Pro, and Max plans on the web, Claude Desktop, and Claude Mobile". Past-chat search is on paid plans only | https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context ("Updated this week"; read 2026-10-29) |
| No EU/EEA restriction is mentioned for Claude memory, import or export | the two articles above; https://claude.com/import-memory (no date; read 2026-10-29) |
| ChatGPT: I found **no official feature that imports memories from another assistant** into ChatGPT's consumer memory. The ChatGPT desktop app's "Import from another agent" brings in setup from **Claude Code, Claude Cowork, or Cursor**, including "Project memories from Claude Code" and chats from the last 30 days. That is agent and project setup, not claude.ai memory. The page does not mention region | https://learn.chatgpt.com/docs/import.md (no page date; read 2026-10-29) |
| ChatGPT memory export: I found no dedicated export. Third-party guides say the Data Controls export holds chats and account data but not saved memories, and that you copy memories by hand from Settings → Personalization → Memory | e.g. https://www.notis.ai/blog/can-you-export-your-chatgpt-memory/ (secondary; help center not readable) |

---

## Unverified

- Whether ChatGPT custom MCP servers (plugins) work for **EEA** accounts on any plan. No official statement was found either way.
- Whether **ChatGPT Plus** can add a custom MCP server today, and exactly what "read/fetch permissions" on Pro allows. It might mean only tools named `search`/`fetch`, or any tool marked `readOnlyHint`. The help center article could only be seen through search snippets.
- Whether a Neon database created through the **Vercel Marketplace** gets exactly the same Free limits as a direct Neon sign-up. Older docs said so, and current pages are silent.
- Prisma Postgres EU regions (Frankfurt, Paris) and pgvector version and HNSW support on Prisma Postgres.
- Supabase's pgvector version on Postgres 17 projects.
- Whether Neon's 1 GB Free storage cap counts index size the same way as table data. Assumed yes (logical size).
- ChatGPT memory export contents and EEA availability of ChatGPT memory features (help center blocked).
- Neon cold-start numbers beyond "a few hundred milliseconds". There is no p95 figure, and nothing measured from Vercel `fra1`.

# Plan: from working backend to daily driver

Written 2026-10-28 and revised 2026-10-31 after Tim's decisions. This is a research-backed plan only; no application code was written for it.

**What changed in this revision:**
- **Hosting:** mem runs on Vercel as a Next.js app, instead of a laptop tunnel followed by a VPS (D1).
- **Database:** plain Postgres with pgvector. It lives on Supabase today, and nothing else of Supabase is used, so it can move to a self-hosted Postgres by changing two connection strings (D1).
- **Background work:** the three always-running loops become drains triggered after each request and every minute by cron-job.org (D1, session 2).
- **GUI:** Next.js in this package instead of a Vite SPA (D3), behind a normal login rather than a private hostname (D4).
- **Users:** mem serves invited users as well as Tim. Tim pays their model costs under a monthly cap per user (D8).
- **Europe:** Tim lives in the EU, so the Gemini app is out and Gemini is reached through Antigravity CLI only (section 2, "Checks").

**Sources:**
- The external research is in `research_notes/Mem daily driver plan/`: ten notes files, each with dated, cited sources.
- The first eight are summarised in `reports/Mem daily driver plan.md`. The two added on 2026-10-29 cover Vercel and hosted Postgres with EU availability.
- It builds on the earlier landscape research (`Self hosted AI memory layer landscape.md`) and on `spike-results.md`.

**How citations work here.** Every claim about an external product points at a notes file and section, in square brackets:

| Key | File in `research_notes/Mem daily driver plan/` |
|---|---|
| [claude] | `mcp_auth_spec_and_claude_clients.md` (the MCP auth spec, claude.ai, Claude Desktop, Claude Code, Claude's memory) |
| [others] | `chatgpt_gemini_copilot_mcp.md` (ChatGPT, the Gemini app, Microsoft Copilot, Codex CLI, Antigravity CLI) |
| [vercel] | `vercel_nextjs_hosting.md` (Vercel limits, Next.js, Hono on Vercel, cron-job.org) |
| [db-eu] | `postgres_and_eu_availability.md` (hosted Postgres, Supabase, what the EU changes for each app) |
| [expose] | `exposure_tunnels_and_hosting.md` (tunnels, VPS hosting, vendor IP ranges; background for D1) |
| [oauth] | `oauth_options.md` (OAuth libraries and services, mapping onto principals) |
| [gui-products] | `gui_memory_products.md` (what other memory products show users) |
| [gui-stack] | `gui_stack_and_repo_shape.md` (front-end stacks, repo shape, GUI login) |
| [ops] | `macos_ops_and_extraction_model.md` (backups, health checks, extraction model prices) |
| [retain] | `retain_policy_usage_patterns.md` (what to remember and when) |

Labels the notes carry:
- "secondary": a third-party page.
- "search extract": a page seen only through a search engine's summary.
- "unofficial": a leaked prompt.
- "possibly stale": older than about six months.

### Words used in this plan

**Common terms**
- **API:** application programming interface.
- **REST:** our plain HTTP JSON interface.
- **CLI:** command-line tool.
- **SDK:** a vendor's software development kit.
- **GUI:** the graphical user interface we are planning.
- **DNS:** the internet's name lookup.
- **RFC:** an internet standard document.

**Security**
- **CSRF:** a forged request from another website riding on your login cookie.

**Sign-in (OAuth)**
- **MCP:** Model Context Protocol, how AI apps call tools on our server.
- **OAuth:** the standard "sign in and grant this app access" flow; OAuth 2.1 is the current version.
- **Authorization server:** the login part. It signs a user in and hands out tokens.
- **Resource server:** the part that holds data and checks tokens; for us, the MCP endpoint.
- **Bearer token:** whoever holds it gets in. Today's API keys are bearer tokens.
- **Access token:** a short-lived bearer token.
- **Refresh token:** lets an app get a new access token without the user signing in again.
- **JWT:** a signed token our server can check without a database call.
- **Issuer:** the authorization server that signed a token.
- **Audience:** the server a token is meant for; for us, one bank's MCP URL.
- **PKCE:** a one-time secret that stops a stolen login code being reused.
- **DCR (Dynamic Client Registration):** an app registers itself with our login server on first contact.
- **CIMD (Client ID Metadata Document):** instead of registering, the app's client id is a URL that serves a small JSON description of the app.
- **PRM (Protected Resource Metadata):** a JSON file on our server that tells an app where to sign in.
- **Passkey:** a sign-in key stored on the user's devices instead of a password. It is bound to one domain.
- **TOTP:** six-digit codes from an authenticator app.

**Hosting**
- **Vercel Hobby:** Vercel's free plan, for personal, non-commercial use.
- **Fluid compute:** Vercel's function runtime. One instance serves many requests at once, and time spent waiting on I/O is not billed as CPU.
- **Function duration:** the wall-clock time one request may run, including work done after the response. Hobby allows 300 seconds.
- **Pooler:** a proxy that shares a few database connections among many short-lived clients. In transaction mode, a connection is lent for one transaction only.
- **Direct URL:** a database connection that keeps one whole session, as `pg_dump` and `pg_restore` need. On Supabase Free it is the pooler's session mode.
- **Drain:** one pass that processes queued work (indexing, extraction, erasure) until the queue is empty or a deadline nears.

**Accounts**
- **Tenant:** everything one user owns: their banks, principals, grants and audit log. Each user is one tenant.
- **Cap:** the monthly model-spend limit on one tenant.

**Operations**
- **Liveness:** "the process answers".
- **Readiness:** "the process and its database work".
- **Dead-man's switch:** an alarm that fires when an expected ping does not arrive.

**Privacy law**
- **GDPR:** the EU data protection law.
- **Controller:** whoever decides why and how personal data is processed. Tim becomes one for invited users' data.
- **Processor:** a vendor that processes personal data on the controller's behalf, such as Vercel or Supabase.
- **EDPB:** the board of EU regulators.
- **EEA:** the EU plus Iceland, Liechtenstein and Norway.

**Our eval**
- **JSONL:** one JSON object per line.
- **LoCoMo:** the public long-conversation benchmark we ran.
- **Arm B:** our pgvector-plus-extraction setup in that eval.
- **extract-v3:** our current extraction prompt.
- **MDD:** minimum detectable difference, the smallest score gap our eval can tell apart from noise.

## 1. Goal

Make `mem` the one memory that Claude, ChatGPT, Gemini and the coding tools all read from and write to, every day, without Tim thinking about it. Then let invited users do the same with their own private memory. That means:
- reachable from the consumer chat apps;
- always on;
- backed up;
- cheap to run, with spending on other users capped;
- visible through a GUI where each user can see what mem believes and where each belief came from, correct it, and take it with them;
- one user can never see another user's memory.

The spike showed that for one person's history full context answers as well as any memory engine, so this plan spends nothing on cleverer retrieval. The value is owning the facts and moving them between providers. Every session below serves reachability, trust, operations, portability or safe sharing.

### What "Tim would definitely use it" means (checkable)

1. **Reachable everywhere he chats.** With his real bank (not `bank-demo`), each of these lists mem's tools and completes one `recall` and one `retain`:
   - **Claude Code.**
   - **Claude's hosted apps**, meaning claude.ai on the web, Claude Desktop and the phone app. They share one connector and one sign-in, so they appear as one principal [claude Q2].
   - **ChatGPT on the web**, if Tim's plan allows custom MCP servers. `retain` only works if the plan also allows write tools (section 2, "Checks").
   - **Gemini through Antigravity CLI.** The Gemini app's custom connectors are for US users only [db-eu 11].
   - **Codex CLI.**

   The audit log shows one principal per app.
2. **Always on.** No laptop is involved. A Better Stack uptime monitor on the public `/readyz` shows at least 99% over 14 days [ops 3].
3. **Fails loudly.** When memory is down, Claude Code says so at session start, and Tim gets an email within 10 minutes.
4. **Backed up.** A nightly encrypted backup is held away from the database's provider, and a restore drill passed within the last 30 days (row counts match, audit chain verifies).
5. **Trustworthy through the GUI.** In under a minute a user can:
   - find what mem believes about a topic;
   - read the source quote and which app wrote it;
   - correct it;
   - see the old version in its history;
   - see which apps read it.

   Export and erase work from the GUI.
6. **Cheap.** Tim's own extraction spend stays under 1 USD a day, read from the cost ledger of session 8. No invited user's extraction spend passes their cap by more than the calls already in flight when it is reached; their embeddings are counted and rate-limited but never blocked. Hosting stays on free plans while Tim is the only user, and Supabase Pro is expected once invited users arrive (D1).
7. **Not junk.** In a weekly review of newly extracted facts, fewer than 1 in 5 is disputed as wrong or useless. The GUI also shows how many retains the recall-loop guard of session 8 skipped, and the review finds no fact whose source is an assistant restating something mem had just recalled.
8. **Used.** Over two consecutive weeks, the audit log shows reads from at least two different apps on at least five days of each week.
9. **Isolated.** An independent review and the cross-tenant tests of session 13 find no path from one user's session, OAuth token or API key to another user's data. This holds before the first outside user is invited.
10. **Database swappable.** The full test suite passes against plain Postgres in Docker, both directly and through a transaction-mode pooler. Moving to another Postgres means changing the connection strings and restoring a backup of mem's own schemas, which the monthly drill of session 5 proves on plain Postgres.

## 2. Decisions

Each decision lists what was decided or the options, a recommendation and the reason. Sessions in section 3 say which decision they wait on.

| Decision | Status |
|---|---|
| D1. Hosting, database and background work | **Decided by Tim:** Vercel with Next.js, Postgres on Supabase used only as a database, cron-job.org for frequent triggers |
| D2. How the chat apps sign in | Recommendation stands: better-auth |
| D3. GUI stack | **Decided by Tim:** Next.js in this package |
| D4. How the GUI authenticates | **Decided by Tim:** a normal login in the same deployment |
| D5. Extraction model | Recommendation stands: test cheaper models before switching |
| D6. Retain policy | Recommendation stands: model-initiated retain with guards |
| D7. Backup destination | Recommendation stands: Cloudflare R2 |
| D8. Multiple users | **Decided by Tim:** he pays, under a monthly cap per user. Invitation-only sign-up is recommended and assumed |
| D9. The public address | **Open:** a custom domain is recommended over the free `vercel.app` name |

### D1. Hosting, database and background work

**Decided.** Tim prefers Vercel and Next.js (2026-10-29), the database on Supabase but swappable for his own (2026-10-31), and cron-job.org for frequent triggers (2026-10-31).

The consumer apps connect from their vendors' clouds, so mem needs a public HTTPS address:
- claude.ai connects from Anthropic's range `160.79.104.0/21`, IPv4 only, and refuses private and loopback addresses [claude Q2].
- ChatGPT connects from OpenAI's published egress addresses [others ChatGPT].
- Only Claude Code, Codex CLI and Antigravity CLI connect from the local machine [claude Q5][others CLIs].

Vercel gives that address with no server to run and no laptop to keep awake.

**What the free Hobby plan allows** [vercel 1, 2, 5, 7]:

| Limit | Hobby | What it means for mem |
|---|---|---|
| Function duration | 300 s with Fluid compute, which is on by default | One extraction takes 10-60 s and fits. A backlog stops at the deadline and the next drain resumes it. |
| Vercel's own cron | Once a day, anywhere within the hour | Too slow for retries, so cron-job.org triggers every minute instead. The daily Vercel cron is the backstop. |
| Always-running worker | Vercel Daemons run on Hobby but stop after about 9 days a month, because idle memory counts against their quota | The three loops in `src/attachment/rest/main.ts` must become drains (session 2). |
| Monthly allowance | 1M invocations, 4 CPU-hours, 360 GB-hours of memory, 100 GB transfer | One trigger a minute uses 43,200 invocations a month. Memory is fixed at 2 GB, so 360 GB-hours buy about 180 hours of function time a month. Waiting on the model spends memory time but not CPU time. |
| Over a limit | The feature stops until 30 days pass; no paid overage | Vercel's dashboard shows usage against these limits, and session 14's status page links to it. |
| Region | One region; `fra1` (Frankfurt) is allowed | Functions run next to the database. |
| Terms | Personal, non-commercial use only | Inviting users for free fits. Charging anyone requires Pro, at $20 a month per seat with $20 of usage included [vercel 6]. |

Vercel Workflows, generally available since April 2026, has no duration limit and retries steps on its own [vercel 4]. It is the upgrade path if drains prove too slow or too short. It is not used now, because it would put Vercel's programming model into the application code.

**Background work.** The three loops become one drain, with three triggers:
- **After a request:** every retain and erasure request schedules a drain with Next.js `after()`, so new work starts within seconds [vercel 2].
- **Every minute:** cron-job.org calls a drain endpoint with a secret in an `Authorization` header [vercel 13]. Its requests time out after 30 s, so the endpoint answers at once and drains after the response.
- **Once a day:** Vercel's own cron calls the same endpoint, in case cron-job.org is down. Vercel's cron sends a GET with `Authorization: Bearer` and the project's `CRON_SECRET` [vercel 1], so the endpoint accepts GET and POST with that one bearer secret.

The existing claims use `FOR UPDATE SKIP LOCKED`, so overlapping drains never take the same work. Work interrupted by the deadline is retaken once its claim goes stale, as today.

**Monitoring.** cron-job.org disables a job after 25 failures, so it cannot be the monitor [vercel 13]. Two free services watch instead [ops 3]:
- **Healthchecks.io:** each successful drain pings a check, and Healthchecks emails Tim when the pings stop. Its period plus grace time is at most 10 minutes, for criterion 3. It is free for 20 checks.
- **Better Stack:** probes the public `/readyz` from outside and keeps the uptime record for criterion 2.

**Database: Postgres 17 with pgvector, on Supabase Free in Frankfurt** [db-eu 7, 7b]:
- **Only Postgres.** mem uses Supabase as a plain database. It does not use the Supabase SDK, Auth, Storage, Cron, Realtime, Edge Functions, `pg_net` or the Data API.
- **Created directly, not through Vercel.** Tim creates the project at supabase.com in Frankfurt and copies only the connection strings into Vercel. A database created through the Vercel Marketplace is managed and billed through Vercel; for Neon, the notes show that it then cannot be transferred in or out [db-eu 5]. The integration also adds Supabase's own SDK variables, which mem must not grow to depend on.
- **Data API off.** Supabase's Data API is on by default and serves the `public` schema over HTTP. Tim turns it off, and mem keeps its tables out of `public` (session 1).
- **Reserved schemas.** Every Supabase project already has an `auth` schema for Supabase Auth, so better-auth's tables go in an `identity` schema instead (D2).
- **Two connection strings.**
  - `DATABASE_URL` serves the app and migrations, and may go through a transaction-mode pooler. On Supabase it is the shared pooler on port 6543, over IPv4.
  - `DATABASE_DIRECT_URL` serves backups and restores only, because `pg_dump` and `pg_restore` need a whole session. On Supabase it is the pooler's session mode on port 5432, since direct connections are IPv6 only on Free.
- **What transaction mode forbids:** session state outside a transaction, settings sent when connecting, session-level advisory locks, `LISTEN`/`NOTIFY` and prepared statements [db-eu 7b]. Two current uses break:
  - `src/platform/postgres/pool.ts` sends `hnsw.iterative_scan` when connecting. Without it, filtered recall returns too few rows. Session 1 moves it into recall's own transaction.
  - The migration runner holds a session-level advisory lock. Session 1 switches it to a lock scoped to each migration's transaction.
- **Tested both ways.** The suite runs through a local PgBouncer in transaction mode, which proves the code follows these rules. Supabase's pooler is a different program, so session 4 repeats the retrieval tests against it.
- **Free plan limits:**
  - 500 MB of database storage.
  - No automatic backups.
  - A free project is paused after a week without enough user database activity, with a warning email a week ahead. It can be resumed within a year with its data. Daily use should prevent a pause; whether automated drains count is not stated.
  - Two active projects, one for production and one for preview deployments.
- **Storage runway:** each indexed fact or episode takes roughly 15 KB with 1536-dimension vectors (an estimate from pgvector's storage format, not a measurement). 500 MB holds about 30,000 of them. Storing vectors at half precision roughly halves that, and session 1 decides whether to switch.
- **When to upgrade:** Supabase Pro is $25 a month, never pauses and keeps daily backups [db-eu 7]. Expect it once invited users arrive or storage passes about 400 MB.
- **Moving to a self-hosted Postgres** means restoring mem's own schemas from the latest backup and setting new connection strings. Nothing else in the code knows about Supabase.

**Region and data location:**
- Vercel functions run in `fra1` and the database is in Frankfurt (`eu-central-1`).
- Memory text still goes to the model providers, OpenAI for embeddings and Anthropic or Google for extraction, which process it outside the EU.

**What stays local:**
- Tests and development keep the Docker Postgres.
- The Hindsight and Honcho engines run only in Docker for evals.
- The admin CLI and the eval harness run on the laptop against whichever database their URL names.

**Who does what:**
- Tim creates the Vercel, Supabase, cron-job.org, Healthchecks.io, Better Stack and Cloudflare accounts, and enters every secret into their dashboards and into GitHub's Actions secrets himself.
- Sessions prepare the exact steps and commands.

### D2. Auth approach: how the chat apps sign in

None of the consumer apps can use today's API keys:
- claude.ai needs OAuth; static request headers are a beta limited to some organisations [claude Q2].
- ChatGPT explicitly does not support API keys or custom headers [others ChatGPT].

So OAuth is required for every consumer app.

Requirements, from the spec and the apps:
- **Spec:** the MCP spec in force is revision 2026-07-28. It deprecates DCR in favour of CIMD [claude Q1].
- **Which apps use CIMD:** claude.ai, ChatGPT, Claude Code and Codex CLI can all use CIMD [claude Q2, Q5][others ChatGPT, CLIs].
  - claude.ai uses it only when the server's metadata advertises `client_id_metadata_document_supported: true` together with `"none"` as a token-endpoint auth method; otherwise it falls back to DCR [claude Q2].
- **Which apps do not:** Antigravity CLI uses DCR or a manual client for OAuth. Like Codex CLI, it also accepts a static header, so today's API key works for it [others CLIs].
- **Claude's strict client:**
  - the metadata's `resource` must match the connector URL, path included (servers should compare the canonical form, not byte for byte);
  - Claude reads only the first authorization server listed;
  - OAuth endpoints get 10 seconds;
  - the token endpoint must accept form-encoded bodies [claude Q2].

| Option | What it gives | What it costs |
|---|---|---|
| MCP SDK / `@hono/mcp` auth helpers | Resource-server pieces (PRM, bearer check) | The authorization-server helpers are Express-only and DCR-only. The SDK's v2 docs call them "deprecated, frozen". The installed `@hono/mcp` 0.3.2 generates client secrets with `Math.random` [oauth 1]. |
| better-auth (`@better-auth/mcp`, `@better-auth/cimd`, `jwt()`, `@better-auth/passkey`) | CIMD, opt-in DCR, PKCE, per-resource audience, automatic PRM, login and consent hooks, refresh rotation. `requireMcpAuth` checks tokens on the resource side. It mounts in Hono in one line and keeps its own Postgres schema over `pg` [oauth 2]. | Churn: the MCP plugin moved packages in 1.7.0 (Aug 2026), and 1.8 beta breaks the OAuth provider. A 2026 advisory history, mostly in legacy plugins. Each bank's MCP URL must be registered as a resource through its admin API. JWT access tokens cannot be revoked server-side. `@better-auth/mcp` is installed together with `@modelcontextprotocol/server`, which is MCP SDK v2, while mem runs SDK v1 [oauth 1, 2]. |
| panva `oidc-provider` | OpenID Certified, DCR, PKCE, resource indicators through a callback that suits per-bank audiences, RFC 9207. CIMD is experimental [oauth 3]. | One maintainer. We write the Postgres adapter, login and consent pages, a Hono-to-Node bridge and the passkey login ourselves [oauth 3]. |
| Hosted (WorkOS AuthKit, Clerk, Auth0, Descope) | CIMD and DCR advertised by all four; mem becomes only a token checker. Free tiers far exceed our user count (WorkOS: first 1M monthly users) [oauth 4]. | An external sign-in dependency for a system whose point is not depending on a provider. Whether the free tiers include CIMD and DCR is unverified, and Auth0's DCR support comes from a third-party table [oauth 4]. |
| Keycloak, authentik, Zitadel, Ory Hydra | Full identity servers. | A poor fit [oauth 5]:<br>• **Keycloak:** CIMD and resource indicators are experimental flags, it does not support ChatGPT's CIMD, and it needs about 1.25 GB of RAM.<br>• **Zitadel:** ignores `resource`.<br>• **authentik:** no DCR.<br>• **Hydra:** no resource indicators. |

**Recommendation:** better-auth, embedded in the Hono app with its tables in their own `identity` schema. The name `auth` is taken on Supabase (D1).
- **Plugins:** `@better-auth/mcp` (which is itself the OAuth provider, so `oauthProvider()` is not registered as well), `@better-auth/cimd`, `jwt()` and `@better-auth/passkey` [oauth 2].
- **Registration:**
  - CIMD on, so Claude's apps, ChatGPT, Claude Code and Codex CLI need no registration step.
  - CIMD fetches go only to an allowlist of hosts: chatgpt.com, claude.ai, and whatever host Claude's hosted apps use, which Anthropic does not publish and session 7 reads from the first attempt [claude Q2][oauth 8].
  - DCR stays off, which removes the open-registration risk [oauth 8].
  - Antigravity CLI and Codex CLI can keep using API keys as static headers, so no app needs a pre-registered client or DCR today [others CLIs].
- **Login:**
  - Each user signs in with a passkey and is asked to enrol a second one, on another device, as a backup.
  - A user who loses every passkey is recovered by Tim with a one-time link from the admin CLI, because mem sends no email. better-auth's backup codes belong to its two-factor plugin and complete a second factor after a first sign-in, so they are not assumed to sign anyone in alone; session 6 checks this.
  - Sign-up is open only through an invitation (D8). Passkey-first sign-up uses the passkey plugin's `registration.requireSession: false` with a `registration.resolveUser` hook, and that hook is where the invitation is checked [oauth 6]. The check itself is our code.
  - The passkey is bound to the public domain (D9), which serves both the OAuth sign-in and the GUI.
  - If an app's sign-in pop-up cannot use a passkey (untested [oauth 6]), session 7 adds better-auth's two-factor plugin for TOTP.
- **Consent:** a page that names the app, its redirect host, the scopes and the bank, offering only the signed-in user's own banks. It is CSRF-protected and cannot be framed by another site [oauth 6].
- **Resource side:** better-auth's `requireMcpAuth` [oauth 2], with each bank's MCP URL registered as a resource when the bank is created.
- **First step of session 6:** check whether `@better-auth/mcp` needs MCP SDK v2 at run time. If it does, moving mem's MCP server to SDK v2 (whose `@modelcontextprotocol/hono` package exists [oauth 1]) becomes its own session before session 6.
- **Fallbacks:**
  - If session 6 finds a blocker, fall back to panva `oidc-provider`, accepting the adapter and page work [oauth 3].
  - WorkOS is the least-code fallback if Tim accepts an external sign-in dependency [oauth 4].

**Reason:** it is the one option that covers every requirement above as a maintained library rather than code we write, which is Tim's first working agreement. It also gives the GUI its login (D4) and user accounts (D8).

Its risks are manageable:
- pin the exact version;
- enable only the plugins listed;
- keep access tokens at 15 minutes or less with rotated refresh tokens;
- re-check grants in Postgres on every request, so revoking an app takes effect at once even while its token is still valid [oauth 7, 8].

The identity mapping stays inside our model [oauth 7]:
- **One principal per app:** each connected app becomes one Principal of kind `integration` in the signing-in user's tenant, keyed by issuer plus client id.
- **Bank from the token:** its Grant is on exactly the bank named by the token's audience, which is the bank's MCP URL.
- **Rate limits per principal:** a verified OAuth token is limited by its principal, not by address. Every claude.ai user arrives from Anthropic's one address range [claude Q2], so an address bucket would make users throttle each other.
- **Scopes:** `mem:read` and `mem:write` map to the read and write capabilities. `erase` and `admin` are never offered over OAuth.
- **API keys:** they keep working beside OAuth for Claude Code and scripts. The resolver tells the two apart by token shape.

### D3. GUI stack and repo shape

**Decided:** Next.js, in this package (2026-10-29).

The rule is one repo, one package, no monorepo [gui-stack Q1, Q3]:
- Next.js lives in the root `package.json`, with its `app/` folder at the repo root beside `src/`, which keeps the domain code.
- The old objections to Next.js were a second production process and a static export that loses cookies [gui-stack Q1, Q3]. Both go away on Vercel, which runs Next.js itself.
- npm workspaces and shadcn's `--monorepo` mode stay out [gui-stack Q2, Q3].

**How it is set up (session 4):**
- **Scaffold:** `npx create-next-app@latest` into a scratch folder, then merge its dependencies, scripts and config into this package. Next.js 16.4.3 was current on 2026-10-23, and a security release is due on 2026-11-03 [vercel 12].
  - Flags are passed explicitly and checked against `--help` first: TypeScript, the App Router, `--webpack`, Tailwind (which shadcn/ui needs), and no `src` directory, because `src/` is the domain code.
  - Cache Components is on by default for the App Router [vercel 12]. The session keeps it or turns it off deliberately and records why.
- **Bundler:** Turbopack, the default, does not resolve our `./foo.js` imports to `./foo.ts` files. The fix is still an open pull request. So builds use webpack (`next build --webpack`, `next dev --webpack`) with this setting [vercel 12]:
  ```js
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'] } }
  ```
- **TypeScript:** Next.js's dev server watches only `tsconfig.json`, editors read it, and it must include `next-env.d.ts` [gui-stack Q1]. So the root `tsconfig.json` serves Next.js and the editor, and a second config keeps `NodeNext` for type-checking the server, CLI and tests. Session 4 confirms that vitest and `tsx` still resolve as before. TypeScript stays on 5.9 [gui-stack Q1].
- **The API inside Next.js:** the existing Hono app is mounted in App Router route handlers with `handle` from `@hono/vercel`, because `hono/vercel` is deprecated [vercel 10]. Route handlers at `app/v1/[...path]/route.ts`, `app/healthz/route.ts`, `app/readyz/route.ts` and the `app/.well-known/...` paths keep today's URLs [vercel 10].
- **MCP stays our own.** Vercel's `mcp-handler` 2.x needs MCP SDK v2, and its last v1 release pins one exact SDK version [vercel 11]. Our `@hono/mcp` route should keep working inside the Hono app. The notes leave this unverified, so session 4 proves it by running the MCP tests against the deployed URL.
- **Database pool:** created once per instance at module scope and passed to `attachDatabasePool` from `@vercel/functions`, with a short idle timeout and more than one connection [vercel 9].
- **Vercel-only code stays at the edge.** `after()`, `attachDatabasePool` and the route files live in the Next.js composition root. The domain and application code under `src/` stays plain Node, so the CLI, the tests and `npm start` keep working.
- **UI:** shadcn/ui through `npx shadcn@latest init` and `add` (never `--monorepo`) [gui-stack Q2]. Pages read through React Server Components that call the application layer in-process, and changes go through Server Actions. Each one resolves the signed-in user's principal through the same Scope resolver and access policy as REST.
- **The isolation guard.** The query guard checks only the tables in its scoped list (`src/platform/postgres/bank-isolation.ts`) and only on the pool the tests wrap. So every session that adds a table holding a user's data adds it to that list with its tenant column, and better-auth is given the guarded pool in tests (sessions 6, 8 and 13). Browser tests through Playwright run without the guard, so they test behaviour only.

### D4. How the GUI authenticates

**Decided:** one deployment, with the GUI behind a normal login (2026-10-29). A Vercel login gate in front would also block the chat apps from the MCP endpoint, and it would shut out invited users [vercel 8].

RFC 10017 (the browser-apps best practice, August 2026) says a GUI served from the same origin as its API can use a plain server-side cookie session, and need not be an OAuth client [gui-stack Q4].

**How:**
- **Login:** the D2 login, with sign-up by invitation only (D8). Passkeys, with a second passkey as the backup, are recommended, not decided. A password with TOTP is the alternative if invited users find passkeys hard.
- **Cookie:** better-auth's session cookie, set `__Host-`, HttpOnly, Secure and SameSite=Lax. Lax sends the cookie when a chat app sends a signed-in user to our sign-in page, so they are not asked to sign in again; the CSRF checks below cover what Strict would add [gui-stack Q4].
- **CSRF:** Server Actions compare `Origin` with the host. Any JSON route the GUI calls also checks `Origin`/`Sec-Fetch-Site` and requires a custom header, because Hono's built-in `csrf()` does not check JSON requests [gui-stack Q4].
- **Re-authentication:** export, erase and account deletion ask the user to sign in again.
- **Scope:** a session reaches only its own tenant's banks.
- **Rate limits:** the login endpoints are rate-limited in code (session 6). Vercel's firewall rules can deny or challenge but have no rate-limit action [vercel 8].

**Reason:** it reuses the D2 login with no extra library, follows the RFC's same-origin advice, and serves Tim and invited users the same way.

### D5. Extraction model

Every retained statement costs one extraction call, and Tim now pays for every user's calls (D8).

| Model | Price per million tokens, in / out [ops 4] | Arm-B LoCoMo write run (now 6.32 USD) [ops 5] | If 50-200 statements a day [ops 5] |
|---|---|---|---|
| Claude Opus 5.5 (today) | $4 / $20 | 6.32 USD | 2.8-11 USD/day |
| Claude Sonnet 5.5 | $2 / $10 | 3.16 USD | 1.4-5.5 USD/day |
| Gemini 3.8 Flash | $0.75 / $3.75 (doubles 2027-01-01) | 1.32 USD | 0.6-2.3 USD/day |
| Gemini 3.1 Flash-Lite | $0.25 / $1.50 | 0.46 USD | 0.20-0.81 USD/day |
| Claude Haiku 5.5 | $0.10 / $0.50 (prompts up to 100k tokens) | 0.16 USD | 0.07-0.28 USD/day |

Caveats on the table:
- The run figures assume the same token mix as the Opus run. They do not account for different tokenizers or extra reasoning tokens [ops 5].
- **Volume is the bigger unknown:**
  - The 50-200 a day figure was an assumption given to the researcher, not a measurement.
  - With the strict retain policy of D6 the estimate is "a handful per day", which stays under 1 USD a day even on Opus [retain 6].
  - Imports would raise volume.
- Public evidence that small models extract as well as frontier ones is thin and vendor-run [ops 4].
- Gemini's implicit cache needs 4,096 tokens, so our 1,700-token prompt prefix would not be cached there [ops 4].

**Recommendation:** verify before switching (session 3).
1. Rerun arm B on the same 40 LoCoMo questions with three candidates:
   - Haiku 5.5;
   - Sonnet 5.5;
   - Gemini 3.1 Flash-Lite, as the non-Anthropic check that keeps us provider-independent.
2. Adopt the cheapest candidate that meets the stricter rule from [ops 5]:
   - at most 2 questions lost net against extract-v3 on Opus (31/40);
   - no new failures on the 8 adversarial questions;
   - no rise in false specifics.
3. If none passes, stay on Opus 5.5 and rely on the retain policy and the caps to keep cost down.

OpenAI's gpt-6-luna is priced like Haiku but is left out: its strict schema mode needs our zod `.optional()` fields changed to `.nullable()`, which is a code change [ops 4].

**Reason:**
- **Small spend:** the check costs about 5.6 USD [ops 5].
- **Large upside:** a cheaper model stretches every user's cap by up to 40 times.
- **Limit:** the 40-question subset has an MDD of 10 to 27 points, so the run only rules out large drops [ops 5]. The weekly review (criterion 7) is the second check.
- **Optional extension:** a 150-question confirmation is possible later. It needs a new Opus reference run of about 18 USD [ops 5], and it is Tim's call.

### D6. Retain policy: what the assistants should store

What the evidence says:
- **Explicit requests:** Claude's and ChatGPT's guidance honours an explicit "remember that ...".
- **Implicit saves:**
  - ChatGPT's leaked, unofficial prompt saves implicitly only what is "likely true for months or years".
  - Claude has a never-save list even on request.
  - Gemini's Saved Info is documented as explicit-only.
  - None asks for approval before saving; review comes afterwards [retain 1].
- **Junk:**
  - The best public evidence is one Mem0 deployment with 97.8% junk (anecdotal: one deployment).
  - Its largest sources were restated system prompts, cron noise, architecture dumps and transient task state.
  - Its worst failure was a loop where recalled memories were extracted again [retain 2].
- **Where the policy can live:** MCP server instructions are only a hint that apps MAY show the model, so the policy must also sit in the `retain` tool description [retain 3].

Options [retain 6]:
- **(A) Model-initiated retain:** a strict, short policy in the tool description, plus server-side guards.
- **(B) Explicit "remember this" only:** fewest calls, but misses things said in passing.
- **(C) A Claude Code session-end batch:** a hook extracts once per session from the user's own turns into a "candidate" state that expires unless confirmed.

A hook that retains every message is the firehose the audit warns against [retain 6].

**Recommendation:** (A) everywhere now, with four guards:
- always honour an explicit "remember that";
- never store the categories Claude never saves, such as government IDs and financial account numbers [retain 1];
- skip extraction when the retained text only restates a current fact, which breaks the recall-then-retain loop;
- cap retains per app per day, which also limits cost.

Consider (C) only after two weeks of GUI review show durable facts being missed.

**Reason:**
- **Authorship:** extraction only runs on text the calling model marks as the user's own words (`verbatim: true` in `src/attachment/mcp/server.ts`). That already removes the audit's largest junk sources when the model marks honestly. mem cannot verify authorship [retain 2].
- **What is left:** transient task state and the recall loop. The guards target those, and the loop guard does not depend on the model's honesty.

### D7. Backup destination (small)

| Option | Cost |
|---|---|
| Backblaze B2 | 10 GB free; its pricing page is possibly stale [ops 2] |
| Cloudflare R2 | 10 GB free [ops 2] |
| Hetzner Storage Box | €3.20/month for 1 TB [ops 2] |

**Recommendation:** R2, in its EU jurisdiction. A few GB fit the free tier, and it stays independent of the database's provider.

**What is dumped:** only mem's own schemas, without owners or privileges. A full dump of a Supabase database also carries Supabase's own schemas, roles and extensions, which a plain Postgres cannot restore (session 5).
- **The list:** `memory`, `governance`, `retrieval`, `extraction`, `portability`, `identity` (session 6) and `platform`, the new home of the migration table (session 1). It lives in one script, and a test fails when a schema exists that the list lacks.
- **The `vector` extension** is not in the dump. Every restore creates it first, in the schema the dumped column types name, which session 1 fixes in a migration.

**Where the job runs:** GitHub Actions on this repo, which is public, so its runner minutes are free. That has three rules:
- workflow logs are public, so the job never prints a secret or a row;
- dumps go only to R2, never into workflow artifacts;
- GitHub disables scheduled workflows in a public repo after 60 days without repository activity. The dead-man's switch reports it, and Tim re-enables the workflow by hand.

**Check first:** the bucket's object-version settings. Kept old versions would lengthen how long erased data survives in backups; this was an open question for B2 [ops 2].

### D8. Multiple users

**Decided:** invited users get their own private memory, and Tim pays their model costs under a monthly cap per user (2026-10-31).

**Recommended and assumed unless Tim says otherwise:**
- **Invitation-only sign-up.** Tim creates an invitation link from the GUI or the admin CLI and sends it himself, so mem needs no email service.
- **Bring-your-own-key later**, only if mem opens wider.

**What already exists:**
- Every bank, principal, grant, audit entry and extraction run carries a tenant id.
- The query guard over the test suite rejects any statement that is not scoped to a bank, unless it is tagged and allowlisted.
- The extraction ledger records input, output and cache tokens per run, with the tenant.

**What is missing:**
- **Accounts:** an accepted invitation creates the user, their tenant, a first bank, their principal and grants in one transaction. The new bank gets a configured default extractor, because extraction runs only for banks with an extractor set. The default is Opus 5.5 until session 3 picks a cheaper model.
- **A cost ledger per attempt:** today's `extraction.runs` keeps one row per episode, each attempt overwrites its tokens, the model is written only on success, and a call cut off by the deadline records nothing. Caps need one row per model call, with the model, the tokens and the cost.
- **Caps:** a monthly spend per tenant, summed from that ledger with a dated price table per model.
  - At the cap, retains are still stored and recall still works, but extraction waits until the next month or until Tim raises the cap. The user sees this in the GUI.
  - Embedding calls on retain and recall also go to Tim's OpenAI key. They are counted in the ledger and limited by rate, but never blocked, because blocking them would stop recall.
- **Proposed defaults,** changed per user with the admin CLI:
  - Tim: 30 USD a month, matching criterion 6's 1 USD a day.
  - Each invited user: 2 USD a month.
- **Fairness:** extraction claims are first come, first served across all tenants today. One user's large import must not hold up everyone else, so claims rotate between tenants (session 8).
- **Shared rate limiting:** today's counters live in one process's memory, and Vercel runs many instances. A Postgres-backed store from `rate-limiter-flexible` replaces them. The client address comes from the header Vercel sets, which session 4 confirms Vercel overwrites. Verified tokens are limited per principal (D2).
- **An operator role:** Tim's pages for invitations, caps and everyone's spend read across tenants, which bank grants cannot express. Tim's account carries an operator flag that the access policy checks, and those statements are tagged and allowlisted in the query guard (session 13).
- **Account deletion** (session 10):
  - It erases every bank of the tenant with the existing erasure, then the tenant's principals, OAuth clients, consents, tokens, sessions, passkeys, invitations, ledger rows and rate-limit rows, and finally the auth user.
  - Each new store that holds a user's data joins the erasure store lists, as `STATUS.md` requires.
  - The session decides how much of the tenant's audit chain is kept as proof of the deletion, and issues one receipt.

**What Tim takes on:**
- **Privacy law.** Holding other people's memories makes Tim their data controller under GDPR. He needs:
  - a privacy notice that lists what is stored and why;
  - the list of processors: Vercel, Supabase, OpenAI, Anthropic and Google for the models, Cloudflare for backups;
  - each processor's standard data processing agreement, and their terms for sending data outside the EU;
  - a way to honour access and erasure requests. Export and erasure are already built.

  This is a summary of obligations, not legal advice.
- **Backups and erasure.** The EDPB asks controllers to re-apply erasures on restored systems [ops 2]. With other users this is a duty, not only a product promise. The erasure ledger that makes it possible lives outside the database (session 5).
- **Vercel's terms.** Free invitations are non-commercial. Charging anyone requires Pro.
- **Isolation stakes.** A leak between users becomes the worst possible bug. Session 13 runs an independent isolation review before the first invitation.

### D9. The public address (open)

The address is part of three things that are hard to change later:
- every connector URL in every chat app;
- every user's passkey, which is bound to its domain;
- the OAuth issuer that signed every token.

| Option | Cost | Trade |
|---|---|---|
| A custom domain, such as `mem.<yours>` | About $10.46 a year (third-party price list; reported to rise about $0.71 on 2026-11-01) [expose 3] | Survives any later move off Vercel. |
| The free `<project>.vercel.app` name | Free | Tied to Vercel and to the project name. Moving later means re-adding every connector and re-enrolling every passkey. |

**Recommendation:** a custom domain, bought before session 6 enrols the first passkey. Vercel or any registrar works, with DNS pointing straight at Vercel and no proxy in front, as Vercel recommends [vercel 8].

### Checks only Tim can do (they decide which apps are in scope)

Tim lives in the EU, which settles some of these [db-eu 9-12]:

- **Claude: works.**
  - Custom MCP connectors work on Free (one connector), Pro, Max, Team and Enterprise, with write tools [db-eu 10].
  - A connector added on the web or desktop also works in the phone apps.
  - Each bank is its own connector, because the bank id is in the URL [claude Q2].
  - Claude can import memories from other assistants, with no EU restriction stated [db-eu 12].
- **ChatGPT: depends on Tim's plan.**
  - Write tools in custom MCP connectors are confirmed only for Business and Enterprise/Edu. Pro appears limited to read and fetch, Plus is unclear, and no official page says whether EEA accounts are excluded [db-eu 9][others ChatGPT].
  - **The check:** Tim opens ChatGPT's settings and confirms that developer mode is available and that a custom connector can be added with write tools.
- **Gemini: Antigravity CLI only.**
  - The Gemini app's custom MCP apps require being "18 or over and in the US" [db-eu 11].
  - Gemini's memory import is not offered in the EEA, Switzerland or the UK [db-eu 11].
  - Gemini CLI stopped serving Google AI Pro/Ultra and free personal accounts on 2026-06-18, so Antigravity CLI is the route [others CLIs].
- **Microsoft Copilot: out of scope.** The consumer Copilot has no custom MCP support, and Microsoft 365 Copilot needs a work tenant and licence [others Microsoft].

## 3. Session plan

Every session follows the working agreements:
- Node 22 first on PATH;
- check the installed library API in `node_modules` before writing against it;
- scaffold with the official CLI at its latest version;
- an independent Opus review before each commit, at most two rounds;
- tests stay green;
- `STATUS.md` updated.

Effort is a rough guess at Claude Code session time.

Provider spend means LLM API credit. Any session that spends it tells the coordinator first. Sessions never create accounts or type secrets into a website; they prepare the steps and Tim does them.

Sessions 1, 2 and 3 do not depend on each other. Sessions 1 and 2 both touch the composition root, so they run one after the other.

### 0. Tim's real bank (minutes, with Tim)

- **Scope:**
  - On the laptop's database: `admin create-bank`, a principal for Tim and a principal for Claude Code, grants, an API key, and `set-extractor`.
  - Re-register Claude Code against the new bank with `claude mcp add` (see `src/attachment/README.md`).
  - Tim uses it from Claude Code at once. Session 4 moves it to the hosted database.
- **Done when:** Claude Code recalls from and retains into the real bank.
- **Spend:** cents of extraction; tell the coordinator.
- **Depends on:** nothing.

### 1. Any Postgres, through any pooler

- **Scope:**
  - **Pooler compatibility:** find and remove anything transaction mode forbids [db-eu 7b]:
    - `hnsw.iterative_scan`, sent when connecting in `src/platform/postgres/pool.ts`, moves to `SET LOCAL` inside recall's transaction. A database-level setting is not used, because a dump of mem's schemas would not carry it to a new database;
    - the migration runner's session-level advisory lock becomes a transaction-scoped lock in each migration's transaction, with the applied-migrations check repeated under it. The runner's bootstrap, which creates the migration table, takes the same lock;
    - any other session state outside a transaction, named prepared statements and `LISTEN`/`NOTIFY`.
  - **Migrations as a step:** `npm run db:migrate` reads `DATABASE_URL` and now works through any pooler. Local `npm start` may still migrate at boot; serverless functions never do.
  - **Out of `public`:** the migration table moves from `public` into a `platform` schema, so nothing of mem's sits where Supabase's Data API looks. The runner's bootstrap moves an existing `public.schema_migrations` under its lock, so the laptop's databases and the dump session 4 restores keep their history.
  - **The `vector` extension's schema:** a migration fixes the schema `vector` lives in, so every dump names a schema each restore can create it in (D7).
  - **A backup URL:** `DATABASE_DIRECT_URL` is read by the backup and restore tooling only, and is required there.
  - **A local pooler:** a PgBouncer service in transaction mode in `docker-compose.yml`, and a script that runs the suite through it. The retrieval contract tests in `test/retrieval/` must be part of that run.
  - **`GET /readyz`:** checks Postgres, the pinned embedding dimensions and the age of the oldest pending work. `/healthz` stays liveness only.
  - **Vector size:** measure bytes per indexed item, and decide whether to switch to half-precision vectors, which pgvector's HNSW index supports.
    - If it switches, the change ships with a reindex step.
    - The reindex's `maintenance_work_mem`, fixed at 1 GB in `src/retrieval/infrastructure/pgvector/pin-dimensions.ts`, becomes configurable, because Supabase Free has about 500 MB of memory [db-eu 7].
  - **`docs/operations.md`:** the only Postgres features mem needs (Postgres 17, `vector`, plain SQL), and how to point mem at any such database.
- **Done when:**
  - The suite passes directly and through PgBouncer, migrations and retrieval contract tests included.
  - A test shows filtered recall still returns every matching row through the pooler.
  - The storage measurement is recorded.
- **Effort:** about 1 day.
- **Spend:** none.
- **Depends on:** nothing.

### 2. Background work without loops

- **Scope:**
  - **Composition:** split `src/attachment/rest/main.ts` into a `compose()` that builds the app, pool and handlers with no timers, and a thin Node entry point that adds the loops for `npm start`.
  - **No boot work on every cold start:** today's start-up runs an embedder probe that calls OpenAI, runs start-up queries, and calls `process.exit` on misconfiguration. On Vercel each new instance would pay for that before its first answer, while Claude gives OAuth endpoints 10 seconds [claude Q2]. The probes move into `/readyz` and are cached per instance, and misconfiguration throws instead of exiting.
  - **One drain:** `drainOnce({ deadline })` runs the outbox relay, then extraction, then erasure, until the queues are empty or the deadline nears.
    - It never starts a model call that could outlive the deadline, so `LLM_TIMEOUT_MS` must stay well under it.
    - The Node loops call the same function, so there is one code path.
  - **Drain endpoint:** `/internal/drain`, accepting GET and POST with `Authorization: Bearer <CRON_SECRET>`, compared in constant time, so cron-job.org and Vercel's cron use the same secret. It replies 202 at once and drains after the response through an injected scheduler, which is Next.js `after()` on Vercel and a plain promise under Node.
  - **After a request:** retain and erasure requests schedule a drain the same way.
  - **Heartbeat:** a successful drain pings a configurable dead-man's-switch URL, at most every five minutes.
- **Done when:** tests show that:
  - a drain stops before its deadline;
  - two overlapping drains never process the same episode or erasure;
  - work from a drain killed mid-run is retaken after its claim goes stale;
  - the endpoint refuses a missing or wrong secret;
  - `npm start` behaves as before.
- **Effort:** about 1 day.
- **Spend:** none.
- **Depends on:** nothing; run after session 1.

### 3. Extraction model check and switch

- **Scope:**
  - **Setup:**
    - issue a new `eval-runner` key; the old one is revoked (STATUS);
    - Tim provides a Google AI API key with billing for the Gemini candidate. `GOOGLE_GENERATIVE_AI_API_KEY` is commented out in `.env.example` today.
  - **Run:**
    - rerun arm B on the LoCoMo 40-question subset with each D5 candidate, using `EVAL_B_EXTRACTOR`, `EVAL_BANK_SUFFIX` and `--filter-providers B-pgvector`;
    - compare with `npm run eval:ci` [ops 5];
    - set and record effort and thinking settings explicitly for each model;
    - confirm that `EVAL_B_EXTRACTOR` accepts Google model names, which is unverified [ops 5].
  - **Decide:**
    - apply the D5 rule;
    - switch Tim's bank with `admin set-extractor`, and make the winner the configured default extractor that new banks get, replacing Opus 5.5;
    - write the result into `eval/RESULTS.md`.
  - **Clean up:** erase the eval banks, as in earlier cleanups.
- **Done when:** a results table with cost and score per model, the decision recorded, and Tim's bank on the chosen model.
- **Effort:** about half a day plus run time.
- **Spend:**
  - About 5.6 USD for the three candidates: 0.8, 1.1 and 3.8 USD each, including answering and grading [ops 5].
  - Allow up to 11 USD for reasoning tokens and retries.
  - Tell the coordinator before starting.
- **Depends on:** D5, session 0.

### 4. Next.js and the Vercel deployment

- **Scope** (per D1, D3):
  - **Scaffold and merge** Next.js into this package as D3 describes, with webpack and the `extensionAlias` setting.
  - **Mount** the Hono app in route handlers that keep today's URLs, with `@hono/vercel`.
  - **Runtime:** functions pinned to `fra1`, `maxDuration` set on the drain route, and the pool attached with `attachDatabasePool`.
  - **Rate limits:** the Postgres-backed store of D8, keyed by the client address Vercel provides. A test proves a spoofed header from the client cannot change the bucket.
  - **Triggers:** wire the session 2 drain to `after()`, the cron-job.org job and a daily Vercel cron. Vercel's cron runs only on production [vercel 1].
  - **Environments:**
    - production uses the Supabase production project, and its build runs `npm run db:migrate`;
    - preview deployments use the second Supabase project, and their builds migrate that one, so a preview never touches production data;
    - passkeys are bound to the D9 domain and do not work on preview URLs, so previews are checked through the API with a key;
    - Vercel's login gate covers preview deployments, so API checks there send Vercel's automation bypass header (`x-vercel-protection-bypass`) [vercel 8];
    - an admin CLI step seeds the empty preview database with a bank, a principal and a key.
  - **Pooler check:** run the retrieval contract tests once against Supabase's pooler on the preview project, because it is not PgBouncer.
  - **Tim's part,** with exact steps from the session:
    - create the Vercel, Supabase, cron-job.org, Healthchecks.io and Better Stack accounts;
    - create both Supabase projects at supabase.com in Frankfurt, not through the Vercel Marketplace, and turn off the Data API in each (D1);
    - set the secrets in Vercel's dashboard;
    - point the domain if D9 chose one.
  - **Move the real bank:**
    - dump the schemas on D7's list from the laptop, without owners or privileges;
    - in the empty production database, create the `vector` extension in the schema the dump names, then restore through `DATABASE_DIRECT_URL`, before the first migration;
    - erase the demo and eval banks there with `admin erase-bank`, leaving the laptop's `bank-demo` untouched;
    - compare row counts and verify the audit chain.
  - **Repoint Claude Code** at the public MCP URL with its API key, and add a `SessionStart` hook. The hook runs `curl --max-time 5` against `/readyz`, allowing for a cold start, and on failure prints a warning and exits 0, so Claude sees the warning and tells Tim [ops 3].
  - **Monitor:** a Healthchecks.io check fed by the drain heartbeat, with period plus grace of at most 10 minutes, and a Better Stack check on `/readyz`.
- **Done when:**
  - `https://<address>/readyz` answers from outside the home network with the laptop off.
  - A retain through Claude Code is extracted within a minute with no request after it.
  - In a planned 15-minute window, a wrong drain secret on the cron-job.org job makes Healthchecks email Tim, and fixing it clears the alert.
  - The MCP tests pass against the deployed URL, and the suite stays green locally.
- **Effort:** about 1.5 days.
- **Spend:** none on free plans; the domain if D9 picks one.
- **Depends on:** D9, sessions 1 and 2.

### 5. Backups and a tested restore

- **Scope:**
  - **Backup job:** a nightly GitHub Actions workflow.
    - `pg_dump -Fc --no-owner --no-privileges` of the schemas on D7's list only, against `DATABASE_DIRECT_URL`, with a client at least as new as the server;
    - upload with restic to R2 (D7). restic always encrypts, and losing its password loses the backups [ops 2];
    - retention of 7 daily plus 4 weekly copies with `forget --prune` [ops 2];
    - a Healthchecks.io ping as the dead-man's switch [ops 3];
    - the job records its last success where session 14's status page can read it.
  - **Public-repo rules:** no secret or row is ever printed, and no dump becomes a workflow artifact.
  - **Restore drill:** a monthly workflow loads the newest dump into a throwaway plain Postgres-with-pgvector service container, creating the `vector` extension first, then compares row counts and verifies the audit chain. Passing on plain Postgres is what proves criterion 10.
  - **Erasure and backups:**
    - The EDPB asks controllers to re-apply erasures on restored systems [ops 2].
    - Erasure receipts gain a "backup copies expire by" date.
    - **The erasure ledger** records bank ids, tenant deletions and receipt digests outside the database. Written at backup time instead, it would miss erasures made after the last dump.
      - R2 has no append, so each erasure writes its own object, named by its receipt digest, into a bucket kept only for the ledger. The token the erasure worker holds is scoped to that bucket.
      - The erasure itself completes in the database either way. Until its ledger object is written, the receipt shows "ledger pending", later drains retry the write, and `/readyz` reports any write still pending.
    - The restore script re-erases every bank and tenant in the ledger.
  - **The 60-day rule:** the runbook says how to re-enable the workflow if GitHub disables it (D7).
- **Done when:**
  - The drill passes end to end on plain Postgres.
  - A restored dump taken before a test erasure comes back with that bank erased again.
  - A missed backup triggers the dead-man's switch.
- **Effort:** about 1 day.
- **Spend:** none on free plans.
- **Depends on:** D7, session 4. Tenant deletion joins the ledger once session 10 builds it.

### 6. OAuth login server and user accounts

- **Scope** (per D2, D8):
  - **First:** check in `node_modules` whether `@better-auth/mcp` needs MCP SDK v2 at run time [oauth 2]. If it does, stop and run an SDK v2 migration session first (D2).
  - **Install:** better-auth with `@better-auth/mcp`, `@better-auth/cimd`, `jwt()` and `@better-auth/passkey`, at a pinned exact version, and no `oauthProvider()` beside `mcp()` [oauth 2]. Check whether better-auth's backup codes can sign in a user who has lost every passkey. If they cannot, recovery is a second passkey or Tim's admin link (D2).
  - **Schema:** generate it with `npx auth@latest generate`, which emits SQL [oauth 2], and commit it as a migration in our own runner, in an `identity` schema. better-auth reaches it without a connect-time `search_path`, which a transaction pooler would drop (D1).
  - **Mount** it in the Hono app.
  - **Metadata:** authorization-server metadata that advertises PKCE S256, CIMD with `"none"`, and RFC 9207 `iss` [claude Q1, Q2].
  - **Registration:**
    - DCR off;
    - a CIMD host allowlist [oauth 8];
    - exact redirect matching, except loopback on any port for Claude Code and the CLIs [claude Q5].
  - **Tokens:** access tokens of 15 minutes or less and rotated refresh tokens [oauth 8].
  - **Accounts:**
    - sign-up off except through an invitation, checked in the passkey plugin's `resolveUser` hook [oauth 6];
    - accepting one creates the user, tenant, first bank with the configured default extractor, principal and grants in one transaction;
    - a passkey bound to the D9 domain, and a prompt to enrol a second one.
  - **Isolation guard:** every new table that holds a user's data joins the guard's scoped list with its tenant column, and better-auth runs on the guarded pool in tests.
  - **Admin CLI:**
    - attach a new auth user to an existing tenant and its human principal, so Tim's account takes over the tenant and bank from session 0;
    - create invitations;
    - a one-time recovery link for a user who lost their passkey and codes;
    - registering a bank's MCP URL as a resource, which `create-bank` then does automatically;
    - listing and revoking OAuth clients.
  - **Consent page:** names the app, the redirect host, the scopes and the bank, offers only the user's own banks, and has CSRF protection [oauth 6].
  - **Guards [oauth 8]:**
    - rate limits on `/authorize` and `/token`, because today's limiter covers only `/v1`;
    - `frame-ancestors 'none'` on the login and consent pages.
- **Done when:**
  - Tests drive a full authorization-code-plus-PKCE flow with a test CIMD client.
  - Each of these is refused: a wrong redirect, a missing PKCE verifier, a CIMD URL on a host outside the allowlist, a sign-up without an invitation, a reused invitation, a consent naming another user's bank, and a framed consent page.
  - A form-encoded token request works.
- **Effort:** about 2.5 days.
- **Spend:** none.
- **Depends on:** D2, D9, session 4.

### 7. OAuth on the MCP endpoint, principals for apps, first consumer app

- **Scope:**
  - **Metadata:**
    - per-bank PRM at the path-aware well-known URL; the SDK's default discovery breaks for endpoints under a path like ours (SDK issue #2751) [oauth 1];
    - its `resource` is the bank's MCP URL [claude Q2];
    - an unauthenticated MCP call gets a 401 with `WWW-Authenticate` pointing at that metadata [claude Q1].
  - **Token check:**
    - better-auth's `requireMcpAuth` for signature, issuer, audience and expiry [oauth 2];
    - the audience is compared in canonical form [claude Q2];
    - if `requireMcpAuth` cannot fit our per-bank route, use `jose`, added as a direct dependency because it is only an indirect one today.
  - **Principals:**
    - one `integration` Principal per OAuth client in the user's tenant, with a Grant on that bank [oauth 7];
    - scopes mapped to read and write;
    - the Scope resolver branches on token shape, so API keys keep working.
  - **Rate limits:** a verified OAuth token is limited per principal, because claude.ai and ChatGPT users share their vendors' addresses (D2). Today only key-shaped tokens get their own bucket (`src/attachment/rest/app.ts`).
  - **Tool annotations:** add `destructiveHint: false` to `recall` and `list_facts`. Every other annotation is already set in `src/attachment/mcp/server.ts`, and ChatGPT's Apps SDK requires all three hints on every tool [others ChatGPT].
  - **First clients:**
    - Claude Code over OAuth on loopback [claude Q5];
    - then claude.ai on the web. It is the strictest client documented [claude Q2], so it is tested here rather than at the end.
    - Record the host Claude's hosted apps fetch their CIMD from, and add it to the allowlist.
  - **Passkey fallback:** if claude.ai's sign-in pop-up cannot use the passkey, add better-auth's two-factor plugin (TOTP) [oauth 6].
- **Done when:**
  - Tests cover:
    - a token for bank A refused on bank B;
    - a token from one user refused on another user's bank;
    - two users connecting through the same address keep separate rate-limit buckets;
    - a revoked client refused on its very next request while its token is still unexpired;
    - `erase` impossible to obtain through OAuth;
    - an API-key client unchanged.
  - The bank-isolation query guard passes on the new statements.
  - Claude Code and claude.ai on the web each complete recall and retain over OAuth.
- **Effort:** about 1.5 days.
- **Spend:** a few cents of extraction for test retains; tell the coordinator.
- **Depends on:** session 6.

### 8. Retain policy, guards and spending caps

- **Scope** (per D6, D8):
  - **Wording:**
    - rewrite the `retain` tool description and the server instructions; the policy goes in both, because apps may ignore instructions [retain 3];
    - the instructions open with a self-contained summary in their first 512 characters, as ChatGPT's guidance advises [others ChatGPT];
    - keep Claude Code's 4,096-character instruction cut in mind [claude Q5].
  - **Recall-loop guard:** a triage reason that skips extraction when the retained text only restates a current fact, found by similarity against current facts. A count of skips is kept for the GUI.
  - **Limits:**
    - a per-principal daily retain cap;
    - a never-store list checked in code beside the existing secret detection.
  - **Cost ledger:** one row per model call, extraction and embedding alike, with the tenant, the model, the tokens and the cost. The table joins the isolation guard's scoped list.
    - The row is written before the call with an estimated cost, and completed with the real tokens after it. A process Vercel kills at the deadline runs no more code, so its row keeps the estimate, marked as one.
    - The estimate counts toward the cap from the moment of the claim, so overlapping drains cannot all start calls for a tenant that is near its cap.
  - **Spending caps:**
    - a price table per model, with its date;
    - month-to-date spend per tenant from the ledger;
    - at the cap, extraction runs wait in a "capped" state that the GUI shows, and they resume next month or when Tim raises the cap;
    - embeddings are counted but never blocked (D8);
    - `admin set-cap` and `admin spend` commands.
  - **Fairness:** extraction claims rotate between tenants instead of first come, first served (`src/extraction/infrastructure/postgres/run-store.ts`).
  - **Replay test:** a small set of sample conversations, with no model calls, to check the guards.
- **Done when:** tests for each guard; a test where a tenant at its cap keeps storing and recalling while its extraction waits; a test where one tenant's backlog does not delay another's next extraction. The new descriptions are recorded in the attachment README.
- **Effort:** about 1.5 days.
- **Spend:** none.
- **Depends on:** D6, D8, session 2.

### 9. Connect the remaining apps

- **Scope:**
  - **Connect, in order:**
    - Claude Desktop and the Claude phone app, which reuse claude.ai's connector from session 7 [claude Q2];
    - ChatGPT developer mode on the web, if Tim's plan allows it [others ChatGPT];
    - Antigravity CLI for Gemini, with an API key as a static header [others CLIs];
    - Codex CLI, over OAuth with CIMD or with an API key [others CLIs].
  - **Compatibility table:** record each app's real behaviour, meaning write prompts, instructions honoured and annotations shown. Several of these are undocumented [claude Q3][others summary].
- **Done when:** criterion 1 holds for every app Tim's plans allow, and the table is in `src/attachment/README.md`.
- **Effort:** about 1 day.
- **Spend:** cents of extraction; tell the coordinator.
- **Depends on:** sessions 7 and 8, and Tim's checks.

### 10. GUI v1, part 1: the session and data access

- **Scope:** the server-side reads and actions the GUI needs that REST lacks today. Today's REST covers retain (episodes), recall, asserting a fact, facts as of a date, a single fact, confirm, dispute, export and erasure (see `src/attachment/README.md`). New, as application-layer queries and commands that Server Components and Server Actions call:
  - a fact's history: what it superseded and what superseded it, on both time axes;
  - the source episodes of a fact, as verbatim quotes;
  - a paged audit-log listing filtered by principal or fact, plus a per-fact "read by" list;
  - the list of connected apps (principals) with last use and revoke;
  - undo for confirm and dispute (back to the previous provenance state);
  - an erasure dry run that returns the inventory counts without deleting;
  - a `correct` command. The user's corrected statement becomes an Episode written by them from source `gui`, plus a fact that supersedes the old one, built on the existing fact-assert path. It never edits in place [gui-products Q4];
  - **export that survives size:** today's export returns a whole bank in one response body (`src/attachment/rest/app.ts`), and Vercel caps bodies at 4.5 MB [vercel 2]. Export streams or pages, or is written to R2 behind a short-lived link, and `list_facts` over MCP pages too;
  - **account deletion** as D8 describes, with its new erasable stores and its entry in the session 5 ledger.
- **Access rules:**
  - Every read and action resolves the signed-in user's principal and goes through the same access policy as REST.
  - The receipt view reads through the owner's tenant-level access, because the bank's grants go with an erasure (STATUS, erasure).
- **Done when:** tests for every query and command, including CSRF refusal, a session refused on another user's bank, an export larger than 4.5 MB, an account deletion that leaves no row of the tenant behind except its chosen proof, and bank isolation through the query guard.
- **Effort:** about 2 days.
- **Spend:** none.
- **Depends on:** D4, sessions 5, 6 and 8.

### 11. GUI v1, part 2: browse what mem believes

- **Scope** (per D3):
  - **Setup:** `npx shadcn@latest init` (never `--monorepo`) and `npx shadcn@latest add` for table, drawer, dialog, date picker and badge; `npm init playwright@latest` for end-to-end tests.
  - **Pages:**
    - a facts table showing status, valid-from/to, recorded-at, which app wrote it, and a "show superseded" toggle;
    - search through `recall`;
    - an "as of" date picker with a visible banner and a one-click return to now;
    - a detail drawer with the source quotes;
    - a history timeline that labels "when it was true" and "when mem learned it" separately. Zep's two time axes and Gemini's memory history list are the closest precedents [gui-products Q1, Q3].
  - **Tests:** Playwright against the local Next.js server through its `webServer` setting [gui-stack Q5].
- **Done when:** Tim can find a fact, read its source and see what it replaced on the public address, and the Playwright suite passes.
- **Effort:** about 2 days.
- **Spend:** none.
- **Depends on:** session 10.

### 12. GUI v1, part 3: act on it

- **Scope:**
  - **Fact actions:** confirm and dispute with undo, and correct, which opens a supersede form.
  - **Export:** a plain, always-available button for JSONL and Markdown. Mem0 locks export behind its paid cloud, and we should not copy that [gui-products Q1].
  - **Erase:**
    - a dry-run preview of what goes, derived facts included;
    - typing the bank name;
    - a passkey re-check;
    - the receipt shown afterwards.

    Supermemory's preview-before-forget, documented for its API, is the model [gui-products Q1].
  - **Audit:** the audit log page filterable by app, and a "read by" panel per fact.
  - **Connected apps:** a page with revoke.
  - **Account:** export everything, and delete the account (D8), with a passkey re-check and a receipt.
- **Done when:** criterion 5 holds in a timed walk-through, and the Playwright suite covers each action.
- **Effort:** about 2 days.
- **Spend:** none.
- **Depends on:** session 11.

### 13. Opening mem to invited users

- **Scope** (per D8):
  - **Operator role:** the flag on Tim's account that D8 describes. The access policy checks it, and every cross-tenant statement it allows is tagged and allowlisted in the query guard.
  - **Invitations:** a page where Tim creates, lists and revokes invitation links, each with a cap.
  - **Privacy notice:** a page listing what mem stores, why, the processors, where data goes, and how to export or delete it. Tim reviews the text before it goes live.
  - **Cross-tenant tests:** two test users, with every REST route, MCP tool, OAuth flow, Server Component and Server Action tried from one against the other. The tests below the browser run under the query guard; the Playwright ones check behaviour only.
  - **Guard coverage:** confirm every table added since session 6 is on the guard's scoped list.
  - **Independent isolation review:** an Opus reviewer given the code and none of our conclusions.
  - **A first test user:** Tim invites a second account of his own and walks through sign-up, connecting Claude, retaining, the cap, export and account deletion.
- **Done when:** criterion 9 holds, the test user's walk-through passes, and Tim has read the privacy notice. Only then does a real invitation go out.
- **Effort:** about 2 days.
- **Spend:** cents of extraction; tell the coordinator.
- **Depends on:** sessions 7, 8 and 12.

### 14. GUI polish

- **Scope:**
  - A "new this week" review queue of freshly extracted facts, newest first, with confirm and dispute in place. It also shows the loop guard's skip count, which feeds criterion 7.
  - Per-app pause, from OpenMemory's access controls [gui-products Q1]. Backend: a suspended state on a grant that the Scope resolver honours.
  - A cost panel: month-to-date spend against the cap for each user, and, for Tim, the database size from `pg_database_size()` against the 500 MB limit. Vercel's and Supabase's other usage stays in their dashboards, so mem calls no vendor management API.
  - A status page that shows readiness, the last drain and the last backup.
  - A phone-friendly layout.
  - Optional: a two-axis time view [gui-products Q3].
- **Done when:** Tim runs the weekly review from his phone in under five minutes.
- **Effort:** about 2 days, splittable.
- **Spend:** none.
- **Depends on:** sessions 5, 8 and 12.

### 15. Seed from and hand back to the apps' own memory

- **Scope:**
  - **Paste-in box:** a GUI box, "paste memories from another app", backed by a new endpoint. Each line becomes an imported Episode with source provenance, and extraction runs as usual within the user's cap. Where the lines come from:
    - Claude can write out its memory verbatim or include it in the account export [claude Q6];
    - ChatGPT's memory list can be copied by hand from its settings [db-eu 12];
    - Gemini's memory import is not offered in the EEA [db-eu 11]. Whether its memory summary can be viewed and copied from the EU is checked first [others Gemini memory].
  - **Hand-back:** an endpoint and GUI buttons for the existing `render-import` targets (the Claude and Gemini paste formats, CLI-only today), plus a new ChatGPT target. That target is a "remember the following" message, because ChatGPT has no import feature or memory API [others ChatGPT memory].
- **Done when:**
  - Tim's existing memories from each app he uses are in mem with provenance.
  - For each target app, a fresh render is pasted in and a spot check of 10 items finds them in that app's memory view. ChatGPT may merge or drop pasted items, so its check counts what survived [others ChatGPT memory].
- **Effort:** about 1 day.
- **Spend:** extraction of the imported lines, likely well under 1 USD on Haiku; tell the coordinator.
- **Depends on:** sessions 3, 8 and 12.

Later, only if measurement asks for it:
- the Claude Code session-end batch (option C of D6), if the weekly review shows durable facts being missed;
- Vercel Workflows for the drain, if drains prove too slow or too short (D1);
- bring-your-own-key for invited users, if mem opens wider (D8);
- the remaining chat-export importers already listed in STATUS.

## 4. Risks

- **Hobby limits stop features for up to 30 days.** There is no paid overage on Hobby [vercel 5]. The 360 GB-hours of memory, about 180 hours of function time a month, are the limit most likely to bite, because waiting on the model counts. Vercel's dashboard shows usage, and Tim checks it weekly until the pattern is known; Pro is the way out.
- **cron-job.org is a free service with no stated uptime promise or operator** [vercel 13]. Vercel's daily cron and the after-request drains cover an outage, and the dead-man's switch reports one.
- **Supabase Free has no backups, 500 MB, and pauses after a week without use** [db-eu 7, 7b]. Session 5's backups, the storage measurement of session 1, and Supabase Pro at $25 a month cover these.
- **Supabase's pooler is not PgBouncer.** The local PgBouncer run proves the code avoids session state, but Supavisor may treat edge cases differently. Session 4 runs the retrieval tests against it before Tim's data moves.
- **Cold starts.** A new Vercel instance opens database connections and loads the app before its first answer. Session 2 keeps provider calls out of start-up, and the Claude Code hook allows 5 seconds.
- **Scheduled backups can stop quietly.** GitHub disables scheduled workflows in a public repo after 60 days without activity. The dead-man's switch reports it (D7).
- **Response size.** Vercel caps bodies at 4.5 MB [vercel 2], so any endpoint that returns a whole bank must stream or page (session 10).
- **Webpack instead of Turbopack.** Our import style needs webpack until the Turbopack fix lands [vercel 12]. If Next.js drops webpack first, the fallback is a codemod that rewrites the imports to `.ts` with TypeScript's `rewriteRelativeImportExtensions`.
- **ChatGPT access depends on a plan we could not verify** [db-eu 9]. The worst case is no access on Tim's plan; the middle case is recall without retain. Tim's check settles it before session 9.
- **Undocumented app behaviour.**
  - Whether Claude's hosted apps honour server instructions is undocumented [claude Q3].
  - ChatGPT's behaviour when a server is down is undocumented [ops 3].
  - Sessions 7 and 9 measure these instead of assuming, and the retain policy lives in the tool description too.
- **A second MCP SDK major.** `@better-auth/mcp` is installed together with MCP SDK v2 while mem runs v1 [oauth 2]. Vercel's `mcp-handler` needs v2 as well [vercel 11]. Session 6 checks this first; the answer may add an SDK migration session or switch D2 to its fallback.
- **Passkeys inside the apps' sign-in pop-ups are untested** [oauth 6]. Session 7 adds TOTP if they fail.
- **better-auth churn and its advisory history** [oauth 2]. We pin the version, use only the listed plugins, and keep `oidc-provider` and WorkOS as documented fallbacks.
- **Spec drift.**
  - The installed MCP SDK speaks protocol revisions up to 2025-11-25, while the spec is now 2026-07-28, which removes sessions and the initialize handshake [claude Q1].
  - The hosted Claude apps document 2025-11-25 [claude Q2], so we stay put until an app requires more, or until session 6 forces SDK v2.
- **One user reaching another's data.** Mitigations:
  - every statement scoped to a bank, enforced by the query guard;
  - cross-tenant tests over every entry point;
  - an independent review before the first invitation (session 13).
- **A public endpoint is an attack surface.** Mitigations:
  - OAuth with audience checks;
  - DCR off;
  - CIMD hosts allowlisted;
  - sign-up by invitation only;
  - rate limits keyed on the principal for verified tokens, and on the real client address for the login endpoints and unauthenticated calls;
  - no erase over OAuth [oauth 8].
- **Other users' spend.** Caps stop extraction at the limit, and a cheaper extraction model (session 3) stretches every cap.
- **Privacy duties toward invited users** (D8). Tim reviews the privacy notice and the processors' agreements before the first invitation.
- **Memory as a channel for prompt injection.** Text one app retains is later read by another, so a stored instruction could steer an assistant. Facts are shown to models as data, the GUI review shows what was stored, and this is one more reason not to add an `assert_fact` tool.
- **Authorship rests on the model's word.** Extraction trusts the calling model's `verbatim` flag (D6). The recall-loop guard and the weekly review are the defences that do not.
- **Cheaper extraction may be worse in ways 40 questions cannot show.** The MDD is 10-27 points [ops 5]. The weekly review (criterion 7) is the second check, and switching back is one `set-extractor` call.
- **Backups outlive erasure.** Handled by the expiry date on receipts and erasure replay on restore (session 5) [ops 2]. Bucket versioning must be checked so the window stays bounded.
- **A public repo.** Plans, research and code are visible to anyone. Secrets stay in `.env` and the vendors' dashboards, and backup workflows never print data.
- **The apps' built-in memories keep competing.** Each app still has its own memory [claude Q6][others ChatGPT memory, Gemini memory]. Session 15 seeds mem from them and hands mem back as their import format, so mem stays the system of record rather than one more silo.

## 5. What we deliberately leave out

- **Smarter retrieval and engine work.** The spike found no accuracy gain for one person's history (`spike-results.md`). Hindsight and Honcho stay in Docker for evals only.
- **Any Supabase feature beyond Postgres** (D1): its SDK, Auth, Storage, Cron, Realtime, Edge Functions, `pg_net`, the Data API and the Vercel Marketplace integration.
- **Vercel-specific code in the domain** (D3), and Vercel Workflows or Queues for now (D1).
- **A laptop tunnel or a VPS** (D1). The earlier research on them stays in [expose] for a later move.
- **TanStack Start, a Vite SPA or a separate GUI repo** (D3). npm workspaces and shadcn's `--monorepo` mode are out for the same reason.
- **Self-hosted identity servers** (Keycloak and the others) and the MCP SDK's own authorization-server helpers (D2).
- **Open sign-up, open dynamic client registration and IP allowlists** (D2, D8).
- **Row-level security.** Isolation stays in the code, enforced by the query guard, as Tim chose.
- **Billing, paid plans and bring-your-own-key** (D8), until mem opens wider.
- **Erase or admin over MCP or OAuth.** Erasure stays a human action in the GUI, REST or CLI.
- **A hook that retains every message, and approval-before-save for every memory.** No major assistant does the latter, and it would make retain a chore [retain 1, 6].
- **Writing into the apps' built-in memory through an API.** None of the three offers one [others summary].
- **The Gemini app and Microsoft Copilot.** The Gemini app's connectors are US-only [db-eu 11]; Copilot has no custom MCP for consumers, and 365 needs a work tenant [others Microsoft].
- **A browser extension, an OpenAI-compatible proxy and a mobile app.** ARCHITECTURE section 7 already rules out the extension; the others add a surface without a measured need.
- **A graph view and other visual extras before the weekly review proves useful.**

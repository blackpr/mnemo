# Plan: from working backend to daily driver

Written 2026-10-28. This is a research-backed plan only; no application code was written for it.

**Sources:**
- The external research is in `research_notes/Mem daily driver plan/`: eight notes files, each with dated, cited sources.
- It is summarised in `reports/Mem daily driver plan.md`.
- It builds on the earlier landscape research (`Self hosted AI memory layer landscape.md`) and on `spike-results.md`.

**How citations work here.** Every claim about an external product points at a notes file and section, in square brackets:

| Key | File in `research_notes/Mem daily driver plan/` |
|---|---|
| [claude] | `mcp_auth_spec_and_claude_clients.md` (the MCP auth spec, claude.ai, Claude Desktop, Claude Code, Claude's memory) |
| [others] | `chatgpt_gemini_copilot_mcp.md` (ChatGPT, the Gemini app, Microsoft Copilot, Codex CLI, Antigravity CLI) |
| [expose] | `exposure_tunnels_and_hosting.md` (tunnels, VPS hosting, laptop sleep, vendor IP ranges) |
| [oauth] | `oauth_options.md` (OAuth libraries and services, mapping onto principals) |
| [gui-products] | `gui_memory_products.md` (what other memory products show users) |
| [gui-stack] | `gui_stack_and_repo_shape.md` (front-end stacks, repo shape, GUI login) |
| [ops] | `macos_ops_and_extraction_model.md` (auto-start, backups, health checks, extraction model prices) |
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
- **TLS:** the encryption behind HTTPS.
- **DDoS:** a flood of traffic meant to knock a site over.
- **CORS:** the browser rule for calls between sites.
- **CSRF:** a forged request from another website riding on your login cookie.
- **XSS:** script injected into a web page.

**Sign-in (OAuth)**
- **MCP:** Model Context Protocol, how AI apps call tools on our server.
- **OAuth:** the standard "sign in and grant this app access" flow; OAuth 2.1 is the current version.
- **Authorization server:** the login part. It signs Tim in and hands out tokens.
- **Resource server:** the part that holds data and checks tokens; for us, the MCP endpoint.
- **Bearer token:** whoever holds it gets in. Today's API keys are bearer tokens.
- **Access token:** a short-lived bearer token.
- **Refresh token:** lets an app get a new access token without Tim signing in again.
- **JWT:** a signed token our server can check without a database call.
- **Issuer:** the authorization server that signed a token.
- **Audience:** the server a token is meant for; for us, one bank's MCP URL.
- **PKCE:** a one-time secret that stops a stolen login code being reused.
- **DCR (Dynamic Client Registration):** an app registers itself with our login server on first contact.
- **CIMD (Client ID Metadata Document):** instead of registering, the app's client id is a URL that serves a small JSON description of the app.
- **PRM (Protected Resource Metadata):** a JSON file on our server that tells an app where to sign in.
- **Passkey:** a sign-in key stored on Tim's devices instead of a password.
- **TOTP:** six-digit codes from an authenticator app.

**Hosting and networking**
- **VPS:** a small rented Linux server.
- **Loopback:** the machine talking to itself (127.0.0.1 or `localhost`).
- **Tailnet:** Tailscale's private network between your own devices.

**Front end**
- **SPA:** a single-page web app built to static files.

**Operations**
- **Liveness:** "the process answers".
- **Readiness:** "the process and its database work".
- **Dead-man's switch:** an alarm that fires when an expected ping does not arrive.

**Privacy law**
- **GDPR:** the EU data protection law; UK GDPR is the UK's version.
- **ICO:** the UK regulator.
- **EDPB:** the board of EU regulators.
- **EEA:** the EU plus Iceland, Liechtenstein and Norway.

**Our eval**
- **JSONL:** one JSON object per line.
- **LoCoMo:** the public long-conversation benchmark we ran.
- **Arm B:** our pgvector-plus-extraction setup in that eval.
- **extract-v3:** our current extraction prompt.
- **MDD:** minimum detectable difference, the smallest score gap our eval can tell apart from noise.

## 1. Goal

Make `mem` the one memory that Claude, ChatGPT, Gemini and the coding tools all read from and write to, every day, without Tim thinking about it. That means:
- reachable from the consumer chat apps;
- always on;
- backed up;
- cheap to run;
- visible through a GUI where Tim can see what it believes and where each belief came from, correct it, and take it with him.

The spike showed that for one person's history full context answers as well as any memory engine, so this plan spends nothing on cleverer retrieval. The value is owning the facts and moving them between providers. Every session below serves reachability, trust, operations or portability.

### What "Tim would definitely use it" means (checkable)

1. **Reachable everywhere he chats.** With his real bank (not `bank-demo`), each of these lists mem's tools and completes one `recall` and one `retain`:
   - **Claude Code.**
   - **Claude's hosted apps**, meaning claude.ai on the web, Claude Desktop and the phone app. They share one connector and one sign-in, so they appear as one principal [claude Q2].
   - **ChatGPT on the web**, if Tim's plan allows custom MCP servers. `retain` only works if the plan also allows write tools (section 2, "Checks").
   - **Gemini**, through the Gemini app if his account qualifies, otherwise through Antigravity CLI.
   - **Codex CLI.**

   The audit log shows one principal per app.
2. **Always on.** After a reboot, no manual step is needed.
   - **On a VPS (D1):** an external monitor on the public URL shows at least 99% uptime over 14 days.
   - **On the laptop:** the local watchdog's log shows no failed readiness check over 14 days. An outside monitor cannot tell sleep from failure.
3. **Fails loudly.** When memory is down, Claude Code says so at session start and a macOS notification appears within 5 minutes.
4. **Backed up.** A daily encrypted backup is off the machine, and a restore drill passed within the last 30 days (row counts match, audit chain verifies).
5. **Trustworthy through the GUI.** In under a minute Tim can:
   - find what mem believes about a topic;
   - read the source quote and which app wrote it;
   - correct it;
   - see the old version in its history;
   - see which apps read it.

   Export and erase work from the GUI.
6. **Cheap.** Extraction spend at his real volume stays under 1 USD a day, read from the `extraction.runs` ledger.
7. **Not junk.** In a weekly review of newly extracted facts, fewer than 1 in 5 is disputed as wrong or useless. The GUI also shows how many retains the recall-loop guard of session 7 skipped, and the review finds no fact whose source is an assistant restating something mem had just recalled.
8. **Used.** Over two consecutive weeks, the audit log shows reads from at least two different apps on at least five days of each week.

## 2. Decisions Tim must make

Each decision lists the options, a recommendation and the reason. Sessions in section 3 say which decision they wait on.

### D1. Hosting and exposure: where mem runs and how the apps reach it

The consumer apps connect from their vendors' clouds, not from Tim's devices, so mem needs a public HTTPS address:
- claude.ai connects from Anthropic's range `160.79.104.0/21`, IPv4 only, and refuses private and loopback addresses [claude Q2].
- ChatGPT connects from OpenAI's published egress addresses [others ChatGPT].
- The Gemini app and Microsoft's products also call out from their clouds [others summary].
- Only Claude Code, Codex CLI and Antigravity CLI connect from the local machine [claude Q5][others CLIs].

| Option | Cost | Setup | URL | Security exposure | Notes |
|---|---|---|---|---|---|
| A. Laptop + Cloudflare named tunnel | $0 plus a domain, about $10.46/yr (third-party price list; reported to rise about $0.71 on 2026-11-01) [expose 3] | A domain on Cloudflare DNS, `cloudflared` | Stable custom hostname; one tunnel serves several hostnames, each to its own local port [expose 3] | Cloudflare terminates TLS, so it can read traffic; DDoS protection; free Access login for a GUI hostname [expose 1] | Dark when the Mac sleeps (error 1033) [expose 1, 5] |
| B. Laptop + Tailscale Funnel | $0, no domain [expose 1] | Tailscale on the Mac | Stable `<device>.<tailnet>.ts.net` name, no custom domain, ports 443/8443/10000 only, unpublished bandwidth limits; Funnel is in Beta and the docs are possibly stale [expose 1, 2] | TLS ends on the Mac, so Tailscale cannot read traffic [expose 1] | Dark when the Mac sleeps; Tailscale Serve can carry a tailnet-only GUI [expose 1] |
| C. ngrok | Free tier puts a warning page in front of HTML pages (our login page) and has monthly quotas; $10/mo removes it [expose 1, 2] | Agent on the Mac | Stable assigned domain | ngrok terminates TLS | Weakest fit for an OAuth login page |
| D. Small VPS + `cloudflared` (or Caddy) | About €6-8/mo at Hetzner (ordering may currently be blocked) or $6-12/mo at DigitalOcean [expose 4] | Provision, patch the OS, run Postgres and Node | Same hostname as option A when the tunnel moves with it | No open inbound ports with `cloudflared` [expose 4] | The only option that stays up while the laptop sleeps or travels [expose 1, 5] |
| E. Managed platform + managed Postgres | From about $25-38/mo; free tiers pause, expire or drop backups [expose 4] | Least server work | Stable | Provider holds the data | Costs more than D for one person |

A plain Cloudflare Access login in front of the MCP address would block the vendors' servers, because they get a redirect they cannot follow [expose 2]. So the MCP hostname is left without Access, while the GUI hostname can sit behind it [expose 2].

**Recommendation:** option A now, moving to option D once OAuth and the app connections work (session 9).
- **Hostnames:** one domain with two hostnames on the same tunnel. A public `mem.` hostname carries MCP and OAuth; a `gui.` hostname sits behind a Cloudflare Access login.
- **Listeners:** each hostname goes to its own loopback port of the same server process, so a request to `mem.` can never reach the GUI (session 4).

**Reason:**
- **Always on:** a sleeping, travelling laptop cannot be an always-on endpoint [expose 5]. Criterion 2 on a VPS, and Tim chatting from his phone at any hour, need a host that does not sleep.
- **Hostname survives the move:** a custom hostname on a named tunnel stays the same when the server moves to a VPS. Connectors added in claude.ai, ChatGPT and Gemini then keep working.
- **Why not Funnel:** Tailscale Funnel's name is tied to a device and cannot be a custom domain [expose 1].

**What Tim gives up:** Cloudflare terminates TLS and could read memory traffic in transit [expose 1]. If that is unacceptable:
- use option B on the laptop, and accept a new hostname (with every connector re-added) when moving;
- or use option D with Caddy terminating TLS on the VPS, which can keep the custom domain.

**Also Tim's call:** whether personal memory may live on a rented server at all.

### D2. Auth approach: how the chat apps sign in

None of the consumer apps can use today's API keys:
- claude.ai needs OAuth; static request headers are a beta limited to some organisations [claude Q2].
- ChatGPT explicitly does not support API keys or custom headers [others ChatGPT].

So OAuth is required for every consumer app.

Requirements, from the spec and the apps:
- **Spec:** the MCP spec in force is revision 2026-07-28. It deprecates DCR in favour of CIMD [claude Q1].
- **Which apps use CIMD:** claude.ai, ChatGPT, Claude Code and Codex CLI can all use CIMD [claude Q2, Q5][others ChatGPT, CLIs].
  - claude.ai uses it only when the server's metadata advertises `client_id_metadata_document_supported: true` together with `"none"` as a token-endpoint auth method; otherwise it falls back to DCR [claude Q2].
- **Which apps do not:** the Gemini app uses DCR or manual client credentials entered under "Advanced", and Antigravity CLI uses DCR or a manual client [others Gemini app, CLIs].
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
| Hosted (WorkOS AuthKit, Clerk, Auth0, Descope) | CIMD and DCR advertised by all four; mem becomes only a token checker. Free tiers far exceed one user (WorkOS: first 1M monthly users) [oauth 4]. | An external sign-in dependency for a system whose point is not depending on a provider. Whether the free tiers include CIMD and DCR is unverified, and Auth0's DCR support comes from a third-party table [oauth 4]. |
| Cloudflare Access managed OAuth or MCP server portal | Cloudflare runs OAuth, and a portal can call mem with today's API key, so mem writes no OAuth code [expose 2]. | Ties identity to Cloudflare, which warns against combining it with your own OAuth. Not confirmed end to end with claude.ai, ChatGPT or Gemini [expose 2]. |
| Keycloak, authentik, Zitadel, Ory Hydra | Full identity servers. | A poor fit [oauth 5]:<br>• **Keycloak:** CIMD and resource indicators are experimental flags, it does not support ChatGPT's CIMD, and it needs about 1.25 GB of RAM.<br>• **Zitadel:** ignores `resource`.<br>• **authentik:** no DCR.<br>• **Hydra:** no resource indicators. |

**Recommendation:** better-auth, embedded in the Hono server with its tables in their own `auth` schema.
- **Plugins:** `@better-auth/mcp` (which is itself the OAuth provider, so `oauthProvider()` is not registered as well), `@better-auth/cimd`, `jwt()` and `@better-auth/passkey` [oauth 2].
- **Registration:**
  - CIMD on, so Claude's apps, ChatGPT, Claude Code and Codex CLI need no registration step.
  - CIMD fetches go only to an allowlist of hosts: chatgpt.com, claude.ai, and whatever host Claude's hosted apps use, which Anthropic does not publish and session 6 reads from the first attempt [claude Q2][oauth 8].
  - DCR stays off, which removes the open-registration risk [oauth 8].
  - The Gemini app and Antigravity CLI get a pre-registered client created from our admin CLI. Its credentials go into the app's "Advanced" settings.
  - If manual credentials fail for Gemini, DCR is turned on in session 8 with registrations limited to the bank's resource (`clientRegistrationAllowedResources` [oauth 2]) and our own redirect-host check. better-auth documents no such check, so that part would be our code.
- **Login:**
  - A passkey for Tim, enrolled once through a link the admin CLI prints, with recovery codes. Sign-up is off [oauth 6].
  - The passkey is bound to the registrable domain so the same passkey works for OAuth sign-in on `mem.` and for the GUI on `gui.`.
  - If an app's sign-in pop-up cannot use a passkey (untested [oauth 6]), session 6 adds better-auth's two-factor plugin for TOTP.
- **Consent:** a page that names the app, its redirect host, the scopes and the bank. It is CSRF-protected and cannot be framed by another site [oauth 6].
- **Resource side:** better-auth's `requireMcpAuth` [oauth 2], with each bank's MCP URL registered as a resource when the bank is created.
- **First step of session 5:** check whether `@better-auth/mcp` needs MCP SDK v2 at run time. If it does, moving mem's MCP server to SDK v2 (whose `@modelcontextprotocol/hono` package exists [oauth 1]) becomes its own session before session 5.
- **Fallbacks:**
  - If session 5 finds a blocker, fall back to panva `oidc-provider`, accepting the adapter and page work [oauth 3].
  - WorkOS is the least-code fallback if Tim accepts an external sign-in dependency [oauth 4].

**Reason:** it is the one option that covers every requirement above as a maintained library rather than code we write, which is Tim's first working agreement. It also gives the GUI its login for free (D4).

Its risks are manageable:
- pin the exact version;
- enable only the plugins listed;
- keep access tokens at 15 minutes or less with rotated refresh tokens;
- re-check grants in Postgres on every request, so revoking an app takes effect at once even while its token is still valid [oauth 7, 8].

The identity mapping stays inside our model [oauth 7]:
- **One principal per app:** each connected app becomes one Principal of kind `integration`, keyed by issuer plus client id.
- **Bank from the token:** its Grant is on exactly the bank named by the token's audience, which is the bank's MCP URL.
- **Scopes:** `mem:read` and `mem:write` map to the read and write capabilities. `erase` and `admin` are never offered over OAuth.
- **API keys:** they keep working beside OAuth for Claude Code and scripts. The resolver tells the two apart by token shape.

### D3. GUI stack and repo shape

The rule is one repo, one package, no monorepo.
- Every official scaffolder (`create-next-app`, `create-vite`, TanStack's CLI, `create-react-router`, `create-astro`) generates a standalone project with its own `package.json`. None adds a GUI to an existing package in place [gui-stack Q1].
- npm workspaces manage several packages by definition, so they count as a monorepo under the rule [gui-stack Q3].
- shadcn's `--monorepo` mode is a multi-package Turborepo, which the rule forbids [gui-stack Q2].

| Shape | Against the rule |
|---|---|
| **GUI built to static files, served by the same Hono process** | **Keeps it.** One `package.json`, one production process, one deployable. Only development adds a Vite dev server [gui-stack Q3]. |
| **Next.js inside this package** | **Bends it moderately.** One `package.json` only after merging the scaffold by hand, and a second production process (`next start`) unless reduced to static export. Static export loses cookies, server actions, request-dependent route handlers and dynamic routes without pre-generated params. It also adds about 192 MB for `next` plus a 90 MB native compiler [gui-stack Q1, Q3]. |
| **Separate repo** | **Breaks it outright.** Two repos, two deployables, and cross-site cookies or CORS between them [gui-stack Q3]. |

Other stacks considered [gui-stack Q1]:
- **TanStack Start** (`npx @tanstack/cli@latest create`). Declared stable only on 2026-10-13. It runs its own Nitro server (its bundled Node server) as a second process, and has no documented way to run inside Hono. It had a reflected-XSS advisory on 2026-09-30.
- **Hono's own JSX with htmx.** No build step and no new framework, but no React, so no shadcn/ui.
- **React Router 8 and Astro 7.** Both need a newer Node (22.22+ and 22.23.4+) than the 22.17 installed here.

**Recommendation:** a Vite + React SPA with shadcn/ui, in a `web/` folder of this package, built into `dist/web` and served by Hono's `serveStatic`.
- **Scaffold:** run `npm create vite@latest` (react-ts template) into a scratch folder, merge its dependencies and scripts into the root `package.json`, and drop its own.
- **Config:** add `vite.config.ts` and a second `tsconfig.web.json`. A second tsconfig is not a second package [gui-stack Q1].
- **shadcn/ui:** run `npx shadcn@latest init` against `web/` with `-c` (never `--monorepo`). What it does when `web/` has no `package.json` is unconfirmed, so the session checks it first [gui-stack Q2].

Two known snags [gui-stack Q1]:
- **TypeScript versions:** the Vite template pins TypeScript 7 while the repo is on 5.9, and TypeScript 7 rejects `baseUrl`, which shadcn's Vite guide adds. Stay on 5.9 for the GUI session and use `paths` without `baseUrl`; upgrade TypeScript separately.
- **No typed client:** Hono's typed RPC client would not see our routes as they are written, so the GUI uses a small hand-written fetch client with the zod schemas we already have.

**Reason:** it is the only shape that keeps the rule, and shadcn/ui gives the tables, drawers and dialogs the minimum GUI needs. Every other stack either brings a second server or gives up what makes it worth using [gui-stack Q1, Q3].

### D4. How the GUI authenticates

RFC 10017 (the browser-apps best practice, August 2026) gives three points [gui-stack Q4]:
- A GUI served from the same origin as its API can use a plain server-side cookie session; it need not be an OAuth client.
- If OAuth is used, a backend that keeps tokens away from the browser is "strongly recommended" for personal data.
- A browser-held token with PKCE is the weakest pattern.

Options:
- **(a) Local only.** Bind the GUI to 127.0.0.1, with no login. This is only safe while nothing else can reach that port. Once a tunnel runs on the same machine, it also connects from loopback [gui-stack Q4].
- **(b) Cookie session from our own login.** The same passkey login as D2, with the cookie set to `__Host-`, HttpOnly, Secure and SameSite=Strict, plus a CSRF check [gui-stack Q4].
- **(c) The GUI as its own OAuth client in the browser.** The weakest pattern.
- **(d) Tailnet-only through Tailscale Serve.** Tailscale vouches for who is asking, so there is no public login page at all. This is the strongest posture the research found, but only if nothing else can reach the GUI's port [gui-stack Q4].

**Recommendation:** (b), on the private `gui.` hostname behind Cloudflare Access (D1), served from its own loopback port.
- **Ports:**
  - only the tunnel's `gui.` route points at the GUI port, and the `mem.` port refuses GUI paths;
  - the GUI port accepts only the session cookie;
  - the MCP and REST ports stay bearer-only.
- **CSRF:** Hono's built-in `csrf()` does not check JSON requests, so the GUI API checks `Origin`/`Sec-Fetch-Site` and requires a custom header [gui-stack Q4].
- **Re-authentication:** export and erase ask for the passkey again.
- **Cookies stay apart:** the GUI's cookie is tied to the `gui.` host only. The OAuth sign-in on `mem.` keeps its own short-lived login cookie, so the GUI session never travels to the public MCP hostname.
- **If Tim already runs Tailscale on his devices:** (d) is stronger.

**Reason:** it reuses the D2 login with no extra library, follows the RFC's same-origin advice, and the separate port closes the path around the Access login [gui-stack Q4].

### D5. Extraction model

Every retained statement costs one extraction call.

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
  - Hooks or imports would raise volume.
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
3. If none passes, stay on Opus 5.5 and rely on the retain policy to keep volume, and so cost, down.

OpenAI's gpt-6-luna is priced like Haiku but is left out: its strict schema mode needs our zod `.optional()` fields changed to `.nullable()`, which is a code change [ops 4].

**Reason:**
- **Small spend:** the check costs about 5.6 USD [ops 5].
- **Large upside:** it removes extraction cost as a reason not to retain, whatever the volume turns out to be.
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
- **(C) A Claude Code session-end batch:** a hook extracts once per session from Tim's own turns into a "candidate" state that expires unless confirmed.

A hook that retains every message is the firehose the audit warns against [retain 6].

**Recommendation:** (A) everywhere now, with four guards:
- always honour an explicit "remember that";
- never store the categories Claude never saves, such as government IDs and financial account numbers [retain 1];
- skip extraction when the retained text only restates a current fact, which breaks the recall→retain loop;
- cap retains per app per day.

Consider (C) only after two weeks of GUI review show durable facts being missed. The research report recommends adding (C) for Claude Code from the start. This plan waits because (C) adds a review chore and its benefit is unmeasured for us, while the weekly review (criterion 7) will show whether it is needed.

**Reason:**
- **Authorship:** extraction only runs on text the calling model marks as the user's own words (`verbatim: true` in `src/attachment/mcp/server.ts`). That already removes the audit's largest junk sources when the model marks honestly. mem cannot verify authorship [retain 2].
- **What is left:** transient task state and the recall loop. The guards target those, and the loop guard does not depend on the model's honesty.

### D7. Backup destination (small)

| Option | Cost |
|---|---|
| Backblaze B2 | 10 GB free; its pricing page is possibly stale [ops 2] |
| Cloudflare R2 | 10 GB free [ops 2] |
| Hetzner Storage Box | €3.20/month for 1 TB [ops 2] |

**Recommendation:** R2. A few GB fit the free tier, and it stays independent of whichever VPS provider D1 picks.

**Check first:** the bucket's object-version settings. Kept old versions would lengthen how long erased data survives in backups; this was an open question for B2 [ops 2].

### Checks only Tim can do (they decide which apps are in scope)

- **ChatGPT plan.**
  - Custom MCP servers run in ChatGPT on the web through developer mode. Each write asks for confirmation, which can be remembered for one conversation [others ChatGPT].
  - Which plans get this could not be verified: OpenAI's help centre refused automated reads, and the search extracts and secondary sources disagree [others ChatGPT]:
    - the extracts give full read and write to Business and Enterprise/Edu, and read/fetch only to Pro;
    - Plus is contested;
    - one secondary source says Free, Plus and Pro cannot add a custom server at all.
  - Mobile is not supported per those extracts.
  - **Worst case:** no ChatGPT access on his plan.
  - **The check:** Tim opens Settings in his own account and confirms developer mode and write tools are available.
- **Gemini app eligibility.**
  - Custom MCP apps in the consumer Gemini app need the US, age 18 or over, a personal Google account, English and Keep Activity on. The plan tier is contested between secondary sources [others Gemini app].
  - Otherwise Gemini reaches mem only through Antigravity CLI, because Gemini CLI stopped serving Google AI Pro/Ultra and free personal accounts on 2026-06-18 [others CLIs].
  - Gemini's memory import is not offered in the EEA, Switzerland or the UK [others Gemini memory].
- **Claude plan.**
  - Free Claude accounts are capped at one custom connector [claude Q2].
  - Each bank is its own connector, because the bank id is in the URL [claude Q2].
- **Microsoft Copilot.**
  - The consumer Copilot has no custom MCP support.
  - Microsoft 365 Copilot needs a work tenant and licence [others Microsoft].
  - Out of scope unless Tim has one.

## 3. Session plan

Every session follows the working agreements:
- Node 22 first on PATH;
- check the installed library API in `node_modules` before writing against it;
- an independent Opus review before each commit, at most two rounds;
- tests stay green;
- `STATUS.md` updated.

Effort is a rough guess at Claude Code session time.

Provider spend means LLM API credit. Any session that spends it tells the coordinator first.

### 0. Tim's real bank (minutes, with Tim)

- **Scope:**
  - `admin create-bank`, a principal for Tim and a principal for Claude Code, grants, an API key, and `set-extractor`.
  - Re-register Claude Code against the new bank with `claude mcp add` (see `src/attachment/README.md`).
  - The bank id becomes part of every connector URL, so it is chosen once.
- **Done when:** Claude Code recalls from and retains into the real bank.
- **Spend:** cents of extraction; tell the coordinator.
- **Depends on:** nothing.

### 1. Auto-start, readiness and loud failure (laptop)

- **Scope:**
  - **Docker:**
    - add `restart: unless-stopped` to the `db` service, which has none today [ops 1];
    - document turning on "Start Docker Desktop when you sign in", which is off by default [ops 1];
    - stop using `npm run db:down` day to day, because `docker compose down` removes the container [ops 1].
  - **LaunchAgent for `npm start`:** absolute nvm `node` path, `WorkingDirectory`, explicit `PATH`, `KeepAlive`, `ThrottleInterval`, and a wrapper that waits for Postgres [ops 1].
  - **`GET /readyz`:** checks Postgres and the workers. `/healthz` stays liveness only and today does not touch the database [ops 3].
  - **Watchdog:** a launchd job that curls `/readyz`, logs the result and raises a macOS notification on failure [ops 3].
  - **Claude Code `SessionStart` hook:**
    - runs `curl --max-time 2` against `/readyz`;
    - on failure prints a warning to stdout and exits 0, so Claude sees the warning and tells Tim. Exit code 2 would show it to Tim but not to Claude [ops 3].
  - **`docs/operations.md`.**
  - **Native Postgres:** [ops 1] rates Homebrew `postgresql@17` plus `pgvector` under `brew services` as more reliable than Docker. This session keeps Docker only because D1 moves the live database to a VPS in session 9. If Tim keeps the laptop as host, this session switches to native Postgres instead.
- **Done when:**
  - After a reboot and login, `claude mcp list` shows mem connected with no manual step.
  - Stopping the database produces a notification within 5 minutes and a warning at the next Claude Code session start.
  - Tests for `/readyz`.
- **Effort:** about half a day.
- **Spend:** none.
- **Depends on:** session 0.

### 2. Backups and a tested restore

- **Scope:**
  - **Backup job:**
    - a daily `pg_dump -Fc` from a launchd calendar job, which runs at wake if the Mac slept through the time [ops 2];
    - upload with restic to the D7 target. restic always encrypts, and losing its password loses the backups [ops 2];
    - retention of 7 daily plus 4 weekly copies with `forget --prune` [ops 2];
    - a Healthchecks.io ping from the job as a dead-man's switch, free for 20 checks [ops 3];
    - the job records its last success where session 13's status page can read it.
  - **Restore script:** loads the newest dump into a scratch database, compares row counts and verifies the audit chain.
  - **Erasure and backups:**
    - The ICO accepts backup copies kept until they are overwritten on a set schedule, if they are "beyond use" and the person is told [ops 2].
    - The EDPB asks controllers to re-apply erasures on restored systems [ops 2].
    - Erasure receipts therefore gain a "backup copies expire by" date.
    - A small erasure ledger (bank ids and receipt digests) is kept outside the dumps, and the restore script re-erases any bank in it.
    - Purely personal processing is probably outside the UK GDPR (from a search summary of ICO pages), so this is a product promise rather than a legal duty [ops 2].
- **Done when:**
  - The drill passes end to end.
  - A restored dump taken before a test erasure comes back with that bank erased again.
  - A missed backup triggers the dead-man's switch.
- **Effort:** about 1 day.
- **Spend:** none (free storage tier) or €3.20/month.
- **Depends on:** D7.

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
    - switch Tim's bank with `admin set-extractor`;
    - write the result into `eval/RESULTS.md`.
  - **Clean up:** erase the eval banks, as in earlier cleanups.
- **Done when:** a results table with cost and score per model, the decision recorded, and Tim's bank on the chosen model.
- **Effort:** about half a day plus run time.
- **Spend:**
  - About 5.6 USD for the three candidates: 0.8, 1.1 and 3.8 USD each, including answering and grading [ops 5].
  - Allow up to 11 USD for reasoning tokens and retries.
  - Tell the coordinator before starting.
- **Depends on:** D5, session 0.

### 4. Public address

- **Scope** (per D1):
  - **Domain and tunnel:** buy the domain and create a named Cloudflare Tunnel with two hostnames [expose 2, 3]:
    - `mem.`, with no Access app;
    - `gui.`, behind an Access login.
  - **Three loopback listeners in the one server process:**
    - **local port (today's 8787):** for Claude Code, the CLIs and scripts; no proxy headers trusted;
    - **tunnel port:** only the `mem.` route points at it. It serves MCP and OAuth, takes the client address from `CF-Connecting-IP`, and refuses GUI paths;
    - **GUI port:** only the `gui.` route points at it.

    This keeps one process and one package, and stops a `mem.` request from reaching the GUI. It also fixes rate limiting: behind a tunnel, every caller would otherwise share one address bucket (STATUS, rate limits).
  - **No IP allowlist.** Anthropic's range is stable, but OpenAI's list is best-effort, the notes found no list for Google, and the login pages are loaded from Tim's own browser from any address [expose 6].
  - **Monitor:** an external uptime monitor on the public URL [ops 3].
  - **Who can connect yet:** no consumer app, because they all need OAuth [claude Q2][others summary]. Until session 6 the public MCP endpoint is guarded by today's API keys and rate limits. Codex CLI and Antigravity CLI can already use it with a key [others CLIs].
- **Done when:**
  - `https://mem.<domain>/healthz` answers from outside the home network.
  - The `gui.` hostname shows the Access login.
  - Tests show that the tunnel port rate-limits by the forwarded address, the local port ignores that header, and the tunnel port refuses GUI paths.
- **Effort:** about half a day.
- **Spend:** the domain, about $10.46/yr [expose 3].
- **Depends on:** D1.

### 5. OAuth login server

- **Scope** (per D2):
  - **First:** check in `node_modules` whether `@better-auth/mcp` needs MCP SDK v2 at run time [oauth 2]. If it does, stop and run an SDK v2 migration session first (D2).
  - **Install:** better-auth with `@better-auth/mcp`, `@better-auth/cimd`, `jwt()` and `@better-auth/passkey`, at a pinned exact version, and no `oauthProvider()` beside `mcp()` [oauth 2].
  - **Schema:** generate it with `npx auth@latest generate`, which emits SQL [oauth 2], and commit it as a migration in our own runner, in an `auth` schema.
  - **Mount** it on the tunnel port.
  - **Metadata:** authorization-server metadata that advertises PKCE S256, CIMD with `"none"`, and RFC 9207 `iss` [claude Q1, Q2].
  - **Registration:**
    - DCR off;
    - a CIMD host allowlist [oauth 8];
    - exact redirect matching, except loopback on any port for Claude Code and the CLIs [claude Q5].
  - **Tokens:** access tokens of 15 minutes or less and rotated refresh tokens [oauth 8].
  - **Admin CLI:**
    - a one-time passkey enrolment link plus recovery codes, with sign-up off;
    - a pre-registered client for apps without CIMD;
    - registering a bank's MCP URL as a resource, which `create-bank` then does automatically;
    - listing and revoking OAuth clients.
  - **Passkey:** bound to the registrable domain.
  - **Consent page:** names the app, the redirect host, the scopes and the bank, with CSRF protection [oauth 6].
  - **Guards [oauth 8]:**
    - rate limits on `/authorize` and `/token`, because today's limiter covers only `/v1`;
    - `frame-ancestors 'none'` on the login and consent pages.
- **Done when:**
  - Tests drive a full authorization-code-plus-PKCE flow with a test CIMD client.
  - Each of these is refused: a wrong redirect, a missing PKCE verifier, a CIMD URL on a host outside the allowlist, a second sign-up, and a framed consent page.
  - A form-encoded token request works.
- **Effort:** about 2 days.
- **Spend:** none.
- **Depends on:** D2, session 4.

### 6. OAuth on the MCP endpoint, principals for apps, first consumer app

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
    - one `integration` Principal per OAuth client, with a Grant on that bank [oauth 7];
    - scopes mapped to read and write;
    - the Scope resolver branches on token shape, so API keys keep working.
  - **Tool annotations:** add `destructiveHint: false` to `recall` and `list_facts`. Every other annotation is already set in `src/attachment/mcp/server.ts`, and ChatGPT's Apps SDK requires all three hints on every tool [others ChatGPT].
  - **First clients:**
    - Claude Code over OAuth on loopback [claude Q5];
    - then claude.ai on the web through the public hostname. It is the strictest client documented [claude Q2], so it is tested here rather than at the end.
    - Record the host Claude's hosted apps fetch their CIMD from, and add it to the allowlist.
  - **Passkey fallback:** if claude.ai's sign-in pop-up cannot use the passkey, add better-auth's two-factor plugin (TOTP) [oauth 6].
- **Done when:**
  - Tests cover:
    - a token for bank A refused on bank B;
    - a revoked client refused on its very next request while its token is still unexpired;
    - `erase` impossible to obtain through OAuth;
    - an API-key client unchanged.
  - The bank-isolation query guard passes on the new statements.
  - Claude Code and claude.ai on the web each complete recall and retain over OAuth.
- **Effort:** about 1.5 days.
- **Spend:** a few cents of extraction for test retains; tell the coordinator.
- **Depends on:** sessions 4 and 5.

### 7. Retain policy, tool descriptions and guards

- **Scope** (per D6):
  - **Wording:**
    - rewrite the `retain` tool description and the server instructions; the policy goes in both, because apps may ignore instructions [retain 3];
    - the instructions open with a self-contained summary in their first 512 characters, as ChatGPT's guidance advises [others ChatGPT];
    - keep Claude Code's 4,096-character instruction cut in mind [claude Q5].
  - **Recall-loop guard:** a triage reason that skips extraction when the retained text only restates a current fact, found by similarity against current facts. A count of skips is kept for the GUI.
  - **Caps and limits:**
    - a per-principal daily retain cap;
    - a never-store list checked in code beside the existing secret detection.
  - **Replay test:** a small set of sample conversations, with no model calls, to check the guards.
- **Done when:** tests for each guard; the new descriptions are recorded in the attachment README.
- **Effort:** about 1 day.
- **Spend:** none.
- **Depends on:** D6.

### 8. Connect the remaining apps

- **Scope:**
  - **Connect, in order:**
    - Claude Desktop and the Claude phone app, which reuse claude.ai's connector from session 6 [claude Q2];
    - ChatGPT developer mode on the web, if Tim's plan allows it [others ChatGPT];
    - the Gemini app with a pre-registered client, or Antigravity CLI if Tim's account does not qualify [others Gemini app, CLIs];
    - Codex CLI.
  - **Gemini's redirect URI:** it is undocumented [others Gemini app], so it is read from the app's settings or its first attempt and checked with Tim before it is allowed. If manual credentials fail, enable DCR as described in D2.
  - **Compatibility table:** record each app's real behaviour, meaning write prompts, instructions honoured and annotations shown. Several of these are undocumented [claude Q3][others summary].
- **Done when:** criterion 1 holds for every app Tim's plans allow, and the table is in `src/attachment/README.md`.
- **Effort:** about 1 day.
- **Spend:** cents of extraction; tell the coordinator.
- **Depends on:** sessions 6 and 7, and Tim's checks.

### 9. Move to an always-on host (if D1 says VPS)

- **Scope:**
  - **Provision:**
    - the VPS. Hetzner showed limited availability on 2026-10-28, so DigitalOcean is the fallback [expose 4];
    - Postgres 17 with pgvector;
    - the Node server under systemd with the same three listeners;
    - `cloudflared` with the same tunnel and hostnames [expose 4];
    - unattended security updates.
  - **Backups:** move the backup job of session 2 to the VPS.
  - **Data:** restore from the latest backup, which doubles as a real restore drill.
  - **Repoint the laptop's tools at the VPS:**
    - re-register Claude Code against `https://mem.<domain>/v1/banks/<id>/mcp`, over OAuth or with its key;
    - point the `SessionStart` hook and the watchdog at the public `/readyz`.

    Otherwise Claude Code keeps writing to the laptop.
  - **Cut over.** The laptop keeps a dev database only.
- **Done when:**
  - Criterion 2 holds over 14 days.
  - The connectors from sessions 6 and 8 work without being re-added, and their refresh tokens survive the move.
  - The laptop's Postgres receives no retains after cutover.
- **Effort:** about 1 day.
- **Spend:** about €6-8/month, or $6-12/month on DigitalOcean.
- **Depends on:** D1, sessions 2 and 8.

### 10. GUI v1, part 1: the API and the login session

- **Scope:** endpoints the GUI needs that REST lacks today. Today's REST covers retain (episodes), recall, asserting a fact, facts as of a date, a single fact, confirm, dispute, export and erasure (see `src/attachment/README.md`). New:
  - a fact's history: what it superseded and what superseded it, on both time axes;
  - the source episodes of a fact, as verbatim quotes;
  - a paged audit-log listing filtered by principal or fact, plus a per-fact "read by" list;
  - the list of connected apps (principals) with last use and revoke;
  - undo for confirm and dispute (back to the previous provenance state);
  - an erasure dry run that returns the inventory counts without deleting;
  - a `correct` command. Tim's corrected statement becomes an Episode written by him from source `gui`, plus a fact that supersedes the old one, built on the existing fact-assert path. It never edits in place [gui-products Q4].
- **Access rules:**
  - All of it is on the GUI port, accepts only the D4 session cookie, and uses the Origin plus custom-header CSRF check [gui-stack Q4].
  - The receipt view reads through the owner's tenant-level access, because the bank's grants go with an erasure (STATUS, erasure).
- **Done when:** tests for every endpoint, including CSRF refusal and bank isolation through the query guard.
- **Effort:** about 1.5 days.
- **Spend:** none.
- **Depends on:** D4, session 5.

### 11. GUI v1, part 2: browse what mem believes

- **Scope** (per D3):
  - **Scaffold:**
    - `npm create vite@latest` (react-ts) into a scratch folder, merged into this package's `web/`;
    - `npx shadcn@latest init` (never `--monorepo`) and `npx shadcn@latest add` for table, drawer, dialog, date picker and badge;
    - `npm init playwright@latest` for end-to-end tests.
  - **Serving:** Hono's `serveStatic` for `dist/web` on the GUI port in production; the Vite dev server proxies the GUI API in development.
  - **Pages:**
    - a facts table showing status, valid-from/to, recorded-at, which app wrote it, and a "show superseded" toggle;
    - search through `recall`;
    - an "as of" date picker with a visible banner and a one-click return to now;
    - a detail drawer with the source quotes;
    - a history timeline that labels "when it was true" and "when mem learned it" separately. Zep's two time axes and Gemini's memory history list are the closest precedents [gui-products Q1, Q3].
  - **Tests:** Playwright against `npm start` through its `webServer` setting [gui-stack Q5].
- **Done when:** Tim can find a fact, read its source and see what it replaced in the browser on the `gui.` hostname, and the Playwright suite passes.
- **Effort:** about 2 days.
- **Spend:** none.
- **Depends on:** D3, session 10.

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
- **Done when:** criterion 5 holds in a timed walk-through, and the Playwright suite covers each action.
- **Effort:** about 2 days.
- **Spend:** none.
- **Depends on:** session 11.

### 13. GUI polish

- **Scope:**
  - A "new this week" review queue of freshly extracted facts, newest first, with confirm and dispute in place. It also shows the loop guard's skip count, which feeds criterion 7.
  - Per-app pause, from OpenMemory's access controls [gui-products Q1]. Backend: a suspended state on a grant that the Scope resolver honours.
  - An extraction cost panel. Backend: a per-day read of `extraction.runs`.
  - A status page that shows readiness and the last backup, the latter from the record session 2's job keeps.
  - A phone-friendly layout.
  - Optional: a two-axis time view [gui-products Q3].
- **Done when:** Tim runs the weekly review from his phone in under five minutes.
- **Effort:** about 2 days, splittable.
- **Spend:** none.
- **Depends on:** session 12.

### 14. Seed from and hand back to the apps' own memory

- **Scope:**
  - **Paste-in box:** a GUI box, "paste memories from another app", backed by a new endpoint. Each line becomes an imported Episode with source provenance, and extraction runs as usual. Where the lines come from:
    - Claude can write out its memory verbatim or include it in the account export [claude Q6];
    - ChatGPT's memory summary can be copied [others ChatGPT memory];
    - Gemini's Memory summary can be viewed and copied, though Gemini has no export [others Gemini memory].
  - **Hand-back:** an endpoint and GUI buttons for the existing `render-import` targets (the Claude and Gemini paste formats, CLI-only today), plus a new ChatGPT target. That target is a "remember the following" message, because ChatGPT has no import feature or memory API [others ChatGPT memory].
- **Done when:**
  - Tim's existing memories from each app are in mem with provenance.
  - For each target app, a fresh render is pasted in and a spot check of 10 items finds them in that app's memory view. ChatGPT may merge or drop pasted items, so its check counts what survived [others ChatGPT memory].
- **Effort:** about 1 day.
- **Spend:** extraction of the imported lines, likely well under 1 USD on Haiku; tell the coordinator.
- **Depends on:** sessions 3 and 12.

Later, only if measurement asks for it:
- the Claude Code session-end batch (option C of D6), if the weekly review shows durable facts being missed;
- the remaining chat-export importers already listed in STATUS.

## 4. Risks

- **ChatGPT access depends on a plan we could not verify** [others ChatGPT]. The worst case is no access on Tim's plan; the middle case is recall without retain. Tim's check in section 2 settles it before session 8.
- **Undocumented app behaviour.**
  - Whether Claude's hosted apps honour server instructions is undocumented [claude Q3].
  - The Gemini app's redirect URI and annotation handling are undocumented [others Gemini app].
  - ChatGPT's behaviour when a server is down is undocumented [ops 3].
  - Sessions 6 and 8 measure these instead of assuming, and the retain policy lives in the tool description too.
- **A second MCP SDK major.** `@better-auth/mcp` is installed together with MCP SDK v2 while mem runs v1 [oauth 2]. Session 5 checks this first; the answer may add an SDK migration session or switch D2 to its fallback.
- **Passkeys inside the apps' sign-in pop-ups are untested** [oauth 6]. Session 6 adds TOTP if they fail.
- **better-auth churn and its advisory history** [oauth 2]. We pin the version, use only the listed plugins, and keep `oidc-provider` and WorkOS as documented fallbacks.
- **Spec drift.**
  - The installed MCP SDK speaks protocol revisions up to 2025-11-25, while the spec is now 2026-07-28, which removes sessions and the initialize handshake [claude Q1].
  - The hosted Claude apps document 2025-11-25 [claude Q2], so we stay put until an app requires more, or until session 5 forces SDK v2.
- **Cloudflare sees traffic in transit under D1's recommendation** [expose 1]. The trade is named in D1; Tailscale Funnel or Caddy on a VPS avoids it.
- **A public endpoint is an attack surface.** Mitigations:
  - OAuth with audience checks;
  - DCR off;
  - CIMD hosts allowlisted;
  - rate limits keyed on the real client address, including on the login endpoints;
  - the GUI on its own port behind Access;
  - no erase over OAuth [oauth 8].
- **Memory as a channel for prompt injection.** Text one app retains is later read by another, so a stored instruction could steer an assistant. Facts are shown to models as data, the GUI review shows what was stored, and this is one more reason not to add an `assert_fact` tool.
- **Authorship rests on the model's word.** Extraction trusts the calling model's `verbatim` flag (D6). The recall-loop guard and the weekly review are the defences that do not.
- **Cheaper extraction may be worse in ways 40 questions cannot show.** The MDD is 10-27 points [ops 5]. The weekly review (criterion 7) is the second check, and switching back is one `set-extractor` call.
- **Backups outlive erasure.** Handled by the expiry date on receipts and erasure replay on restore (session 2) [ops 2]. Bucket versioning must be checked so the window stays bounded.
- **Hosting availability.** Hetzner showed limited cloud availability on 2026-10-28 [expose 4]. DigitalOcean is the fallback.
- **The apps' built-in memories keep competing.** Each app still has its own memory [claude Q6][others ChatGPT memory, Gemini memory]. Session 14 seeds mem from them and hands mem back as their import format, so mem stays the system of record rather than a fourth silo.

## 5. What we deliberately leave out

- **Smarter retrieval and engine work.** The spike found no accuracy gain for one person's history (`spike-results.md`).
- **A browser extension, an OpenAI-compatible proxy and a mobile app.** ARCHITECTURE section 7 already rules out the extension; the others add a surface without a measured need.
- **Next.js, TanStack Start or a separate GUI repo.** They break or bend the one-package rule (D3). npm workspaces and shadcn's `--monorepo` mode are out for the same reason.
- **Self-hosted identity servers** (Keycloak and the others) and the MCP SDK's own authorization-server helpers (D2).
- **Open dynamic client registration and IP allowlists** (D2, session 4).
- **Erase or admin over MCP or OAuth.** Erasure stays a human action in the GUI, REST or CLI.
- **A hook that retains every message, and approval-before-save for every memory.** No major assistant does the latter, and it would make retain a chore [retain 1, 6].
- **Writing into the apps' built-in memory through an API.** None of the three offers one [others summary].
- **Microsoft Copilot (consumer and 365).** No custom MCP for consumers; 365 needs a work tenant [others Microsoft].
- **Multi-user hosting, row-level security and a shared rate-limit store.** One person, one instance.
- **A graph view and other visual extras before the weekly review proves useful.**

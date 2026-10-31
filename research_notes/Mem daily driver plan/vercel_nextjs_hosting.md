# Vercel + Next.js hosting for mem: what Vercel allows (Hobby vs Pro)

Scope: what Vercel allows for moving mem (Hono REST + stateless Streamable HTTP MCP, `pg` Pool to Postgres 17 + pgvector, three `setInterval` loops: outbox relay, LLM extraction worker at 10-60 s per job, erasure worker; all claim with `FOR UPDATE SKIP LOCKED`) to a Next.js app on Vercel, for an owner in the EU. Researched 2026-10-29, web only. Each fact gives its plan, source URL, and the page's own date. "Page date" is the page's `last_updated`/`lastUpdated` field. Some Vercel pages show `2018-10-20`, which is a placeholder; those are marked "fetched 2026-10-29". Anything not stated on an official page is in the Unverified list at the end.

## Decision summary

- **Hobby (free) works for background jobs and a private GUI, but only in event-driven form.** You cannot run per-minute timers on Hobby. Cron is limited to once a day with ±59 min precision (Q1). There are three event-driven options:
  - **Vercel Queues** (Beta, all plans, 1M operations/month free on Hobby). Push-mode consumers are private functions with automatic retries (Q3).
  - **Vercel Workflows** (GA since 2026-04-16). Hobby includes 50K events/month and 1 GB written (Q4).
  - **`after()` / `waitUntil`.** This work is bounded by the same 300 s Hobby limit (Q2).
- **Hobby has two caps that matter.**
  - Hobby is restricted to non-commercial personal use (Q5). mem fits that.
  - When a Hobby quota runs out, the feature stops until 30 days have passed. There is no paid overage.
- **Vercel Daemons** (Beta, all plans) is the closest match to today's always-on Node loops, but it is not viable on Hobby. A Hobby daemon is stopped once it reaches 420 GB-hours of memory in a month. A 2 GiB instance reaches that in about 9 days, so a continuous worker would be down for most of the month. Running all month needs Pro (Q5, Daemons section).
- **The private GUI on Hobby:** Vercel Authentication can now protect production at no cost on every plan (changelog 2026-09-09). The catch is that it gates whole deployments, not paths, so it would also block `/mcp` and `/.well-known/*` for Claude and ChatGPT. Two other levers:
  - WAF custom rules: 3 on Hobby. They can combine a path condition with a negated IP condition (Q8).
  - Password Protection: Pro only, at $20/month per project.
- **EU region:** Hobby can run functions in `fra1` (one region only) (Q7).
- **Two code-level blockers, independent of plan:**
  - **Turbopack** (the Next.js 16 default) does not map `./foo.js` to `./foo.ts`. The issue is open and the fix PR is unmerged (Q12).
  - **`mcp-handler` 2.x** requires MCP SDK v2 (`@modelcontextprotocol/server`). mem is on SDK v1 (Q11).

---

## 1. Cron Jobs

| Fact | Plan | Source (page date) |
|---|---|---|
| 100 cron jobs per project | Hobby, Pro, Enterprise | https://vercel.com/docs/cron-jobs/usage-and-pricing (2026-07-15); also https://vercel.com/docs/limits (2026-09-16) |
| Minimum interval **once per day**. An expression that runs more often fails at deploy with "Hobby accounts are limited to daily cron jobs" | Hobby | https://vercel.com/docs/cron-jobs/usage-and-pricing (2026-07-15) |
| Timing precision **per hour (±59 min)**. `0 1 * * *` fires anywhere between 1:00 and 1:59 | Hobby | same |
| Minimum interval **once per minute**, precision **per minute** | Pro, Enterprise | same |
| Cron invokes a normal Vercel Function, so function limits and pricing apply | all | same |
| Cron runs only on production deployments. The cron route is a public URL, so guard it with `CRON_SECRET` | all | https://vercel.com/kb/guide/how-to-run-background-jobs-in-nextjs-on-vercel (published 2026-08-24, updated 2026-08-25) |

## 2. Functions: max duration, `after()` / `waitUntil`

| Fact | Plan | Source (page date) |
|---|---|---|
| Fluid compute is on by default for new projects (since 2025-04-23) | all | https://vercel.com/docs/fluid-compute (2026-08-24) |
| Max duration, Node runtime, Fluid: **300 s default and 300 s maximum** | Hobby | https://vercel.com/docs/functions/configuring-functions/duration (2026-08-24); https://vercel.com/docs/functions/limitations (2026-08-24) |
| Max duration: **300 s default, 800 s max (GA), 1800 s "extended max" (Beta)**. Values above 800 s must be set per function, on Node 22/24, Bun, or Python 3.12-3.14 | Pro, Enterprise | same |
| Max duration includes time spent streaming the response. A timeout returns 504 `FUNCTION_INVOCATION_TIMEOUT` | all | https://vercel.com/docs/functions/limitations (2026-08-24) |
| Memory/CPU: 2 GB / 1 vCPU, fixed | Hobby | same; https://vercel.com/docs/limits (2026-09-16) |
| Memory/CPU: up to 4 GB / 2 vCPU | Pro | same |
| Request and response body limit 4.5 MB (413 `FUNCTION_PAYLOAD_TOO_LARGE`) | all | https://vercel.com/docs/functions/limitations (2026-08-24) |
| `waitUntil()` "extends the lifetime of the request handler" so work continues after the response is sent. "Promises passed to `waitUntil()` will have the same timeout as the function itself. If the function times out, the promises will be cancelled." | all | https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package (2026-09-03) |
| `getDeadline()` returns the shared invocation deadline. It "includes request processing and asynchronous `waitUntil` tasks", so after-response work **counts toward maxDuration** | all | same |
| On Next.js 15.1+, Vercel recommends `after()` from `next/server` instead of `waitUntil` | all | same |
| Next.js: "`after` will run for the platform's default or configured max duration of your route". On Vercel it is implemented with `waitUntil` | n/a | https://nextjs.org/docs/app/api-reference/functions/after (2026-09-16) |
| Billing: Provisioned Memory is billed "until the last in-flight request completes". Active CPU is billed only while code runs. After all requests finish the instance pauses and nothing is billed. Hobby includes 4 CPU-hours, 360 GB-hours, and 1M invocations | all | https://vercel.com/docs/functions/usage-and-pricing (2026-06-16) |
| For work with no time limit, Vercel points to Workflows | all | https://vercel.com/docs/fluid-compute (2026-08-24) |

Effect on mem: one 10-60 s extraction job fits Hobby's 300 s in `after()`, a queue consumer, or a workflow step. A loop that keeps running across requests does not fit.

## 3. Vercel Queues

| Fact | Plan | Source (page date) |
|---|---|---|
| Status **Beta**, "available in Beta on all plans". Public beta announced 2026-02-27. No GA date mentioned | Hobby, Pro, Enterprise | https://vercel.com/docs/queues (2026-09-03); https://vercel.com/changelog/vercel-queues-now-in-public-beta (2026-02-27) |
| Billed per API operation: send, receive, delete (ack), visibility change, and notify (push delivery). Metered in 4 KiB chunks. Sends with an idempotency key, and push deliveries with max concurrency, count 2x | all | https://vercel.com/docs/queues/pricing (2026-08-12) |
| Hobby includes the **first 1,000,000 operations**. Pro is usage-based at regional prices, from $0.60 per 1M | Hobby / Pro | same; https://vercel.com/pricing (fetched 2026-10-29) |
| Functions invoked in push mode are billed at normal Fluid compute rates | all | https://vercel.com/docs/queues/pricing (2026-08-12) |
| **Trigger (push mode):** add `"experimentalTriggers": [{ "type": "queue/v2beta", "topic": "..." }]` to a function in `vercel.json`, for example `app/api/queues/x/route.ts`, with `export const POST = handleCallback(...)` from `@vercel/queue`. Vercel invokes the function per message or batch. The consumer has **no public URL** and only queue infrastructure can call it. Push consumers are fixed at deploy time | all | https://vercel.com/docs/queues/concepts (2026-09-10); https://vercel.com/docs/queues/sdk (2026-08-12) |
| Poll mode is also available, for consumers outside Vercel or in Daemons, authenticated with OIDC | all | https://vercel.com/docs/queues/concepts (2026-09-10) |
| **Retries:** at-least-once delivery. A delivery fails if it is not acknowledged before the lease runs out (the handler threw, crashed, or timed out, or the function was unreachable). Retries continue until the message expires or reaches `maxDeliveries` (unlimited by default). `retryAfterSeconds` defaults to 60. The `retry` callback can return `{afterSeconds}` or `{acknowledge:true}`. Retried messages rank below new ones. There is **no built-in DLQ**. The first 32 attempts use the configured delay, after which backoff is forced | all | https://vercel.com/docs/queues/concepts (2026-09-10); https://vercel.com/docs/queues/pricing (2026-08-12) |
| `handleCallback` acks when the handler returns and retries when it throws. The SDK's visibility timeout defaults to 300 s and is **auto-extended while the handler runs**. The raw API default is 60 s, max 3600 s, with no auto-extend | all | https://vercel.com/docs/queues/sdk (2026-08-12) |
| Limits: TTL 60 s to 7 days (default 24 h). Delay 0 to 7 days. Max message 100 MB. Topics and consumer groups unlimited. Idempotency window is min(TTL, 24 h). Ordering is approximate, not FIFO | all | https://vercel.com/docs/queues/pricing (2026-08-12); https://vercel.com/docs/queues/concepts (2026-09-10) |
| Topics are **partitioned by deployment ID**: messages go back to the deployment that published them, and an old deployment keeps getting retried until its messages ack or expire. A timed-out delivery is billed for the full `maxDuration` | all | https://vercel.com/docs/queues/concepts (2026-09-10) |
| Available in all 19 regions. Data is stored in the chosen region, but failover may temporarily store it elsewhere ("strict data residency... not supported yet") | all | same |
| `@vercel/queue` latest is 0.10.0 (2026-10-23), pre-1.0 | n/a | npm registry (fetched 2026-10-29) |

## 4. Vercel Workflows (Workflow SDK, `"use workflow"` / `"use step"`)

| Fact | Plan | Source (page date) |
|---|---|---|
| **GA since 2026-04-16** ("Today, Vercel Workflows is generally available"). The Python SDK is still beta. The `workflow` npm package is stable, latest 5.2.3 (2026-10-20) | all | https://vercel.com/blog/a-new-programming-model-for-durable-execution (2026-04-16); npm (fetched 2026-10-29) |
| Hobby includes **50,000 Workflow Events/month** and **1 GB Workflow Data Written**. **Workflow Data Retained is not available on Hobby** | Hobby | https://vercel.com/docs/workflows/pricing (2026-09-16); https://vercel.com/docs/plans/hobby (2026-09-14) |
| On-demand rates: Events $0.02 per 1K, Data Written $0.50/GB, Data Retained $0.50/GB-month. Steps are billed as function compute, and Queues operations at standard rates | Pro | https://vercel.com/docs/workflows/pricing (2026-09-16) |
| A normal step writes 3 events (`step_created`, `step_started`, `step_completed`) plus one `step_retrying` per retry | all | same |
| Limits: no limit on run duration or `sleep` duration. 10,000 steps and 25,000 events per run on the Node runtime. 50 MB per payload. 2 GB per run. Max replay 240 s. **A single step's runtime follows the Functions limit (300 s on Hobby)**. Rate limits are 50K req/min on Hobby and 500K on Pro, and are retried rather than failed | all | same |
| Durability: inputs and outputs are kept in an event log. After a deploy or crash, execution replays deterministically. Runs stay pinned to the deployment that created them. Step functions are compiled to separate routes, and Vercel Queues drives the execution | all | https://vercel.com/docs/workflows/concepts (2026-09-10); https://vercel.com/docs/workflows (2026-09-04) |
| Retries: steps retry **3 times by default** (4 attempts) and are re-enqueued right away. `FatalError` skips retries. `RetryableError({retryAfter})` sets the delay. Override with `fn.maxRetries = N` | all | https://workflow-sdk.dev/docs/foundations/errors-and-retries (2026-10-28) |
| Next.js setup: `npm i workflow`, then wrap `next.config.ts` in `withWorkflow()` from `workflow/next`. Exclude `.well-known/workflow/` from the `proxy.ts` matcher. Workflow is "Best when deployed to Vercel", with "no special configuration". The page does not mention Hobby, but Hobby includes allowances, so it runs on Hobby | Hobby, Pro | https://workflow-sdk.dev/docs/getting-started/next (2026-10-26); https://vercel.com/docs/plans/hobby (2026-09-14) |
| Region: a run is pinned to the region of the function that started it (needs `workflow` 5.0.0-beta.33+). **4.x runs always live in `iad1`**. Hook records default to `iad1` | all | https://vercel.com/docs/workflows (2026-09-04); https://vercel.com/docs/workflows/retention (fetched 2026-10-29) |
| Payload retention: Hobby 1 day after the run finishes (deleted by 66 days). Pro 7 days (deleted by 96 days). `experimental_retention: 0` stops payloads being readable as soon as the run finishes | Hobby / Pro | https://vercel.com/docs/workflows/retention (fetched 2026-10-29) |
| Off Vercel, a "Postgres World" backend (Graphile Worker on Postgres) runs workflows in a long-running Node process | n/a | https://workflow-sdk.dev/docs/configuration/worlds (2026-10-28) |

## 5. Hobby plan limits, overage, and commercial use

| Fact | Plan | Source (page date) |
|---|---|---|
| Hobby is free. Monthly allowances: **1,000,000 function invocations**, **4 Active CPU-hours**, **360 GB-hours Provisioned Memory**, **100 GB Fast Data Transfer**, 10 GB Fast Origin Transfer, 1M CDN requests, 50K Workflow events, 1 GB Workflow data written | Hobby | https://vercel.com/docs/plans/hobby (2026-09-14); https://vercel.com/docs/functions/usage-and-pricing (2026-06-16) |
| Also: 1M Queue operations; Daemons get 5 Active CPU-hours and 420 GB-hours | Hobby | https://vercel.com/pricing (fetched 2026-10-29); https://vercel.com/docs/daemons/limits (fetched 2026-10-29) |
| **When a limit is exceeded:** "In most cases, if you exceed your usage limits on the Hobby plan, you will have to wait until 30 days have passed before you can use the feature again" (Web Analytics differs) | Hobby | https://vercel.com/docs/plans/hobby (2026-09-14) |
| Sustained overuse can pause a deployment, which then serves `503 DEPLOYMENT_PAUSED`. Paused projects "resume one at a time, never automatically" | all | https://vercel.com/kb/guide/why-is-my-account-deployment-blocked (updated 2026-10-02) |
| **Terms:** "Hobby teams are restricted to non-commercial personal use only." Commercial use means a deployment used for financial gain by anyone involved in producing it, including paid developers, payments, ads, or selling a product. Donations are not commercial | Hobby | https://vercel.com/docs/limits/fair-use-guidelines (2026-09-14); the FAQ on https://vercel.com/pricing says "personal, non-commercial use" |
| Other Hobby limits: 200 projects; 100 deployments/day; 1 concurrent build; 1 hour of runtime logs; cannot connect to Git repos owned by a GitHub organization | Hobby | https://vercel.com/docs/limits (2026-09-16); https://vercel.com/docs/plans/hobby (2026-09-14) |

### Vercel Daemons (relevant to "keep the loops as a process")

| Fact | Plan | Source (page date) |
|---|---|---|
| "Daemons are available in Public Beta on all plans". They run long-running container processes (queue consumers, workflow workers, job runners) next to the app, built from a **Dockerfile**. They run in **production only**, accept no inbound HTTP, and get SIGTERM with a 30 s grace period (up to 3600 s). Projects whose root directory is a subfolder cannot add daemons yet | all | https://vercel.com/docs/daemons (fetched 2026-10-29); https://vercel.com/docs/daemons/limits (fetched 2026-10-29) |
| Hobby: 1 or 2 GiB instances only. Quota is **5 Active CPU-hours and 420 GB-hours Provisioned Memory per month**, and memory counts while idle ("one 2 GiB instance that runs without stopping reaches 420 GB-hours in about 9 days"). At the quota Vercel **stops the team's daemons until the 1st of next month** | Hobby | https://vercel.com/docs/daemons/limits (fetched 2026-10-29) |
| Pro: billed for Active CPU and Provisioned Memory ("starts at" $0.128/CPU-hour and $0.0212/GB-hour); quota is 16 vCPU / 32 GiB running at once | Pro | same; https://vercel.com/pricing (fetched 2026-10-29) |

## 6. Pro plan price and included usage

| Fact | Plan | Source (page date) |
|---|---|---|
| **$20/month platform fee**, which includes 1 deploying seat and **$20/month usage credit**. Each extra Owner or Member seat is $20/month. Viewer seats are free | Pro | https://vercel.com/docs/plans/pro-plan (2026-09-15); https://vercel.com/pricing (fetched 2026-10-29); https://vercel.com/docs/plans/hobby (2026-09-14) |
| The credit applies to all managed-infrastructure resources from the first unit. It expires monthly. On-demand billing starts after it. Pro also includes the Flat Rate CDN base tier (1M CDN requests, 1 TB transfer) | Pro | https://vercel.com/docs/plans/pro-plan (2026-09-15) |
| Spend-management alerts default to $200 per cycle. There is a 75% credit notification | Pro | same |
| On-demand rates: invocations $0.60/1M; Active CPU from $0.128/h (fra1 $0.184); memory from $0.0106/GB-h (fra1 $0.0152) | Pro | https://vercel.com/docs/limits/fair-use-guidelines (2026-09-14); https://vercel.com/docs/functions/usage-and-pricing (2026-06-16) |
| Prices exclude VAT, which is added based on billing address | all | https://vercel.com/docs/plans/pro-plan (2026-09-15) |

## 7. Regions

| Fact | Plan | Source (page date) |
|---|---|---|
| The default function region for new projects is `iad1`. Change it in project settings (Functions > Function Regions), with `"regions": ["fra1"]` in `vercel.json`, or with `vercel --regions` | all | https://vercel.com/docs/functions/configuring-functions/region (2026-08-11) |
| Function region limit: **Hobby: single region**. Pro: 5 regions. Enterprise: all. Exceeding the limit fails the deploy before the build. Nothing restricts which single region Hobby picks | Hobby / Pro | same. Note: https://vercel.com/docs/fluid-compute (2026-08-24) says "Pro: up to 3", which conflicts with the region page's 5 |
| EU compute regions: `fra1` Frankfurt, `cdg1` Paris, `dub1` Dublin, `lhr1` London, `arn1` Stockholm. There are 19 compute regions in total | all | https://vercel.com/docs/regions (2026-08-11) |
| Function failover regions are Enterprise only | Enterprise | https://vercel.com/docs/functions/configuring-functions/region (2026-08-11) |
| On Hobby, Routing Middleware runs in fewer regions | Hobby | same |

## 8. Protecting a production site

| Fact | Plan | Source (page date) |
|---|---|---|
| **Vercel Authentication can protect production URLs on every plan.** The "All Deployments" scope, which covers production domains and generated URLs, "is available on all plans". The changelog says production protection is now free on every plan; before, it needed the $150/month Advanced Deployment Protection add-on | Hobby, Pro | https://vercel.com/docs/deployment-protection (2026-09-15); https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan (2026-09-09); https://vercel.com/docs/plans/hobby (2026-09-14) lists "Vercel Authentication for preview and production deployments" under Hobby |
| Vercel Authentication sends visitors to a Vercel login, and only team or project members (or approved users) get in. Hobby allows **one external user** via access requests. The cookie is valid for one URL only | Hobby | https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication (2026-09-15) |
| Protection covers **every request**, including Routing Middleware. It is set per project and scope, **not per path**. The only path exemption is the OPTIONS Allowlist, which covers CORS preflight only | all | https://vercel.com/docs/deployment-protection (2026-09-15); https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection (2026-09-15) |
| Machine clients (MCP servers, agents) get a login page or 403. Bypass options: **Protection Bypass for Automation** (`x-vercel-protection-bypass` header or query parameter, all plans) or Trusted Sources (OIDC tokens from Vercel projects or external identity providers, all plans). Deployment Protection Exceptions work only for preview domains | all | https://vercel.com/docs/deployment-protection/automated-agent-access (2026-09-15); https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection (2026-09-15) |
| **Password Protection: not available on Hobby. $20/month per protected project on Pro.** Included on Enterprise. Legacy package was $150/month per team | Hobby / Pro | https://vercel.com/docs/deployment-protection (2026-09-15); https://vercel.com/docs/plans/pro-plan (2026-09-15) |
| Trusted IPs, and production-only protection, are Enterprise only | Enterprise | https://vercel.com/docs/deployment-protection (2026-09-15) |
| **WAF custom rules are available on all plans: up to 3 on Hobby, 40 on Pro.** Enterprise is 250 per the pricing page or 1000 per a KB guide | Hobby / Pro | https://vercel.com/docs/plans/hobby (2026-09-14); https://vercel.com/pricing (fetched 2026-10-29); https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules (2026-09-10) |
| Custom rules combine conditions with AND/OR. Path and IP address are both parameters, and "any operator can be negated". Actions are log, deny, challenge, bypass, redirect. So "path starts with `/admin` AND IP not in list → deny" is expressible. Every parameter except JA3 (Enterprise) is on all plans. Changes apply instantly with no redeploy. Mitigated traffic is free | all | https://vercel.com/kb/guide/suspicious-traffic-in-specific-countries (updated 2026-09-03); https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules (2026-09-10); https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing (2026-06-16) |
| Project IP blocking (deny list per host): "Up to 10" on Hobby and 40 on Pro per the Hobby plan page. A KB guide says 3 on Hobby and 100 on Pro | Hobby / Pro | https://vercel.com/docs/plans/hobby (2026-09-14) vs https://vercel.com/kb/guide/suspicious-traffic-in-specific-countries (2026-09-03), which conflict |
| Persistent actions (time-based blocks) are Pro and Enterprise | Pro | https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules (2026-09-10) |
| **Cloudflare in front of Vercel is discouraged but allowed:** "We recommend connecting directly where possible, but you can place a proxy in front of Vercel." Reasons: reduced security signals, shared egress IPs, Bot Protection not working, extra latency, double caching. If you must proxy, use Verified Proxy Lite (all plans), Full (strict) TLS, exempt `/.well-known/acme-challenge/*` and `/.well-known/vercel/*`, and keep the external cache off. The recommended setup is DNS-only (grey cloud) | all | https://vercel.com/kb/guide/can-i-use-a-proxy-on-top-of-my-vercel-deployment (published 2025-11-03, updated 2026-10-19); https://vercel.com/kb/guide/cloudflare-with-vercel (updated 2026-10-19) |

Effect on mem: if the GUI and `/mcp` share one project, turning on Vercel Authentication for production would block Claude and ChatGPT from `/mcp` and from OAuth discovery. They would need the bypass secret in the URL query. The other route is to leave Deployment Protection off and rely on app-level auth plus WAF rules. A third way is to split the GUI into its own project; see Unverified.

## 9. Postgres from Vercel Functions (`pg` Pool under Fluid)

| Fact | Plan | Source (page date) |
|---|---|---|
| Create the `Pool` at **module scope** and call **`attachDatabasePool(pool)`** from `@vercel/functions` right after. It "ensures that idle pool clients are properly released before functions suspend". It supports `pg`, mysql2, mariadb, mongodb, ioredis, and cassandra-driver. Use `pool.connect()` and `client.release()` in `finally` | all | https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package (2026-09-03); https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute (updated 2026-06-17) |
| Pool settings: short idle timeout (about 5 s). **Do not set max = 1** because it blocks concurrency on Fluid. Keep min = 1. Suspended instances do not run idle timers, so connections leak without `attachDatabasePool` | all | https://vercel.com/kb/guide/connection-pooling-with-functions (updated 2026-07-23); https://vercel.com/blog/the-real-serverless-compute-to-database-connection-problem-solved (2025-08-13) |
| Pooled vs direct: Vercel's pages do **not** say which connection string to use. Neon's Vercel integration injects `DATABASE_URL` (**pooled, PgBouncer**) and `DATABASE_URL_UNPOOLED` (**direct**). Migration tools generally need the direct string | n/a | https://neon.com/docs/guides/vercel-managed-integration (undated, fetched 2026-10-29); Neon Prisma/Drizzle guides |
| Vercel's blog notes that external poolers have their own connection caps (for example, 200 on Supabase's free pooler), so leaked connections still matter | n/a | https://vercel.com/blog/the-real-serverless-compute-to-database-connection-problem-solved (2025-08-13) |
| Each instance has 1,024 file descriptors shared across concurrent executions, sockets included | all | https://vercel.com/docs/functions/limitations (2026-08-24) |

## 10. Hono on Vercel and inside Next.js

| Fact | Plan | Source (page date) |
|---|---|---|
| **Zero-config Hono:** Vercel detects a file that imports `hono` at `app.*`, `index.*`, `server.*`, `src/app.*`, `src/index.*` or `src/server.*` (js/cjs/mjs/ts/cts/mts) with `export default app`. Routes become Vercel Functions on Fluid compute. Hono's `serveStatic()` is ignored; use `public/` instead. To pair it with a frontend in the same project, use **Vercel Services** | all | https://vercel.com/docs/frameworks/backend/hono (2026-08-10) |
| **Inside Next.js App Router:** use `app/api/[[...route]]/route.ts` with `new Hono().basePath('/api')` and `export const GET = handle(app); export const POST = handle(app)`. This works "when using the Node.js runtime" | n/a | https://hono.dev/docs/getting-started/nextjs (doc source last committed 2026-10-26) |
| **`hono/vercel` is deprecated.** Hono docs moved to `import { handle } from '@hono/vercel'` on 2026-09-29. The `hono` 4.13.14 typings say: "`hono/vercel` will be removed in v5. Install `@hono/vercel`". `@hono/vercel` 1.0.1 exists, and Hono 5.0.0-rc.1 is published. The handler is just `(req) => app.fetch(req)` | n/a | https://github.com/honojs/hono/blob/main/adapters/vercel/README.md; unpkg `hono@4.13.14/dist/adapter/vercel/handler.d.ts`; npm (fetched 2026-10-29) |
| **Root paths:** a route handler can live at any App Router segment. Vercel's own MCP guide puts one at `app/.well-known/oauth-protected-resource/route.ts`. `mcp-handler` says `/api/mcp` "is a convention, not a required path", so `app/mcp/route.ts` serves `/mcp` | all | https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel (2026-09-18); https://github.com/vercel/mcp-handler README (npm 2.3.0, 2026-10-07); https://nextjs.org/docs/app/api-reference/file-conventions/route (2026-04-30) |
| Rewrites in `next.config` can also map `/mcp` to `/api/mcp` (internal). They run after headers, redirects, and proxy. The `beforeFiles`/`afterFiles`/`fallback` phases are documented | n/a | https://nextjs.org/docs/app/api-reference/config/next-config-js/rewrites (2026-09-28) |

## 11. MCP on Vercel: `mcp-handler`, OAuth helpers, streaming limits

| Fact | Plan | Source (page date) |
|---|---|---|
| `mcp-handler` is a Vercel Labs product. npm latest is **2.3.0 (2026-10-07)**, and 2.0.0 shipped 2026-07-29. Vercel's docs page pins `mcp-handler@2.1.1`. It is framework-agnostic: a `(Request) => Promise<Response>` handler that mounts in Next.js, Hono (`c.req.raw`), Nuxt, and SvelteKit | n/a | https://github.com/vercel/mcp-handler README; https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel (2026-09-18); npm (fetched 2026-10-29) |
| **2.x requires MCP SDK v2** (`@modelcontextprotocol/server` ^2, zod ^4.2, Node 20+): "If you're on `@modelcontextprotocol/sdk` 1.x, use `mcp-handler` 1.x". The last 1.x is 1.1.0 (2026-03-24), with peer `@modelcontextprotocol/sdk` pinned to **1.26.0**. mem's SDK v1 line is now at 1.32.2 | n/a | same; npm (fetched 2026-10-29) |
| 2.x serves the **2026-07-28 MCP spec** natively (stateless, `server/discover`) and falls back to stateless 2025-era Streamable HTTP. **GET and DELETE return 405**. **HTTP+SSE (2024-11-05) transport and Redis were removed.** The current MCP spec version is indeed 2026-07-28 | n/a | mcp-handler README; https://modelcontextprotocol.io/specification/versioning (fetched 2026-10-29) |
| OAuth helpers: `withMcpAuth(handler, verifyToken, {required, requiredScopes, resourceMetadataPath})` returns 401/403 with RFC 9728 `WWW-Authenticate`. `protectedResourceHandler({authServerUrls, resourceUrl})` and `metadataCorsOptionsRequestHandler()` serve the protected resource metadata. The package "does not issue tokens or run an authorization server". CIMD is advertised by the authorization server | n/a | https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel (2026-09-18); https://github.com/vercel/mcp-handler/blob/main/docs/AUTHORIZATION.md |
| **Duration limits:** Vercel publishes no MCP-specific stream limit. A Streamable HTTP response, including an SSE-framed POST response, is a function response, and max duration "includes... sending the response, including streamed responses": **300 s on Hobby**, 800 s on Pro (1800 s beta). Over HTTP/2 Vercel sends PING frames while idle. HTTP/1.1 intermediaries may close idle connections, so stream heartbeats | Hobby / Pro | https://vercel.com/docs/functions/limitations (2026-08-24); https://vercel.com/docs/functions/configuring-functions/duration (2026-08-24) |
| WebSockets in Functions are in public beta on all plans (`upgradeWebSocket`), not needed for MCP | all | https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package (2026-09-03) |

## 12. Next.js version, scaffold flags, `.js` → `.ts` resolution

| Fact | Source (page date) |
|---|---|
| **Latest stable Next.js is 16.4.3** (npm `latest`, published 2026-10-23). `create-next-app` is also 16.4.3. Next.js 16.4 was released 2026-10-06. A scheduled **security release is due 2026-11-03**, so plan to bump then | npm registry (fetched 2026-10-29); https://nextjs.org/blog (fetched 2026-10-29) |
| `create-next-app` flags: `--ts` (default), `--app`, `--api` (route handlers only), `--eslint` / `--biome` / `--no-linter`, `--tailwind` (default), `--react-compiler`, `--cache-components` (default for App Router), `--src-dir`, `--turbopack` (default) / `--webpack`, `--import-alias "@/*"`, `--empty`, `--use-npm` / `--use-pnpm`, `--skip-install`, `--disable-git`, `--agents-md` (default), `--agent-feedback` / `--no-agent-feedback`, `--yes` ("Use previous preferences or defaults for all options"). Any default can be negated with `--no-*`, for example `--no-tailwind` or `--no-cache-components` | https://nextjs.org/docs/app/api-reference/cli/create-next-app (2026-09-29) |
| Non-interactive example (assembled from the flags above, not executed): `npx create-next-app@16.4.3 web --ts --app --eslint --no-tailwind --no-src-dir --import-alias "@/*" --use-npm --disable-git --no-agent-feedback --yes` | same |
| **Turbopack does not resolve `./foo.js` to `./foo.ts`.** Issue vercel/next.js#82945 ("Turbopack: support importing .ts/.tsx via .js extension (parity with webpack resolve.extensionAlias)") is **open**, labeled "linear: turbopack" (confirmed). PR #95426, which adds `turbopack.resolveExtensionAlias`, is **open and unmerged** (last updated 2026-07-23). `experimental.extensionAlias` sits in Next's `unsupportedTurbopackNextConfigOptions` list | https://github.com/vercel/next.js/issues/82945; https://github.com/vercel/next.js/pull/95426; `packages/next/src/lib/turbopack-warning.ts` on canary (fetched 2026-10-29) |
| Documented Turbopack resolve options are only `resolveAlias` and `resolveExtensions`. `resolveExtensions` changes which extensions are tried for **extensionless** specifiers. It does not remap `.js` | https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack (2026-09-24) |
| **The working config is webpack.** Build and dev with `--webpack` (`next dev --webpack`, `next build --webpack`, or `create-next-app --webpack`) and set `experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'] } }` in `next.config`. Next's own e2e test `test/production/webpack-config-extensionalias` shows this, and the build fails without it | Next.js repo `packages/next/src/build/webpack-config.ts` (`extensionAlias: config.experimental.extensionAlias`) and the test (fetched 2026-10-29) |
| Community workarounds for Turbopack: a `turbopack.rules` loader that strips `.js` from relative imports (misses dynamic imports), the `next-turbopack-nodenext` package (precomputes `resolveAlias`), or an SWC Wasm plugin | issue #82945 comments (2025-11-21, 2026-06-10) |

---

## 13. External cron: cron-job.org (checked by the coordinator, 2026-10-31)

| Fact | Source (read date) |
|---|---|
| "Every cronjob can be executed up to 60 times an hour, i.e. every minute." | https://cron-job.org/en/faq/ (read 2026-10-31) |
| "If your URL/script does not finish after 30 seconds, it will timeout." At most 64 KB of the response is read | same |
| "Our service supports arbitrary custom headers" (User-Agent and Connection are ignored). Almost all HTTP methods are supported, and POST and PUT can carry a body. HTTP basic authentication can be set per job | same |
| No fixed limit on jobs per account, but "we expect fair usage". Accounts used for "abusive or excessive purposes" may be deleted | same |
| Email notification on failed jobs. A job is disabled automatically after more than 25 failures | same |
| "Our service is entirely free of charge." The FAQ does not say who operates the service or where, and gives no uptime promise | same |

Effect on mem: a per-minute POST with a secret header can trigger the drain endpoint, which must answer within 30 s, so it replies at once and drains after the response (section 2). Because a failing job is disabled after 25 failures, cron-job.org is a trigger, not the monitor. A dead-man's switch that alerts when successful drains stop reporting is the monitor.

## Unverified

- **Provisioned memory between invocations:** the pricing page says nothing is billed between invocations. I did not confirm how long an instance stays "in flight" after an `after()`/`waitUntil` callback, or whether minute-level pings would keep Hobby's 360 GB-hours busy.
- **Workflow event counts for a polling loop:** sleep and wait events are an estimate. A per-minute loop at about 5 events per iteration would be about 216K events/month, over Hobby's 50K.
- **Next.js behaviour inside Vercel Authentication:** whether `/mcp` and `/.well-known/*` could be left open while the GUI stays protected, through a second Vercel project on the same domain, rewrites, or Services. Splitting into two projects (GUI protected, API not) is my inference and was not tested.
- **WAF IP condition details:** whether the IP condition accepts CIDR lists, and the exact operator names for "IP not in list". The KB guide confirms negation and IP plus path, but not CIDR inside custom rules.
- **IP blocking counts:** Hobby 10 vs 3, and Pro 40 vs 100, are inconsistent across Vercel pages. Pro multi-region is 5 on the region page vs 3 on the Fluid page.
- **The `create-next-app` example command** was not run. `--yes` combined with explicit flags is assumed to apply the explicit flags.
- **Using `./foo.ts` specifiers instead:** TypeScript 5.7 `rewriteRelativeImportExtensions` (Node build) plus `allowImportingTsExtensions` under Next's `noEmit`. I did not verify that Turbopack resolves explicit `.ts` specifiers without config.
- **Workflow on Hobby inside Next.js:** no official page says "Hobby" explicitly for Workflows in Next.js. It is inferred from Hobby's included Workflow allowances.
- **`@hono/mcp` (0.3.5, 2026-10-28) on SDK v1 under Fluid:** the alternative of keeping `@hono/mcp` inside a Next route handler, instead of `mcp-handler`, is not covered by any Vercel page.
- **Queues EU data residency:** messages may sit outside the chosen region during failover, according to Vercel. I did not verify whether Workflow hook records can be moved out of `iad1` ("unless you choose a different region"; no setting found).
- **Neon pooled/unpooled names:** these come from Neon's page, which has no visible date. Vercel's own docs give no pooled vs direct guidance. A note on that Neon page asked AI assistants to submit feedback to an external URL; I ignored it.

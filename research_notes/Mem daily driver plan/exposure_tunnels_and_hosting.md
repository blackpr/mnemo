# Exposing mem to cloud AI apps: tunnels vs. moving off the laptop

Scope: how a single-user Node 22 / Hono MCP server (localhost:8787) plus Postgres 17 + pgvector (Docker, MacBook) can get a public HTTPS URL that claude.ai / ChatGPT cloud servers can reach, plus a private web GUI usable from a phone; and whether to move the server to a VPS or PaaS instead. Researched 2026-10-28. "Undated" means the page shows no date and was fetched on 2026-10-28. Items flagged STALE? have a source date more than about six months before 2026-10-28 (before about 2026-04-28).

## 1. Per-option comparison: cost, setup, URL stability, security exposure, AI-vendor reachability

### Takeaway
All tunnel options can reach Anthropic's and OpenAI's servers because both vendors connect from their own cloud to any public HTTPS URL. The real differences are four:
- **URL stability:** quick tunnels change URL on every restart.
- **SSE support:** Cloudflare quick tunnels do not support SSE.
- **Who decrypts the traffic:** Cloudflare and ngrok terminate TLS. Tailscale Funnel does not.
- **Laptop sleep:** every laptop-hosted option goes dark when the Mac sleeps.

For one person, there are two near-free choices:
- **Cloudflare named tunnel:** $0, plus about $10-11/yr for a domain. It gives a stable custom hostname, DDoS protection, and Access in front of the GUI.
- **Tailscale Funnel:** $0, no domain needed. Its `*.ts.net` URL is stable, it is end-to-end encrypted to the laptop, and Serve can carry a tailnet-only GUI.

A small VPS (about €6-8/mo at Hetzner, $6-12/mo at DigitalOcean, about $8-15/mo on Fly.io) is the only way to stay available while the laptop sleeps or travels.

### Comparison table (sources in Cited Findings below)

| Option | Monthly cost for 1 user | Setup effort | URL stable across restarts? | What is public / TLS / provider visibility | DDoS / abuse protection | Reachable by Anthropic & OpenAI servers? | Depends on laptop being awake? |
|---|---|---|---|---|---|---|---|
| Cloudflare quick tunnel (`trycloudflare.com`) | $0, no account | Trivial (one command) | **No**: new random hostname each time | Whole origin public on a random hostname; Cloudflare terminates TLS | Cloudflare edge; 200 in-flight request cap (then 429) | Technically yes, but **no SSE support** and URL changes, so unusable for a registered connector | Yes |
| Cloudflare named tunnel, no Access | $0 Tunnel + domain (~$10.46/yr .com at Cloudflare Registrar, about $0.87/mo; rising about $0.71 on 2026-11-01) | Moderate: move domain DNS to Cloudflare, `cloudflared tunnel` + launchd service | **Yes**: your own hostname(s) | Hostname(s) you publish are public; Cloudflare terminates TLS at the edge (applies WAF/caching/DDoS before forwarding), so it can see plaintext | Cloudflare DDoS/WAF | Yes | Yes (1033 error when connector offline) |
| Cloudflare named tunnel + Access (Allow policy) on GUI hostname, MCP hostname left without Access (or Bypass) | $0 (Zero Trust Free: up to 50 users, 24 h log retention) + domain | Moderate-plus: create Zero Trust org, IdP or One-time PIN, Access app | Yes | MCP hostname public (protected only by mem's own OAuth/bearer); GUI behind Cloudflare login. Bypass traffic is **not logged** by Access | Cloudflare | Yes for MCP hostname; GUI is blocked for them (by design) | Yes |
| Cloudflare named tunnel + Access **Managed OAuth** on the MCP hostname | $0 + domain | Higher: mem must validate `Cf-Access-Jwt-Assertion`; Access becomes the OAuth server | Yes | Access answers unauthenticated non-browser clients with 401 + `WWW-Authenticate` discovery | Cloudflare | Probably yes (designed for MCP clients; requires RFC 8707 support in the client); no Cloudflare page names claude.ai/ChatGPT explicitly | Yes |
| Tailscale Funnel | $0 (Personal plan up to 6 users; Funnel on all plans) | Low-moderate: install Tailscale, enable HTTPS + MagicDNS, `tailscale funnel` | **Yes**: `https://<device>.<tailnet>.ts.net` (no custom domains) | Only the funneled port is public; TLS terminated **on the laptop**; relays cannot decrypt; device IP hidden | No DDoS statement found; non-configurable, unpublished bandwidth limits | Yes (public HTTPS on 443) | Yes |
| Tailscale Serve (tailnet-only) | $0 | Low | Yes (same ts.net name) | Not public; only tailnet devices; adds `Tailscale-User-Login` identity headers | n/a (private) | **No** (vendors are not on your tailnet). Good for GUI from phone with Tailscale app | Yes |
| ngrok Free | $0 (1 GB out, 20k HTTP req/mo, 3 OAuth MAU) | Trivial | **Yes**: 1 assigned dev domain (`*.ngrok-free.app`) that does not change on agent restart | Public; ngrok terminates TLS; **interstitial page** in front of browser HTML traffic | Not researched | Yes for API calls (interstitial says it does not affect programmatic clients), but the OAuth login page in the user's browser gets the interstitial | Yes |
| ngrok Hobbyist | $10/mo (5 GB, 100k req) | Trivial | Yes (static dev domain; no custom domain) | Interstitial removed | Not researched | Yes | Yes |
| ngrok Pay-as-you-go | $20/mo + usage; custom domain $0.01/active hour | Low | Yes, own domain | Interstitial removed | Not researched | Yes | Yes |
| OpenAI Secure MCP Tunnel (ChatGPT-only) | Not stated | Moderate (Platform tunnel_id, API key, `tunnel-client`) | n/a (tunnel_id) | No inbound exposure; outbound long-poll to api.openai.com | n/a | **ChatGPT/Codex/Responses API only**, not Claude | Yes |
| Hetzner Cloud VPS (EU) | CX23 €5.99, CAX11 €6.49, CPX02 €6.49 excl. VAT; backups 20% (from €1.198) | Higher: OS hardening/patching, TLS (Caddy/Let's Encrypt or cloudflared on the VPS) | Yes | Whatever you expose; you terminate TLS (unless you add Cloudflare) | Not researched | Yes | **No** |
| DigitalOcean Droplet | $4 (512 MiB) / $6 (1 GiB) / $12 (2 GiB); backups +20% weekly / +30% daily | Higher (same as above) | Yes | Same as above | Not researched | Yes | No |
| Fly.io | shared-cpu-1x 1 GB $6.70 + volume $0.15/GB-mo; Managed Postgres from $38 + $0.28/GB | Moderate (Dockerfile, `fly deploy`), platform TLS | Yes (`*.fly.dev` or custom) | Platform proxy terminates TLS | Not researched | Yes | No |
| Railway | Hobby $5/mo incl. $5 usage; about $10/GB-RAM-mo, $20/vCPU-mo, volumes $0.15/GB-mo | Low-moderate | Yes | Platform TLS | Not researched | Yes | No |
| Render | Starter web service $7/mo (third-party figure); paid Postgres from about $6 (third-party); free Postgres expires after 30 days | Low-moderate | Yes | Platform TLS | Not researched | Yes | No |

### Cited Findings

**Cloudflare quick tunnel**
- Quick Tunnels need no Cloudflare account or domain. They give a temporary `trycloudflare.com` URL that changes each time and stops working when `cloudflared` stops. Cloudflare positions them for testing and development only, with no uptime guarantee. Source date: last updated 2026-09-30. — [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
- Quick Tunnels allow up to 200 in-flight requests; further requests get HTTP 429. Quick Tunnels do not support Server-Sent Events. The optional `--allowed-mail` email PIN gate needs an interactive browser and does not support non-interactive clients. — [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)

**Cloudflare named tunnel**
- A domain on Cloudflare is listed as a prerequisite for publishing applications through a tunnel. — [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/setup) (via search summary, not fully fetched)
- Cloudflare applies CDN caching, WAF and DDoS protection before forwarding requests to the origin. This implies Cloudflare terminates TLS at the edge. Source date: last updated 2026-10-16. — [Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing)
- Zero Trust Free plan: 50-user limit, ZTNA (Access) and the "Application Connector Software" included, standard logs retained up to 24 hours. Pay-as-you-go is $7/user/month. Undated. — [Cloudflare Zero Trust plans](https://www.cloudflare.com/plans/sase-zero-trust.md)
- Proxy Read Timeout is 125 s (HTTP 524) and Proxy Idle Timeout is 900 s (520). The read timeout is configurable only for Enterprise zones. Source date: last updated 2026-10-22. This conflicts with third-party claims of a 100 s limit; the official 125 s figure is the current one. — [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/); contradicted by [http.dev 524](https://http.dev/524) (100 s)
- SSE passes through Cloudflare as an uncached streamed response. Long silences get cut, so heartbeats should be more frequent than the shortest timeout in the chain. Third-party source. — [StackHarbor SSE behind Cloudflare](https://stackharbor.com/en/knowledge-base/cffix-websockets-sse-behind-cloudflare/)
- Error 1033 means the hostname uses Cloudflare Tunnel but no healthy `cloudflared` connector is available. Source date: last updated 2026-04-23 (just over six months old). — [Cloudflare error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/)
- Cloudflare Registrar `.com` costs $10.46 for registration, renewal and transfer (aggregator, last updated 2026-05-20). Third-party, not Cloudflare's own page. — [domainoffer.net](https://domainoffer.net/tld/com/cloudflare)
- An aggregator updated 2026-10-20 says the .com wholesale price rises $0.71 on 2026-11-01. Unverified on Cloudflare's site. — [CostGoat domain comparison](https://costgoat.com/compare/domains)

**Tailscale Funnel and Serve**
- Funnel status and basics: in Beta, available on all plans, needs Tailscale ≥ v1.38.3, MagicDNS, HTTPS certificates and a `funnel` node attribute, and is disabled by default. Source date: last validated 2026-01-20 (STALE? more than six months). — [Tailscale Funnel KB](https://tailscale.com/kb/1223/funnel)
- Funnel only works on ports 443, 8443 and 10000.
- Traffic is subject to non-configurable bandwidth limits.
- Custom domains are not supported; only `tailnet-name.ts.net` names work.
- New public DNS can take up to 10 minutes to propagate.
- The Tailscale client on the device terminates TLS. Relays use a TCP proxy, cannot decrypt traffic, and hide the device's IP.
- One port cannot serve both Serve and Funnel at the same time; the most recent command wins.
- Let's Encrypt rate limits apply.
- On macOS, port sharing requires the App Store or Standalone variant.
- Sources for the six points above: [Tailscale Funnel KB](https://tailscale.com/kb/1223/funnel)
- No published Funnel throughput figure exists; a September 2026 third-party guide confirms there is no Mbps figure or monthly allowance. — [SSD Nodes on Funnel limits](https://www.ssdnodes.com/learn/tailscale-funnel-limits-and-ports); [Tailscale forum](https://forum.tailscale.com/t/bandwidth-for-free-users/5242)
- Serve is tailnet-only and subject to tailnet access rules. It provisions TLS for `device.tailnet.ts.net` and adds `Tailscale-User-Login`, `-Name` and `-Profile-Pic` headers, stripping spoofed copies. Tailscale recommends the backend listen only on localhost. Source date: last validated 2026-01-20 (STALE?). — [Tailscale Serve KB](https://tailscale.com/kb/1312/serve)
- Tailscale's Personal plan is free for up to 6 users with unlimited devices. Undated. — [Tailscale pricing](https://tailscale.com/pricing)

**ngrok**
- Free plan monthly quotas: 1 GB data out, 20,000 HTTP requests, 10,000 logs/events, 3 OAuth/OIDC MAU.
- Free plan rate limit: 4,000 requests per minute.
- Free plan concurrency: up to 3 online endpoints, 1 dev domain, 5 traffic-policy rules.
- The free dev domain (for example `*.ngrok-free.app`) "doesn't change when you restart the agent". Custom and reserved domains need a paid plan.
- Free endpoints have no timeout.
- Source for the five points above: [ngrok free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits) (undated)
- ngrok paid plans:
  - Hobbyist: $10/mo ($10 credit, 5 GB, 100k requests, interstitial removed, no custom domains, 10 ngrok-branded domains).
  - Pay-as-you-go: $20/mo plus usage ($0.10/GB beyond 5 GB, bring-your-own domain at $0.01 per active hour, OAuth MAU beyond 5 at $1 each).
  - Hobbyist endpoints stop when credit runs out.
  - Undated. — [ngrok pricing](https://ngrok.com/pricing)

**OpenAI Secure MCP Tunnel**
- How it works: `tunnel-client` runs inside your network and makes outbound HTTPS calls to `api.openai.com:443`, or mTLS to `mtls.api.openai.com`. It long-polls for queued MCP requests and needs no inbound ports.
- Where it works: ChatGPT custom MCP servers with "Connection: Tunnel", Codex, and the Responses API.
- What it needs: a Platform `tunnel_id`, an API key, and Tunnels permissions. For ChatGPT, the tunnel must be associated with the target workspace.
- Default limits: 600 MCP requests/min, 10 MiB per request, 120 s request deadline.
- Plan availability is not stated. Undated. — [OpenAI Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- OpenAI's connect guide says the MCP server must be reachable through a public HTTPS endpoint or through Secure MCP Tunnel, and plugin submission requires public HTTPS. The transport is Streamable HTTP, typically at `/mcp`. — [OpenAI Apps SDK: Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)
- Third-party write-ups note that the full tool-call payload passes through OpenAI's control plane. They date the announcement to May 2026 and say they could not fully verify it. — [mer.vin write-up](https://mer.vin/2026/05/openai-secure-mcp-tunnel-private-mcp-servers-for-chatgpt-codex-and-the-api/)

**AI vendors connect from their cloud**
- Claude connects to remote MCP servers "from Anthropic's cloud infrastructure". This applies to claude.ai, Claude Desktop, Cowork and the mobile apps.
- The server must be reachable over the public internet from Anthropic's IP ranges; VPN or private-network servers won't connect.
- Auth options: OAuth (sign in now, sign in when needed, or no sign in), with three client options: "Use Claude's published identity", "Register automatically", or your own OAuth client. Fixed credentials such as API keys or bearer tokens can be sent as "Request headers".
- Custom connectors are on all plans; Free is limited to one.
- Page says "Updated over 3 weeks ago" as of 2026-10-28.
- Source for the points above: [Claude Help: custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

### Inferences
- **Quick tunnels are ruled out** for a registered connector for two reasons: the URL changes on every run, and they lack SSE. MCP Streamable HTTP may use SSE for responses and notifications.
- **ngrok Free is the cheapest stable-URL option without a domain**, but it has three drawbacks. The interstitial hits the browser-facing OAuth authorize/login page and the GUI. 20k requests/month may be tight once the GUI is added. Only 1 GB/month egress is included.
- **Tailscale Funnel is the strongest privacy option among the tunnels**: TLS ends on the Mac, so Tailscale cannot read memory contents. Cloudflare and ngrok can read all MCP traffic, including memory payloads. Funnel cannot use a custom domain, and its bandwidth limit is unpublished; for text-only MCP traffic from one user, the limit is unlikely to matter, but this is unverified.
- **Long SSE streams need keepalive pings:** behind Cloudflare, mem's MCP SSE streams should send a ping more often than every 125 s. OpenAI's tunnel caps requests at 120 s.
- **Every laptop-hosted option has the same availability ceiling:** the endpoint is down whenever the Mac sleeps, is lid-closed, is offline, or Docker Desktop is stopped.

### Gaps
- No ngrok or Tailscale DDoS-protection statements were researched or found. Hetzner, DigitalOcean, Fly, Railway and Render network-DDoS policies were not researched.
- Whether ngrok or Cloudflare log request bodies for free users beyond the stated "logs & events" quotas and 24 h retention was not documented in the pages read.
- Render's own pricing page did not render. The $7 Starter and about $6 Postgres figures come from third-party blogs ([Render pricing 2026 blog](https://temps.sh/blog/render-pricing-2026), [kuberns](https://kuberns.com/blogs/render-pricing/)) and should be verified.
- Whether ChatGPT Plus/Pro personal accounts can use Secure MCP Tunnel is not stated by OpenAI.

## 2. "Identity in front": does Cloudflare Access, ngrok OAuth or similar block the AI vendors' servers? Which patterns are supported?

### Takeaway
A plain Cloudflare Access app (browser login) blocks claude.ai and ChatGPT: non-browser clients get a 302 they cannot complete. Cloudflare offers three supported ways around this:
- **(a) Managed OAuth:** Access acts as an OAuth 2.0 authorization server, with 401 + discovery, dynamic client registration, and RFC 8707. This replaces your own OAuth and requires the origin to validate Access JWTs.
- **(b) MCP server portals:** these put managed OAuth in front of one or more upstream MCP servers. The portal can reach mem with mem's own OAuth or with a static bearer header.
- **(c) Leave Access off the MCP hostname:** use a separate Access app with a Bypass policy, or simply no app. mem's own OAuth then protects it, while a separate Allow app protects the GUI.

ngrok's `oauth` traffic-policy action is a browser cookie/redirect flow, so it would block vendor servers unless scoped away from `/mcp`. ngrok Free's interstitial does not affect API calls but does sit in front of browser HTML pages, including an OAuth login page. Tailscale Funnel has no identity layer: ports are limited to 443, 8443 and 10000, bandwidth limits are unpublished, and custom domains are not supported.

### Cited Findings

**Cloudflare Access: Managed OAuth**
- By default, non-browser clients (CLIs, AI agents, SDKs) hitting an Access-protected app get a 302 redirect they cannot complete. With Managed OAuth enabled, Access acts as an OAuth 2.0 authorization server for the application and enforces the same policies as browser login. Source date: last updated 2026-07-01. — [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- Supported applications: self-hosted Access apps, MCP server applications, and MCP server portals.
- For MCP server applications, the server must be served through Cloudflare in the same account and must validate the Access JWT in `Cf-Access-Jwt-Assertion`. Do not enable it for third-party MCP code that handles its own OAuth.
- Flow: the client fetches `/.well-known/oauth-authorization-server` (RFC 8414/9728). Non-browser clients get a 401 with `WWW-Authenticate` pointing at discovery.
- Clients: dynamic client registration can be toggled. Allowed redirect URIs must be https.
- Tokens: opaque (not JWTs). The default access-token lifetime is 15 min, and the refresh/session duration is configurable.
- The OAuth client must support RFC 8707.
- Warning: do not enable Managed OAuth if you run your own OAuth server behind Access and rely on your own `WWW-Authenticate` headers, because it replaces the 401 behavior.
- The page does not mention claude.ai and states no plan requirement.
- Source for the points above: [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

**Cloudflare: securing MCP servers and portals**
- Cloudflare's "Secure MCP servers" guide covers two cases.
  - Customer-managed third-party servers on a hostname you control: the server does its own OAuth, and Access policies define who can use it.
  - SaaS-managed servers: Access acts as the OIDC provider.
  - If you can't update the server code, use its existing OAuth flow.
  - Prerequisites: a Zero Trust organization plus One-time PIN or an IdP. The hostname must be proxied.
  - Source date: last updated 2026-10-22. — [Cloudflare: Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/)
- MCP server portals centralize multiple MCP servers behind one endpoint, `https://<subdomain>.<domain>/mcp`.
  - Upstream servers: remote HTTP MCP servers can be added by URL. Private ones are reachable via Tunnel plus private hostname, which needs Gateway routing, and their OAuth endpoints must be publicly reachable.
  - Client auth: clients authenticate via managed OAuth (401 + `WWW-Authenticate`), or via service tokens for machine-to-machine.
  - Upstream auth: DCR, manual OAuth credentials, a bearer token, or custom headers.
  - Compatibility: some servers that block proxy-based clients return 403.
  - Limits and requirements: up to 80 servers per portal. Prerequisites are an active Cloudflare domain and an IdP. Logpush of portal logs is Enterprise-only.
  - Named clients include Claude Desktop, Workers AI Playground, OpenCode, Windsurf and MCP Inspector; ChatGPT is not named.
  - Source date: last updated 2026-10-27. — [Cloudflare MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- Changelog: self-hosted Access apps support OAuth for MCP server authentication, also usable with MCP server portals. Source date: 2025-08-26 (STALE? more than one year old; superseded by the pages above). — [Cloudflare changelog 2025-08-26](https://developers.cloudflare.com/changelog/post/2025-08-26-access-mcp-oauth/)

**Cloudflare Access: policy actions (Bypass)**
- Access policy actions are Allow, Block, Bypass and Service Auth.
- Bypass "does not enforce any Access security controls and requests are not logged". Cloudflare does not recommend it for permanent direct access to internal apps and suggests Service Auth as the logged alternative.
- The documented example scopes an Access application to a path (`test.example.com/admin/...`) with a Bypass/Everyone policy.
- Source date: last updated 2026-10-01. — [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- A Bypass policy is optional, for hostnames that must be public. If "Require Access protection" is enabled, hostnames without an Access app are blocked by default. — [Cloudflare: Require Access protection](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/require-access-protection)

**workers-oauth-provider**
- `workers-oauth-provider` is an OAuth 2.1 library for Cloudflare Workers that can act as authorization server, resource server, or both. It covers:
  - PKCE
  - DCR (RFC 7591)
  - discovery (RFC 8414/9728)
  - Client ID Metadata Documents
  - RFC 8707
  - the MCP authorization spec
- It stores hashed tokens in Workers KV. The README does not say it proxies to an external origin. — [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)

**ngrok OAuth action and interstitial**
- ngrok's `oauth` traffic-policy action redirects unauthenticated requests into an IdP flow and then relies on `session` and `nonce` cookies. Rules can carry `expressions`, but the page does not show path exclusions. — [ngrok OAuth action](https://ngrok.com/docs/traffic-policy/actions/oauth/)
- ngrok Free's interstitial behavior:
  - It appears in front of HTML browser traffic, and API/programmatic clients are not affected.
  - Clicking "Visit" sets a cookie that suppresses it for 7 days.
  - It can be bypassed by sending the `ngrok-skip-browser-warning` header or a non-standard `User-Agent`. Any paid plan removes it.
  - Source: [ngrok free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)
- A forum user found that setting the skip header server-side does not help, because the interstitial is returned at ngrok's edge; the header must come from the client. — [Laracasts thread](https://laracasts.com/discuss/channels/laravel/remove-warning-page-in-ngrok-server)

**Tailscale Funnel**
- Funnel limits: ports 443/8443/10000 only, non-configurable bandwidth limits, and no custom domains. — [Tailscale Funnel KB](https://tailscale.com/kb/1223/funnel) (last validated 2026-01-20, STALE?)

### Inferences
- **Pattern C fits best if the separate OAuth research builds OAuth 2.1 into mem.** Use two hostnames on one tunnel:
  - `mcp.example.com`: no Access app, or a path-scoped Bypass app covering `/mcp`, `/.well-known/*` and mem's OAuth endpoints. mem's OAuth protects it.
  - `gui.example.com`: Access Allow policy (email One-time PIN or GitHub/Google IdP).
  - This avoids Cloudflare's warning against running your own OAuth behind Managed OAuth.
- **Pattern A (Managed OAuth) or B (portal) could let mem skip implementing OAuth.** Access becomes the authorization server and mem only verifies `Cf-Access-Jwt-Assertion`; with a portal, the portal can call mem with mem's existing bearer API key. Costs of this route:
  - It needs a Zero Trust org and IdP.
  - It ties identity to Cloudflare.
  - It depends on claude.ai's and ChatGPT's OAuth clients interoperating with Access's opaque tokens, DCR and RFC 8707 handling.
  - Cloudflare's docs list Claude Desktop as a portal client. Claude Desktop's remote connectors run from Anthropic's cloud, which suggests claude.ai-side compatibility, but this is not explicitly confirmed.
- **The ngrok interstitial would likely appear once per 7 days on mem's OAuth login page and GUI in the user's phone or desktop browser.** That is an annoyance rather than a hard break, unless the redirect loses the OAuth query string (unverified). Vendor-server calls to `/mcp` and `/token` should be unaffected because they are not browser HTML traffic.
- **Tailscale Funnel's "identity in front" is Serve, not Funnel.** Use Funnel on 443 for MCP and Serve on 8443 or 10000 for a tailnet-only GUI on the phone; the same port cannot be both.

### Gaps
- No Cloudflare, Anthropic or OpenAI page explicitly confirms that claude.ai or ChatGPT connectors complete the Access Managed OAuth or portal OAuth flow. Not tested (signing up was out of scope).
- Whether Access Managed OAuth accepts Claude's "published identity" (Client ID Metadata Document) rather than DCR is not stated. `workers-oauth-provider` supports CIMD, but Access's Managed OAuth page mentions only DCR.
- The exact claude.ai and ChatGPT OAuth redirect URIs that must be listed in Access "Allowed redirect URIs" were not looked up.
- Plan or pricing requirements for MCP server portals and Managed OAuth are not stated beyond Logpush being Enterprise-only.
- Whether ngrok's "Visit" click on the interstitial preserves the original URL and query string (needed for an OAuth `/authorize` request) is undocumented.
- How ngrok detects "API traffic" (Accept header vs User-Agent) is undocumented, so whether a vendor's MCP client with a browser-like UA would get the interstitial is unknown.

## 3. Does Cloudflare Tunnel need a domain on Cloudflare, and can one tunnel serve two hostnames?

### Takeaway
A named tunnel with a stable hostname needs a domain whose DNS is on Cloudflare. A .com at Cloudflare Registrar costs about $10.46/yr now, with a reported rise of about $0.71 on 2026-11-01. One tunnel can publish many hostnames, each mapped to a different local service, so a public MCP hostname and an Access-protected GUI hostname can share one `cloudflared` process. Only quick tunnels work without a domain, and they are unsuitable.

### Cited Findings
- A "domain on Cloudflare" is required to publish applications through a tunnel. — [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/setup) (search summary)
- Dashboard routes create a CNAME to `<UUID>.cfargotunnel.com`, which only proxies DNS records in the same Cloudflare account. — [Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing) (updated 2026-10-16)
- "You can publish multiple applications on a single tunnel." Each published application maps a public hostname to a local service and adds an ingress rule. Capacity is roughly 5,000-10,000 applications, with configs up to 1 MB. An `http_status:404` service type exists for fixed responses. — [Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing)
- Quick Tunnels need no account or domain but are temporary. — [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
- MCP server portals also require "an active Cloudflare domain". — [Cloudflare MCP portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- Cloudflare Registrar `.com` costs $10.46/yr (third-party, 2026-05-20). The price rises $0.71 on 2026-11-01 (third-party, 2026-10-20). — [domainoffer.net](https://domainoffer.net/tld/com/cloudflare); [CostGoat](https://costgoat.com/compare/domains)
- A third-party guide notes the domain need not be registered with Cloudflare, but its DNS should be managed by Cloudflare. — [flaviocopes Cloudflare Tunnel guide](https://flaviocopes.com/cloudflare-tunnel/)
- `cloudflared` runs on macOS as a launch agent (`cloudflared service install`, starts at login, config in `~/.cloudflared/`) or a launch daemon (`sudo cloudflared service install`, starts at boot, config in `/etc/cloudflared`). Source date: last updated 2026-04-17 (just over six months, STALE? borderline). — [Cloudflare: run cloudflared as a macOS service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/macos/)

### Inferences
- **Two-hostname layout on one tunnel:**
  - `mcp.<domain>` goes to `http://localhost:8787`, either the whole app or only the MCP + OAuth routes if mem splits them.
  - `gui.<domain>` goes to the same or a different local port, behind an Access Allow app.
  - A catch-all 404 covers everything else.
- **The same tunnel config moves to a VPS unchanged.** `cloudflared` on a VPS keeps the same hostnames, so a later laptop-to-VPS migration does not change connector URLs registered in claude.ai or ChatGPT.
- **Path matching within one hostname was not covered** in the routing page read. Separate hostnames are the documented, simpler route.

### Gaps
- Whether a partial (CNAME) setup without moving nameservers works on the Free plan was not confirmed. Cloudflare's partial setup has historically been a paid-plan feature, but that was not verified here.
- Path-based ingress rules within one hostname were not confirmed in the pages fetched.

## 4. Moving off the laptop: VPS, PaaS and managed Postgres with pgvector

### Takeaway
For one person, the cheapest always-on setup is one small VPS running Node and Postgres + pgvector together: Hetzner CX23 at €5.99 or CAX11 at €6.49 excl. VAT, plus €1.20 for backups, or DigitalOcean at $6-12. Add `cloudflared` on the VPS, or Caddy, for TLS. This costs about the same as ngrok Hobbyist and removes the sleep problem. The price is OS patching and doing your own Postgres backups beyond VM snapshots.

Hetzner caveat: Hetzner raised cloud prices twice in 2026 (April and June). Its status page has shown "Limited availability of cloud instances" since 2026-06-26. On 2026-10-28 its plan pages show "currently unavailable" for CX, CAX and CPX, so ordering may be blocked.

Managed options cost more:
- **Managed Postgres:** Fly Managed Postgres starts at $38/mo (HA, backups, pgvector). Supabase Pro is $25/mo.
- **Free tiers:** Neon Free (scale-to-zero, 6 h restore window) or Supabase Free (500 MB, pauses after a week idle, no backups) work for a single user's data, but trade away backups or add cold starts.

### Cited Findings

**Hetzner**
- Cost-Optimized line (EU: NBG1/HEL1, prices excl. VAT, each with 20 TB traffic):

  | Plan | vCPU | RAM | Disk | Price/mo |
  |---|---|---|---|---|
  | CX23 | 2 | 4 GB | 40 GB | €5.99 |
  | CAX11 (Arm) | 2 | 4 GB | 40 GB | €6.49 |
  | CX33 | 4 | 8 GB | 80 GB | €8.99 |
  | CAX21 | 4 | 8 GB | 80 GB | €10.99 |

  Every plan displayed "This product is currently unavailable. Please check back later." when fetched 2026-10-28. — [Hetzner Cost-Optimized](https://www.hetzner.com/cloud/cost-optimized)
- Regular Performance line, EU (prices excl. VAT, 20 TB traffic):

  | Plan | vCPU | RAM | Disk | Price/mo |
  |---|---|---|---|---|
  | CPX02 (new) | 1 | 1 GB | 20 GB | €6.49 |
  | CPX12 | 1 | 2 GB | 40 GB | €11.99 |
  | CPX22 | 2 | 4 GB | 80 GB | €19.99 |

  - US (Ashburn/Hillsboro): CPX11 (2 vCPU, 2 GB) is €17.99 with only 1 TB traffic.
  - Add-ons: backups from €1.198/mo per instance (7 slots); snapshots €0.0143/GB-mo.
  - These plans also showed "currently unavailable" on 2026-10-28.
  - Source: [Hetzner Regular Performance](https://www.hetzner.com/cloud/regular-performance)
- Hetzner's status page shows an open "Limited availability of cloud instances" notice affecting Cloud Server since 2026-06-26 06:00 UTC, with no end estimate. — [Hetzner status](https://status.hetzner.com/)
- An earlier incident text cited high demand and a shortage of hardware components. New servers were restricted for new customers and some randomly chosen existing customers. — [Pingoru Hetzner incidents](https://pingoru.io/providers/hetzner) (third-party mirror)
- 2026 price changes (third-party, not verified against Hetzner's price-adjustment page):
  - From 2026-04-01, prices rose about 30-35%; for example, CX22 and CAX11 went from €3.29 to €4.49. — [igorslab](https://www.igorslab.de/en/hetzner-to-significantly-increase-prices-for-cloud-and-dedicated-servers-from-april-2026/); [agentdeals.dev](https://agentdeals.dev/hetzner-pricing-2026)
  - A second round took effect 2026-06-15 for new orders and rescales; for example, CAX11 went from €4.49 to €5.99 (+33%). — [privatedevops](https://privatedevops.com/news/hetzner-june-2026-cloud-price-increase-what-to-do); [DEV Community](https://dev.to/devopsdaily/hetzner-doubled-its-prices-again-the-ai-memory-crunch-is-why-64b)
  - Conflict: the live page on 2026-10-28 lists CAX11 at €6.49, not €5.99. Prices may have moved again, or the €6.49 figure may differ by location. Unresolved.
- An August 2026 blog found the CX and CAX lines "Currently not available" on 2026-08-17. — [Findstack on Hetzner 2026 price increase](https://findstack.com/resources/hetzner-price-increase-2026)

**DigitalOcean**
- DigitalOcean Basic Droplets (Regular CPU):
  - 512 MiB / 1 vCPU / 10 GiB: $4
  - 1 GiB / 25 GiB: $6
  - 2 GiB / 50 GiB: $12
- Backups add 20% of the Droplet price for weekly or 30% for daily, or usage-based backups from $0.01/GiB-mo.
- Undated; per-second billing from 2026-01-01.
- Source: [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing/droplets)

**Fly.io**
- Machines (shared-cpu-1x, iad/ewr): 256 MB $2.19/mo, 512 MB $3.69, 1 GB $6.70. A stopped machine's rootfs costs $0.15/GB-mo.
- Volumes cost $0.15/GB-mo provisioned. Snapshots cost $0.08/GB-mo with the first 10 GB free.
- Networking: dedicated IPv4 is $2/mo (shared IPv4 and IPv6 are free). Egress is $0.02/GB in North America and Europe.
- No free tier: the trial is 2 h of machine runtime or 7 days, and a credit card is required.
- Undated. — [Fly.io pricing](https://docs.fly.io/about/pricing)
- Fly Managed Postgres plans:

  | Plan | CPU | RAM | Price/mo |
  |---|---|---|---|
  | Basic | Shared-2x | 1 GB | $38 |
  | Starter | Shared-2x | 2 GB | $72 |

  - Storage costs $0.28/GB-mo on top, starting at 10 GB.
  - All plans include primary + replica HA, 10-day backups and PITR. pgvector ships in every image.
  - Regions include Amsterdam, Frankfurt and London.
  - Undated. — [Fly Managed Postgres](https://fly.io/mpg)

**Railway**
- Railway plans:
  - Free: $1/mo credit, 0.5 GB per service.
  - Hobby: $5/mo including $5 usage.
  - Pro: $20/mo.
- Resource prices: about $10/GB-RAM-mo, $20/vCPU-mo, volumes $0.15/GB-mo, egress $0.05/GB. Undated. — [Railway pricing](https://railway.com/pricing)

**Render**
- Free web services spin down after 15 min without inbound traffic, take about 1 min to spin up, and get 750 instance-hours/month.
- Free Postgres expires 30 days after creation (plus a 14-day grace period), is fixed at 1 GB, and has no backups.
- Undated. — [Render free tier docs](https://render.com/docs/free)

**Neon**
- Neon Free:
  - Storage: 1 GB per project (20 GB total).
  - Compute: 100 CU-hours per project, up to 2 CU.
  - Scale to zero is always on, with suspend after 5 min idle.
  - Restore window: 6 h (1 GB limit).
- Neon Launch: pay-as-you-go with no minimum, at $0.106/CU-hour and $0.35/GB-mo storage. History goes up to 7 days, and scale-to-zero can be disabled.
- Undated. — [Neon pricing](https://neon.com/pricing)
- Neon supports pgvector via `CREATE EXTENSION vector;`. Its extension table lists 0.8.x across supported Postgres versions; the column-to-version mapping was not verified. — [Neon pgvector docs](https://neon.com/docs/extensions/pgvector)

**Supabase**
- Supabase Free:
  - 500 MB database per project on shared CPU / 500 MB RAM.
  - Projects pause after 1 week of inactivity.
  - 2 active projects, 5 GB egress.
  - No automatic backups.
- Supabase Pro: from $25/mo with $10 compute credit and 7-day daily backups. PITR is a $100/mo add-on.
- Undated. — [Supabase pricing](https://supabase.com/pricing)
- Supabase enables pgvector via Dashboard → Extensions or `create extension vector with schema extensions;`. — [Supabase pgvector docs](https://supabase.com/docs/guides/database/extensions/pgvector)

### Inferences
- **Cheapest always-on stack:** one Hetzner CX23 or CAX11 (4 GB RAM; €5.99-6.49 plus €1.20 backups, about €7.20-7.70/mo excl. VAT) or a DigitalOcean $12 2 GiB droplet.
  - Run Docker Compose with Node and `pgvector/pgvector:pg17`.
  - Put `cloudflared` on the box, so no inbound ports are open.
  - Keep Cloudflare Access on the GUI hostname.
  - Data stays in an EU datacenter (Germany/Finland) if Hetzner EU is chosen.
- **If Hetzner ordering is blocked,** DigitalOcean or Fly are the fallbacks.
  - Fly: app 1 GB $6.70 + self-run Postgres machine 1 GB $6.70 + 10 GB volume $1.50, about $15/mo.
  - Fly with Managed Postgres instead: about $47/mo ($38 + 10 GB × $0.28 + app). This buys HA and PITR a single user rarely needs.
- **VPS + Neon Free** keeps compute cheap and offloads database backups. But Neon's 5-minute autosuspend adds a cold start to the first `recall` after idle, the 6 h restore window is short, and the database goes to a US/EU AWS region of Neon's choosing.
- **Supabase Free's limits matter for mem:** the weekly-idle pause is unlikely to trigger for a daily driver, but the 500 MB cap and the lack of backups are a risk for long-lived memory data.
- **Render Free and Railway Free are unsuitable for a daily-driver memory store.** Render spins down after 15 min and deletes free Postgres after 30 days. Railway Free has $1 of credit and 0.5 GB.
- **What one person takes on with a VPS:**
  - OS updates (unattended-upgrades).
  - Docker image updates.
  - A firewall (or no inbound ports with `cloudflared`).
  - TLS renewal (automatic with Caddy, or handled by Cloudflare).
  - Postgres logical backups (`pg_dump` to object storage), beyond provider VM backups.
- **What PaaS removes:** OS and TLS work, at roughly 1.5-6× the cost.
- **Keeping the URL stable across a migration:** keep the domain and Cloudflare tunnel, then point `cloudflared` on the VPS at the same hostnames. Connector registrations in claude.ai and ChatGPT stay valid.

### Gaps
- Hetzner's official price-adjustment announcement was not fetched. The 2026 increase details rest on third-party articles, and the €5.99 vs €6.49 CAX11 discrepancy is unresolved.
- Whether Hetzner's "currently unavailable" notice is a real ordering block for this account or a page-render artifact is unknown. Hetzner's FAQ says availability varies per customer.
- Whether Hetzner charges extra for a primary IPv4 in 2026 was not confirmed; historically it did, separately.
- Render's official Starter and Postgres prices were not retrievable.
- Neon and Supabase region lists and data-residency options were not researched.
- Neon's minimum compute size (needed to turn 100 CU-hours into wall-clock active hours) was not fetched.

## 5. macOS realities if mem stays on the laptop

### Takeaway
When the MacBook sleeps, Node, Docker/Postgres, `cloudflared` and `tailscaled` all stop. Cloudflare then returns error 1033, and Funnel or ngrok requests fail. Each case needs a different fix:
- **On power with the lid open:** "Prevent automatic sleeping on power adapter when the display is off" or `caffeinate -s` keeps it up.
- **With the lid closed:** the Mac sleeps unless it is in closed-display (clamshell) mode, which requires a power adapter, an external display and an external keyboard/mouse.
- **On battery:** neither `caffeinate -s` nor the power-adapter setting applies.

"Wake for network access" is for local shared services, not for inbound tunnel traffic. A travelling, sleeping laptop therefore cannot be an always-on MCP endpoint.

### Cited Findings
- On Mac laptops, System Settings → Battery → Options has "Prevent automatic sleeping on power adapter when the display is off". "Wake for network access" lets the Mac wake briefly so others can reach shared services. The page applies to macOS 27 per its version selector; undated. — [Apple: Set sleep and wake settings](https://support.apple.com/guide/mac-help/prevent-your-mac-from-sleeping-mchle41a6ccd/mac)
- Apple warns that preventing sleep increases power consumption, and some options vary by model. — [Apple: sleep and wake settings](https://support.apple.com/guide/mac-help/prevent-your-mac-from-sleeping-mchle41a6ccd/mac) (via search summary)
- `caffeinate` behavior per the man page (old man page, STALE? but stable behavior):
  - With no flags, it prevents idle sleep.
  - `-s` prevents system sleep but "is valid only when system is running on AC power".
  - `-i` prevents idle sleep.
  - `-w <pid>` holds the assertion until that process exits.
  - Wrapping a command (`caffeinate -i cmd`) holds the assertion for that command's lifetime.
  - Sources: [caffeinate(8) man page mirror](https://www.unix.com/man-page/osx/8/CAFFEINATE); [ss64 mirror](https://www.uucp.hu/mirror/ss64.com/osx/caffeinate.html)
- A third-party blog says closing the lid triggers clamshell sleep, which a software assertion cannot override on battery. Not confirmed by Apple. — [OpenReplay blog on caffeinate](https://blog.openreplay.com/mac-awake-overnight-agent-runs-caffeinate/)
- Closed-display mode needs an AC adapter (or a USB-C/Thunderbolt display that powers the Mac), an external display, and an external keyboard and mouse/trackpad. You close the lid after the desktop appears on the external display. This is an Apple-hosted community copy of Apple's article; the official article itself was not retrieved. — [Apple Community thread](https://discussions-jp-prz.apple.com/thread/252123651); [OWC guide](https://eshop.macsales.com/blog/64640-how-to-use-your-mac-laptop-in-closed-display-clamshell-mode/)
- When no healthy connector is available, Cloudflare returns error 1033 for tunnel hostnames. — [Cloudflare error 1033](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1033/) (updated 2026-04-23)
- `cloudflared` can run as a launch agent (at login) or launch daemon (at boot) via `cloudflared service install`. — [Cloudflare macOS service](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/macos/) (updated 2026-04-17)
- ngrok free endpoints have no timeout and should be run as a background service to stay up unattended. — [ngrok free plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits)

### Inferences
- **What laptop hosting can achieve:** "reachable when the Mac is open or docked on power". This needs four pieces:
  - "Prevent automatic sleeping on power adapter".
  - A launchd-managed `cloudflared`, `tailscaled` or ngrok agent.
  - mem's Node server under launchd or `caffeinate -i`.
  - Docker Desktop set to start at login.
- **Laptop hosting cannot achieve:** availability with the lid closed on battery, in a bag, or offline. claude.ai and ChatGPT will see 1033, timeout or connection errors during those periods.
- **Network changes:** `cloudflared`, Tailscale and ngrok all use outbound connections, so they generally survive NAT, hotel Wi-Fi and network changes by reconnecting. Captive portals will block them until you log in.
- **Power Nap does not help** an MCP endpoint: it runs background tasks on the Mac itself and does not hold inbound sessions.
- **The MCP connection breaks mid-session** if the laptop sleeps while a claude.ai conversation is using mem tools. The vendor then has to retry and re-establish the session.

### Gaps
- Apple's official closed-display-mode article (support.apple.com) was not retrieved directly; the steps come from Apple Community and third-party copies.
- Power Nap's exact current behavior on Apple silicon and macOS 27 was not researched.
- `pmset` options (for example `disablesleep`) were not researched.
- No official docs were found on how `cloudflared` or `tailscaled` behave across sleep/wake and network changes (reconnect timing).
- Docker Desktop's behavior on sleep/wake (container clock skew, Postgres recovery) was not researched.

## 6. Are AI vendors' egress IP ranges published for allow-listing?

### Takeaway
Yes for both, with different reliability:
- **Anthropic** publishes one stable outbound IPv4 block, `160.79.104.0/21`, used for MCP tool calls, and says it "will not change without notice". The old 34.162.x.x addresses are phased out.
- **OpenAI** publishes machine-readable JSON (`https://openai.com/chatgpt-connectors.json`) that changes over time. OpenAI calls the list best-effort and says an allowlist is not a substitute for auth; it recommends mTLS plus OAuth 2.1.

An IP allowlist can harden only the server-to-server paths, `/mcp` and the OAuth `/token` endpoint. The OAuth authorize/login page and the GUI are loaded by the user's own browser from arbitrary IPs.

### Cited Findings
- Anthropic's published ranges (undated, fetched 2026-10-28):
  - Outbound IPv4 `160.79.104.0/21`: "the stable IP addresses that Anthropic uses for outbound requests (for example, when making MCP tool calls to external servers)".
  - Inbound IPv4 `160.79.104.0/23`, IPv6 `2607:6bc0::/48`.
  - Phased out, remove from allowlists: `34.162.46.92`, `34.162.102.82`, `34.162.136.91`, `34.162.142.92`, `34.162.183.95`.
  - "These addresses will not change without notice."
  - Source: [Anthropic IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)
- Claude's help center says remote MCP servers must be reachable from Anthropic's IP ranges, and private-network servers must allowlist them. — [Claude Help: custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- OpenAI's published ranges (undated):
  - Files: `https://openai.com/chatgpt-connectors.json` covers ChatGPT plugins, connectors, GPT Actions and agentic commerce. `https://openai.com/chatgpt-agents.json` covers Codex cloud.
  - Each file has a `creationTime` and a `prefixes` array.
  - Ranges "can change as OpenAI infrastructure changes", so fetch regularly and automate.
  - An IP allowlist identifies OpenAI networks, not a user, and doesn't replace auth.
  - OpenAI recommends mTLS to authenticate ChatGPT as the MCP client, and OAuth 2.1 for users.
  - Source: [OpenAI IP egress ranges](https://developers.openai.com/api/docs/guides/ip-addresses)
- In the OpenAI developer forum, users reported calls from IPs missing from the JSON, and an OpenAI representative called the ranges "best effort". Another reply attributed Azure-range traffic in developer mode to Microsoft infrastructure. These are forum posts, not official docs. — [OpenAI community: unlisted IPs](https://community.openai.com/t/whitelisted-openai-ips-from-chatgpt-connectors-json-but-seeing-calls-from-other-ips-when-i-call-my-app/1372382); [OpenAI community: stability of ranges](https://community.openai.com/t/how-stable-is-chatgpt-s-published-egress-ip-ranges-for-apps/1368080)
- A third-party commentary describes `160.79.104.0/21` as Anthropic's only published outbound range, IPv4 only. — [Zuplo on Anthropic-managed agents](https://zuplo.com/learn/mcp/authentication/anthropic-managed-agents)

### Inferences
- **Allowlist as defense in depth only.** A Cloudflare WAF rule, or a Caddy/Hono middleware on a VPS, could restrict `/mcp` (and possibly `/token`) to `160.79.104.0/21` plus the current OpenAI prefixes. It must not apply to `/authorize`, the login page, `/.well-known/*` or the GUI.
- **Allowlisting ChatGPT means a sync job.** OpenAI's list changes and is best-effort, so a static allowlist could randomly break ChatGPT.
- **The allowlist also blocks direct clients.** It would block the owner's own non-vendor MCP clients (for example Claude Code or a local script hitting the public URL), unless they are exempted or use localhost.
- **Tailscale Funnel cannot enforce an allowlist at its edge.** mem would have to check client IPs itself, and whether Funnel forwards the original client IP was not verified.

### Gaps
- Whether Cloudflare's Free plan WAF custom rules (count, IP-list support) are enough for an Anthropic + OpenAI allowlist was not researched.
- Whether Tailscale Funnel or ngrok pass the original client IP to the origin (for app-level allowlisting) was not researched.
- Neither vendor's MCP client User-Agent string was researched. That matters for the ngrok interstitial and for logging.

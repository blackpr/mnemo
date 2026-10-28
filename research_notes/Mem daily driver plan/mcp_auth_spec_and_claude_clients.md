# MCP authorization spec (as of 2026-10-28) and how Claude's apps and Claude Code connect to a custom remote MCP server

Source freshness legend: all pages below were fetched on 2026-10-28. The MCP spec revision is dated 2026-07-28 (about 3 months old). claude.com/docs and code.claude.com pages show no date, but they cite Claude Code versions up to v2.1.305, so they are current. Help-center pages show relative dates: "Updated over 3 weeks ago" (about early October 2026) or "Updated this week" (late October 2026). Only one source is older than about 6 months (the March 2026 Gigazine article on the memory import launch), and it is flagged where used.

## Q1. Which MCP revision is current, what does its authorization section require, and what is the minimum a single-user server must build?

### Takeaway
The current MCP revision is **2026-07-28**. It succeeds 2025-11-25. It keeps the OAuth 2.1 resource-server model, makes CIMD the preferred way to register clients, and deprecates DCR. A server MUST serve RFC 9728 Protected Resource Metadata and MUST validate token audience. Its authorization server MUST offer RFC 8414 or OIDC discovery and support PKCE S256. Anthropic's hosted Claude apps, however, say they follow the auth specs only up to **2025-11-25**, and they still fall back to DCR. The minimum for mem is therefore a small authorization server built into the app, plus 401/PRM plumbing on the MCP route.

### Cited Findings
**Current revision and what changed**
- The versioning page says: "The **current** protocol version is **2026-07-28**." Revisions are marked Draft, Current or Final. — [MCP Versioning](https://modelcontextprotocol.io/specification/versioning)
- The changelog for 2026-07-28 says it lists changes "since the previous revision, 2025-11-25." — [MCP Changelog 2026-07-28](https://modelcontextprotocol.io/specification/latest/changelog)
- Major non-auth changes in 2026-07-28:
  - protocol-level sessions and `Mcp-Session-Id` are removed
  - the `initialize` handshake is removed; every request carries `io.modelcontextprotocol/protocolVersion` and client capabilities in `_meta`
  - a mandatory `server/discover` RPC is added
  - the GET SSE stream and resource subscribe are replaced by `subscriptions/listen`
  - SSE resumability is removed
  - tasks move to an extension
  - the Multi Round-Trip Requests pattern replaces server-initiated requests
  - list results get required `ttlMs`/`cacheScope` fields
  - Streamable HTTP POSTs get `Mcp-Method`/`Mcp-Name` headers
  — [MCP Changelog](https://modelcontextprotocol.io/specification/latest/changelog)
- Auth-related changes in 2026-07-28:
  - authorization servers SHOULD include `iss` in authorization responses (RFC 9207), and clients MUST validate a present `iss` (SEP-2468)
  - DCR clients MUST send `application_type` (SEP-837)
  - client credentials are bound to the issuing authorization server (SEP-2352)
  - DCR is deprecated in favour of CIMD (PR #2858)
  — [MCP Changelog](https://modelcontextprotocol.io/specification/latest/changelog)
- Newly deprecated features: Roots, Sampling and Logging; the HTTP+SSE transport (deprecated since 2025-03-26) is reclassified as Deprecated. — [MCP Changelog](https://modelcontextprotocol.io/specification/latest/changelog)
- On interop with older peers, the versioning page says: "Clients and servers **MAY** support multiple protocol versions simultaneously." A backward-compatibility section covers handshake-based revisions (2025-11-25 and earlier). — [MCP Versioning](https://modelcontextprotocol.io/specification/versioning)

**Scope and standards**
- "Authorization is **OPTIONAL** for MCP implementations." HTTP-based transports that support it SHOULD conform. STDIO implementations SHOULD NOT follow it and should "retrieve credentials from the environment." — [MCP Authorization (2026-07-28)](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Standards it builds on:
  - OAuth 2.1 draft-13
  - RFC 6750 (Bearer tokens)
  - RFC 8414 (Authorization Server Metadata)
  - RFC 7591 (DCR)
  - RFC 8707 (Resource Indicators)
  - RFC 9728 (Protected Resource Metadata)
  - RFC 9207 (issuer identification)
  - the CIMD draft (draft-ietf-oauth-client-id-metadata-document-00)
  - OIDC Discovery 1.0 and OIDC Dynamic Registration
  — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)

**Core MUST / SHOULD / MAY requirements**
- Authorization servers "**MUST** implement OAuth 2.1."
- Authorization servers and clients "**SHOULD** support" CIMD.
- They "**MAY** support" DCR, which "is deprecated and retained for backwards compatibility."
- "MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC9728)."
- Authorization servers "**MUST** provide at least one of" RFC 8414 metadata or OIDC Discovery 1.0, and clients MUST support both.
— [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)

**Discovery**
- The PRM document "**MUST** include the `authorization_servers` field containing at least one authorization server." — [Authorization Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
- Servers "**MUST** implement one of" two discovery mechanisms:
  - (1) a `WWW-Authenticate` header with `resource_metadata` on 401
  - (2) a well-known URI, either path-suffixed (`https://example.com/.well-known/oauth-protected-resource/public/mcp`) or root (`/.well-known/oauth-protected-resource`)

  Clients MUST support both, use the header when present, and otherwise try the path-suffixed URI and then the root. — [Authorization Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)
- Order in which clients look for AS metadata:
  - Issuer without a path: `/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration`.
  - Issuer with a path: three variants with path insertion or appending.
  - The `issuer` in the fetched document MUST be identical to the issuer used to build the URL, or the client MUST NOT use it.
  — [Authorization Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery)

**Scopes**
- Servers "**SHOULD** include a `scope` parameter in the `WWW-Authenticate` header." Clients use the challenge scope first, then all `scopes_supported` from PRM. — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Example 401: `WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="files:read"` — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- When a token's scope is insufficient at runtime, the server SHOULD return 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="...", resource_metadata="..."`. Clients SHOULD do step-up re-authorization using the union of old and new scopes. Servers MUST account for scope hierarchies. — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Servers "**SHOULD NOT** include `offline_access`" in the WWW-Authenticate scope or in PRM `scopes_supported`. Clients MAY request it when the AS metadata lists it. — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)

**Resource indicators, tokens and audience**
- Clients MUST send the RFC 8707 `resource` parameter on both authorization and token requests, set to the server's canonical URI. Valid examples include `https://mcp.example.com/server/mcp`. Canonical form uses no trailing slash, and clients send it "regardless of whether authorization servers support it." — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Clients MUST send `Authorization: Bearer <token>` on every request. "Access tokens **MUST NOT** be included in the URI query string." — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Servers "**MUST** validate that access tokens were issued specifically for them as the intended audience." Invalid or expired tokens MUST get 401. "MCP servers **MUST NOT** accept or transit any other tokens." — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Token passthrough ban: "The MCP server **MUST NOT** pass through the token it received from the MCP client." Servers MUST reject tokens whose audience does not include them. — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)

**Error codes**
- 401 means authorization is required or the token is invalid; 403 means invalid scopes or insufficient permissions; 400 means a malformed authorization request. — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)

**Client registration**
- Priority order for clients:
  1. pre-registered client information
  2. CIMD, if the AS advertises `client_id_metadata_document_supported`
  3. DCR, if the AS advertises `registration_endpoint`
  4. prompt the user for client info
  — [Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- CIMD requirements:
  - The `client_id` is an HTTPS URL with a path.
  - The document includes `client_id`, `client_name` and `redirect_uris`, and its `client_id` must match the URL exactly.
  - The AS SHOULD fetch it, MUST validate the `client_id` match, MUST validate redirect URIs against the document, and SHOULD cache it per HTTP headers.
  - Support is advertised with `"client_id_metadata_document_supported": true`.
  — [Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- Pre-registration: clients "**SHOULD** support an option for static client credentials". This means either a hardcoded client, or a UI where users enter a client ID and secret they registered themselves. — [Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)

**Security considerations**
- PKCE: clients MUST use PKCE, with "`S256` ... when technically capable." If AS metadata lacks `code_challenge_methods_supported`, clients "**MUST** refuse to proceed." OIDC providers MUST include that field. — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Communication security: "All authorization server endpoints **MUST** be served over HTTPS." "All redirect URIs **MUST** be either `localhost` or use HTTPS." — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Redirects: "Authorization servers **MUST** validate exact redirect URIs against pre-registered values." Clients SHOULD use `state`. — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Token lifetime: the AS "**SHOULD** issue short-lived access tokens." "For public clients, authorization servers **MUST** rotate refresh tokens." — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- CIMD-specific AS duties: consider SSRF when fetching; SHOULD warn for localhost-only redirect URIs; "**MUST** clearly display the redirect URI hostname during authorization"; MAY apply domain trust policies. — [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Issuer identification (RFC 9207): the AS SHOULD include `iss` in authorization responses. If it does, it MUST set `authorization_response_iss_parameter_supported: true`. A future revision is expected to make `iss` a MUST. — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)

**Tools and stateless design in 2026-07-28**
- `tools/list` "**MUST NOT** vary per-connection" but "**MAY** vary by the authorization presented on the request (for example, returning only the tools the caller's granted scopes permit)." — [MCP Tools (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

**What the installed libraries actually support (local files)**
- The installed `@modelcontextprotocol/sdk` is 1.32.1, with `LATEST_PROTOCOL_VERSION = '2025-11-25'` and `SUPPORTED_PROTOCOL_VERSIONS` back to `2024-10-07`. It does not list 2026-07-28. — [local SDK types.js](file:///Users/blackpr/code/mem/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js)
- `@hono/mcp` 0.3.2 ships `mcpAuthRouter`, `simpleMcpAuthRouter`, `wellKnownRouter`, `bearerAuth`, `ProxyOAuthServerProvider`, and handlers for authorize, token, register and revoke. — [local @hono/mcp auth.mjs](file:///Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.mjs)
  - Its generated AS metadata advertises `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["client_secret_post"]` only, and `registration_endpoint` only if a `registerClient` store exists. It has no `client_id_metadata_document_supported` field.
  - `wellKnownRouter` serves PRM at the path-suffixed URL when the resource has a path.
  - `bearerAuth`'s `WWW-Authenticate` points `resource_metadata` at the origin root `/.well-known/oauth-protected-resource`.

### Inferences
- **Minimum a single-user mem server must build** (inference from the spec plus Claude's stricter client, see Q2):
  - (a) On `POST /v1/banks/:bankId/mcp`, answer unauthenticated requests with HTTP 401 and `WWW-Authenticate: Bearer resource_metadata="<PRM URL>", scope="mem:read mem:write"`. This check must run before the MCP SDK runs.
  - (b) A PRM JSON document per bank URL, with `resource` exactly equal to `https://<host>/v1/banks/<bankId>/mcp` and `authorization_servers: [<issuer>]`. Serve it at the `resource_metadata` URL, ideally also at `/.well-known/oauth-protected-resource/v1/banks/<bankId>/mcp`.
  - (c) RFC 8414 AS metadata at `<issuer>/.well-known/oauth-authorization-server`, with `issuer`, `authorization_endpoint`, `token_endpoint`, `response_types_supported:["code"]`, `grant_types_supported:["authorization_code","refresh_token"]` and `code_challenge_methods_supported:["S256"]`. Also include either `client_id_metadata_document_supported:true` plus `"none"` in `token_endpoint_auth_methods_supported`, or a `registration_endpoint`, or rely on a pre-registered client entered in Claude's dialog.
  - (d) `/authorize`: authenticate the owner (for example with the existing API key or a passphrase), show a consent page that displays the redirect host, validate the exact `redirect_uri` and PKCE S256, and bind the requested `resource`.
  - (e) `/token`, accepting `application/x-www-form-urlencoded`: issue short-lived access tokens whose audience is the bank URL, and rotated refresh tokens.
  - (f) Validate audience and scope on every MCP request: 401 for missing or invalid tokens, 403 `insufficient_scope` for writes without `mem:write`.
- **Mapping to mem's model:** OAuth scopes map naturally onto mem's existing capabilities: `mem:read` maps to `read`, and `mem:write` maps to `write`. `admin` and `erase` should stay off the MCP surface. An issued token can resolve to a principal whose grants are limited to the bank in the `resource`.
- **Hono helper gaps:** the `@hono/mcp` helpers cover much of this, but they need overrides:
  - add the CIMD flag and the `none` auth method to the metadata
  - point `resource_metadata` at the per-bank path-suffixed PRM URL instead of the origin root
  - make sure the bank's path appears in PRM `resource`
- **Path-scoped banks:** because `bankId` is in the URL path, each bank is a separate OAuth "resource" and a separate connector in Claude.
- **Protocol version:** the 2026-07-28 changes (stateless, no `initialize`) match mem's stateless design. SDK 1.32.1 tops out at 2025-11-25, which is still what Anthropic's hosted apps document (Q2). Claude Code can negotiate down to the legacy revisions (Q5), so upgrading to SDK 2.x is not required to connect.

### Gaps
- I did not find a published date for when 2026-07-28 moved from Draft to Current. The revision ID implies about 2026-07-28.
- I did not check whether `@modelcontextprotocol/sdk` 2.x is released, or whether it ships a CIMD-capable server-side AS. The local SDK 1.32.1 only references `client_id_metadata_document_supported` in its client and shared code, not server code.

## Q2. claude.ai and Claude Desktop custom connectors: plans, transports, auth options, callback URL, network origin, IP ranges, cross-surface availability

### Takeaway
Every plan, including Free, can add custom remote connectors. Free is capped at one; on Team/Enterprise only Owners add them. Claude's hosted apps (web, Desktop, mobile, Cowork) connect **from Anthropic's cloud**, so the server needs a publicly routable HTTPS endpoint with an IPv4 address. A bare localhost:8787 cannot work.

Auth options:
- OAuth via CIMD ("Claude's published identity"), DCR ("Register automatically"), or your own client ID and secret
- authless
- static request headers, which are beta and limited to some organizations

The hosted callback is `https://claude.ai/api/mcp/auth_callback`. A connector added on web or desktop then appears on mobile.

### Cited Findings
**Plans and adding connectors**
- Custom connectors are on Free, Pro, Max, Team and Enterprise, in Claude, Cowork and Claude Desktop. "Free users are limited to one custom connector." — [Getting started with custom connectors (help center, updated ~early Oct 2026)](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- "On the Free plan, you can add one custom connector." On Team/Enterprise, an Owner adds it (or, on Enterprise, a member with a custom role that can manage libraries). Members then each connect with their own account. — [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted.md)
- Path for Pro/Max: Customize > Connectors > "Add custom connector". Enter the URL (for example `https://mcp.example.com/mcp`) and choose:
  - Authentication: "Sign in now", "Sign in when needed" or "No sign-in"
  - OAuth client: "Use Claude's published identity" (CIMD, recommended), "Register automatically" (DCR), or "Use your own OAuth client" (client ID; leave the secret blank unless the AS requires one)

  Some dialog layouts put the client ID and secret under "Advanced settings". — [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted.md)
- "You can't change authentication settings after you add a connector." To change them, you remove the connector and add it again. — [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted.md)

**Request headers (static credentials)**
- Request headers are "in beta and available to a limited set of organizations". The Owner enters an API key or bearer token once, and Claude sends it on every call.
- Allowed headers are `authorization`, `x-api-key`, `x-auth-token` and others; custom names need Anthropic approval. You can add up to four headers, and Claude sends the value exactly as entered, so you must type `Bearer <token>` yourself.
- Headers can be combined with OAuth, but `Authorization` can't be a header on an OAuth connection.
— [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted.md); [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- Anthropic's guidance on static credentials: "Never accept it in the URL ... don't read tokens from query parameters such as `?token=`." — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)

**Supported auth types**
- `oauth_dcr` and `oauth_cimd` are "Supported by default".
- `oauth_anthropic_creds` is for directory listings.
- `custom_connection` requires contacting Anthropic.
- `static_headers` is "Beta, for a limited set of organizations".
- `none` is supported by default.
- A machine-to-machine `client_credentials` grant "isn't supported".
— [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)

**Spec versions and transports**
- Anthropic says: "Claude follows the 2025-03-26, 2025-06-18, and 2025-11-25 authorization specifications." — [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index.md)
- Transport: "Use Streamable HTTP ... Claude also supports the legacy HTTP+SSE transport, which is being deprecated." A URL ending in `/sse` selects SSE, and Advanced > Transport can be changed if needed. — [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index.md); [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted.md)

**Where Claude's OAuth client is stricter than the spec**
- A 401 is required to start sign-in. Claude ignores `WWW-Authenticate` on a 200.
- Claude uses only the first entry in `authorization_servers`.
- Claude uses CIMD only when the AS metadata advertises both `client_id_metadata_document_supported: true` and `"none"` in `token_endpoint_auth_methods_supported`. Otherwise it falls back to DCR.
- Discovery, registration and token endpoints get 10 s; refresh requests get 30 s.
— [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- The PRM `resource` "must equal the URL as the user enters it in Claude, including any path component." The `resource_metadata` URL "can be any HTTPS location." Without a pointer, Claude probes `/.well-known/oauth-protected-resource/<mcp-path>` and then `/.well-known/oauth-protected-resource`. — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- Claude tries `/.well-known/oauth-authorization-server` (RFC 8414) first, then `/.well-known/openid-configuration`. Only one needs to answer. — [Troubleshoot your connector](https://claude.com/docs/connectors/building/troubleshooting.md)

**PKCE, scopes, callbacks and tokens**
- PKCE and scopes:
  - Claude sends PKCE S256 on every authorization request, and the AS should advertise `"code_challenge_methods_supported": ["S256"]`.
  - Scopes come from the 401's `scope` parameter, or else PRM `scopes_supported`.
  - Claude appends `offline_access` if the AS metadata lists it.
  — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- Callback URL for the hosted apps (claude.ai web, Desktop, mobile, Cowork): "register exactly this redirect URI: `https://claude.ai/api/mcp/auth_callback`". Claude Code instead uses a loopback redirect on an ephemeral port. — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- Tokens:
  - Claude refreshes reactively on 401, and proactively up to five minutes before expiry.
  - On an invalid refresh token, return `invalid_grant`.
  - Rotate refresh tokens for public clients; DCR and CIMD register Claude as a public client.
  - `/token` must accept `application/x-www-form-urlencoded`; `/register` uses JSON.
  — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- Audience: Claude sends `resource` set to the canonical server URL, including the path (lowercase scheme and host, no trailing slash). Servers "should accept the canonical value when checking `aud` rather than doing a strict byte-for-byte comparison against what the user typed." — [Troubleshoot your connector](https://claude.com/docs/connectors/building/troubleshooting.md)
- 403 handling: "A `403` triggers re-authentication only when accompanied by `WWW-Authenticate: Bearer error="insufficient_scope"` ... any other `403` is surfaced as a terminal error." Claude then retries the same tool call after step-up. — [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication.md)
- Claude caches PRM and AS metadata globally per URL, with "a staleness window of about five minutes." — [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication.md)
- With "Sign in when needed" (lazy auth), the server can allow `initialize`/`tools/list` without a token and answer protected `tools/call` with 401. Claude then shows an inline Connect card and retries. A 200 with `isError: true` does not trigger sign-in. — [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication.md)

**Network origin and reachability**
- "Connections come from Anthropic's cloud infrastructure, not your device." The page says this connection model applies to "every Claude client, including claude.ai, Claude Desktop, Cowork, and the mobile apps." — [Getting started with custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- Claude rejects hostnames that resolve to private ranges (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), loopback or link-local addresses, or a mix of public and non-public addresses. "Connectors are IPv4-only, so a hostname that only publishes `AAAA` records can't be reached." Dynamic DNS to a home NAT commonly fails. — [Troubleshoot your connector](https://claude.com/docs/connectors/building/troubleshooting.md)
- A cross-host 3xx redirect makes Claude drop the `Authorization` header, so you should register the final URL. A strict `Origin` check or a WAF can also block Anthropic. — [Troubleshoot your connector](https://claude.com/docs/connectors/building/troubleshooting.md); [Test your connector](https://claude.com/docs/connectors/building/testing.md)
- "Claude reaches custom connectors from Anthropic's infrastructure, so `localhost` isn't reachable directly." Testing a local server means using a public HTTPS tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`, with authentication kept on. — [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication.md); [Test your connector](https://claude.com/docs/connectors/building/testing.md)
- Egress range: "Anthropic's outbound traffic to your server originates from `160.79.104.0/21`." The IP page lists outbound IPv4 `160.79.104.0/21` (used "when making MCP tool calls to external servers") and phased-out `34.162.x.x/32` addresses. AS discovery requests come from the same range. — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md); [IP addresses](https://platform.claude.com/docs/en/api/ip-addresses)
- MCP tunnels, which need no inbound ports, are "in research preview and are available to organizations on the Claude Enterprise plan by request." — [MCP tunnels](https://claude.com/docs/connectors/mcp-tunnels/overview.md)

**Cross-surface availability**
- "A connected connector is available in your conversations on the web, desktop, and mobile." The surfaces support:
  - claude.ai web: remote connectors, including MCP Apps
  - Desktop: remote connectors plus local desktop extensions
  - mobile: remote connectors
  - Claude Code: claude.ai connectors, when signed in with a Claude account
  — [Get started with connectors](https://claude.com/docs/connectors)
- Mobile can't be used to add a connector: "users must add a connector on web or desktop before it appears on mobile." — [MCP Apps design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines)
- The same authentication infrastructure "backs claude.ai, Claude Desktop, Claude mobile, Claude Code, and Cowork." — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- Claude identifies itself in `clientInfo` as `claude-ai`, `Anthropic` (sometimes with a suffix) or `claude-code`. Anthropic warns not to gate on it, because "it's also unauthenticated." — [Test your connector](https://claude.com/docs/connectors/building/testing.md)

### Inferences
- For mem's hosted-app access, the owner needs a public HTTPS hostname with a public IPv4 A record that routes to the Hono server, for example via a reverse proxy on a VPS or a Cloudflare Tunnel. Optionally, a firewall can admit only `160.79.104.0/21` for the claude.ai path. That allowlist does not cover Claude Code, which connects from the user's own machine (see Q5).
- The authorization server (in-app) must sit on the same public host or another reachable HTTPS host. Its `/.well-known` paths must not be blocked by a WAF.
- The cheapest robust registration path is to advertise CIMD with `token_endpoint_auth_methods_supported` including `"none"`. That covers the hosted apps ("published identity") and Claude Code (its own CIMD) with no client database.
- The alternative that needs no CIMD or DCR is to pre-register one public client ID in mem's config and enter it under "Use your own OAuth client". Its allowed redirects would be `https://claude.ai/api/mcp/auth_callback` plus loopback any-port for Claude Code.
- Static request headers would let mem keep its bearer API key with no OAuth. However, that feature is beta and limited to some organizations, and it is described for "an organization Owner". Plan on OAuth.
- The Free plan's one-connector cap means one bank per Free account if banks stay path-scoped. Pro/Max can add one connector per bank.

### Gaps
- Anthropic does not publish the exact URL of the CIMD document its hosted apps use as `client_id`. Docs say only "a Client ID Metadata Document that Anthropic hosts". Claude Code's is published (Q5). A CIMD-supporting AS should therefore accept any HTTPS `client_id` URL, perhaps allowlisted to `claude.ai`/`claude.com` hosts. Note that the host allowlist is my inference.
- Some third-party guides reportedly also list `https://claude.com/api/mcp/auth_callback` as a callback. I did not verify this in official docs, which say to register "exactly" the claude.ai URL.
- I found no explicit statement on whether request-header auth is available to individual Pro/Max accounts.
- I found no explicit list of supported MCP protocol versions on the transport level for the hosted apps (beyond the auth-spec list), and no statement that they speak 2026-07-28.

## Q3. Once connected: write tools, approval prompts, server instructions, tool annotations, resources/prompts, and limits

### Takeaway
Claude's apps can call write tools. Users get "Allow once / Always allow" prompts and per-tool "Always allow / Needs approval / Blocked" settings. Tool annotations drive auto-permissions: read-only tools can run without confirmation, and destructive ones always prompt. Directory review requires `title` plus `readOnlyHint`/`destructiveHint`.

The hosted apps support tools, prompts and resources, but not resource subscriptions, sampling or "advanced or draft capabilities". Limits are about 150,000 characters per tool result and 240 seconds per tool call. I found no documentation that the hosted apps use the server `instructions` field.

### Cited Findings
**Approvals and permissions**
- Each conversation turns the connector on through "+ > Connectors". "Claude can ask for your approval before it uses one of the connector's tools. Select **Allow once** ... or **Always allow**." Under Tool permissions, each group of tools or single tool can be set to "**Always allow**, **Needs approval**, or **Blocked**". — [Get started with connectors](https://claude.com/docs/connectors)
- "Claude asks for approval before invoking tools." Help-center warning: "Research mode can invoke connector tools without further approval. Disable write-capable tools before using it" (paraphrased by fetch summary). — [Getting started with custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- "Every tool must include a `title` and the applicable hint: `readOnlyHint: true` for read-only tools, and `destructiveHint: true` for tools that modify or delete data. These determine auto-permissions in Claude. Read-only tools can run without per-call confirmation, and destructive tools always prompt." — [Connector pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria.md)
- "All MCP tools must declare both of these annotations: `readOnlyHint` ... `destructiveHint` ... Claude and users read these hints to understand what actions a tool can take." — [Model Context Protocol (MCP), claude.com docs](https://claude.com/docs/connectors/building/mcp)
- Other directory rules: separate read and write tools (no catch-all `method` tool); tool names ≤ 64 characters; no prompt-injection-style descriptions; actionable errors. "Don't query Claude's memory, chat history, conversation summaries, or user files." These are directory review criteria; custom connectors are not reviewed. — [Connector pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria.md)

**Annotation semantics in the spec**
- `readOnlyHint` defaults to false.
- `destructiveHint`: "If true, the tool may perform destructive updates ... If false, the tool performs only additive updates." It defaults to true and is meaningful only when `readOnlyHint == false`.
- `idempotentHint` defaults to false.
- `openWorldHint` defaults to true; "the world of a web search tool is open, whereas that of a memory tool is not".
- `title` is a display name.
— [MCP schema 2026-07-28 (schema.ts on GitHub)](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)
- "Clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers." There SHOULD be "a human in the loop with the ability to deny tool invocations." — [MCP Tools (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- The server `instructions` field is "Natural-language guidance describing the server and its features ... can be used by clients ... (e.g., by including it in a system prompt)". Use by clients is optional. — [MCP schema 2026-07-28](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts)

**Supported features and limits on the hosted apps**
- Features: "Your server can expose these to Claude: Tools, prompts, and resources; Text and image-based tool results; Text and binary resources. Claude doesn't yet support ... Resource subscriptions; Sampling; Advanced or draft capabilities." — [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index.md)
- Limits for claude.ai and Desktop: "Maximum tool result size ~150,000 characters", "Tool call timeout 240 seconds per tool call". Claude Code's limits are 25,000 tokens (configurable) and `MCP_TOOL_TIMEOUT`. — [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index.md)
- Tool-call failures appear as "Unexpected error while invoking tool". Generic errors fail directory review. — [Troubleshoot your connector](https://claude.com/docs/connectors/building/troubleshooting.md); [Connector pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria.md)
- MCP Apps (interactive `ui://` UI) render on web and desktop. On mobile they render in a native WebView with no camera, microphone or location access. — [Get started with connectors](https://claude.com/docs/connectors); [MCP Apps design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines)

**Organization controls and security warnings**
- Organization admins can set per-tool `ask` or `blocked` on claude.ai connectors. "The desktop app and claude.ai chat apply the same `blocked` setting." — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Security warning: "Malicious MCP servers may include hidden instructions." Only "Always allow" trusted servers. — [Getting started with custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)

### Inferences
- Suggested annotations for mem:
  - `recall` and `list_facts`: `readOnlyHint: true`, `openWorldHint: false`, plus a `title`. These should then run without per-call confirmation.
  - `retain`: `readOnlyHint: false`, `destructiveHint: false` (additive), `idempotentHint: false`, `openWorldHint: false`.
  - `confirm_fact` and `dispute_fact`: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` if the implementation is idempotent.

  If destructiveHint is omitted it defaults to true, which per Anthropic means "always prompt". Setting it false explicitly matters for a smooth daily-driver experience, though users can still pick "Always allow" per tool.
- The tool descriptions, not the `instructions` field, should carry the "when to call recall/retain" guidance. There is no evidence the hosted apps use `instructions`, though Claude Code does (Q5).
- mem's results must stay under ~150k characters, and slow extraction must not block a tool call for 240 s. mem already extracts facts asynchronously, which fits this.
- If the owner uses Research mode, writes may happen without prompts. They could block `retain` during research, or accept that.

### Gaps
- Not documented for the hosted apps: whether they read the server `instructions` field, whether a tool with `destructiveHint:false` and `readOnlyHint:false` prompts by default, and whether "destructive tools always prompt" overrides a user's "Always allow".
- No documented maximum tool count for claude.ai/Desktop connectors. Claude Code has no fixed cap (Q5).
- I did not find how MCP prompts and resources surface in the claude.ai UI (for example a "+" menu attach); the docs only say they are supported.
- Whether hosted apps support elicitation (form/URL) is not stated in the connector docs. Claude Code declares only form-mode elicitation on claude.ai-connector connections (Q5).

## Q4. Claude Desktop local options (desktop only): stdio config, Desktop Extensions (.mcpb), reaching a localhost HTTP server

### Takeaway
Claude Desktop can run local stdio MCP servers in two ways: through `claude_desktop_config.json` (Settings > Developer > Edit Config), or as one-click `.mcpb` Desktop Extensions with a bundled Node runtime and keychain-stored settings. These run on the user's machine with local network access, so a small stdio shim could forward to `http://localhost:8787` with the existing API key. However, they exist only in Desktop. They are not available on claude.ai, mobile or Cowork, so they don't meet the phone requirement.

### Cited Findings
**claude_desktop_config.json (stdio)**
- Setup: Claude menu > Settings > Developer > "Edit Config". The file is at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). It takes `{"mcpServers": {"name": {"command", "args", "env"}}}`, and Desktop must be fully restarted after edits. Logs are `~/Library/Logs/Claude/mcp.log` and `mcp-server-NAME.log`. "All actions require your explicit approval before execution." — [Connect to local MCP servers (modelcontextprotocol.io)](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- "Local MCP servers configured through `claude_desktop_config.json` use your local network and are a separate mechanism. They aren't available in Cowork or claude.ai." (paraphrased by fetch summary) — [Getting started with custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)

**Desktop Extensions (.mcpb)**
- An MCPB is "a zip archive containing a local MCP server and a `manifest.json`." "The server runs on the user's machine over stdio, so it can reach local files, locally installed tools, and systems behind the user's firewall." It bundles its dependencies, works offline and needs no OAuth. — [Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb.md)
- Node.js is "Included with Claude Desktop on macOS and Windows." `user_config` in the manifest auto-generates a settings UI. — [Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb.md)
- Users install by double-click, drag and drop, or Settings > Extensions > Advanced settings > Install Extension…. Install is per user. "Desktop extension listings in the directory are deprecated, and the directory no longer accepts MCPB submissions." — [Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb.md)
- Secrets are stored in Keychain (macOS), Credential Manager (Windows) or a distro keychain (Linux). "Claude Desktop includes a built-in Node.js environment." Team/Enterprise Owners control allowlists. — [Getting started with local MCP servers on Claude Desktop (help center, updated this week)](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- Local connectors are installed "as desktop extensions" in "Claude desktop app" only. Claude mobile supports "remote connectors" only. — [Get started with connectors](https://claude.com/docs/connectors)

**Platform support (minor conflict)**
- The MCPB page says Desktop runs on macOS and Windows; the MCP site says macOS, Windows and Linux. — [Build a desktop extension with MCPB](https://claude.com/docs/connectors/building/mcpb.md); [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

**Remote connectors in Desktop**
- Remote connectors added in Desktop still connect from Anthropic's cloud, not the device. — [Getting started with custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)

### Inferences
- A local stdio process launched by Desktop is an ordinary user process, so it can make HTTP calls to `http://localhost:8787`. A thin stdio-to-HTTP forwarder (config entry or `.mcpb` with `user_config` for the API key) is a viable Desktop-only stopgap that needs no OAuth or public exposure. This is inferred from "can reach ... systems behind the user's firewall"; it is not stated literally for localhost.
- A remote connector added in the Desktop UI cannot reach localhost, because the request originates in Anthropic's cloud.

### Gaps
- Not verified: whether current Desktop builds can declare a remote `url`-type server in `claude_desktop_config.json` itself (rather than via the connector UI). The official pages fetched only show stdio `command`/`args`/`env`.

## Q5. Claude Code: remote HTTP MCP with static headers and with OAuth (DCR/CIMD, /mcp flow), plus 2026 changes

### Takeaway
Claude Code connects from the user's own machine, so it can reach `localhost`. Static headers keep working:

`claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"`

Claude Code also does full OAuth. It triggers on 401/403, auto-discovers DCR and CIMD (its own CIMD at `https://claude.ai/oauth/claude-code-client-metadata`), and uses an ephemeral-port loopback redirect. It also supports a pre-configured `--client-id`/`--client-secret` with `--callback-port`, `claude mcp login`, and `headersHelper`.

In 2026 Claude Code gained a v2 runtime speaking protocol 2026-07-28, with fallback to legacy revisions. It also auto-imports claude.ai connectors when signed in with a Claude subscription.

### Cited Findings
**Adding remote servers and static headers**
- `claude mcp add --transport http secure-api https://api.example.com/mcp --header "Authorization: Bearer your-token"` (short forms `-t`, `-H`). `"type": "streamable-http"` is an alias for `"http"`.
- SSE is deprecated. v2.1.265+ tries HTTP first and falls back to SSE.
— [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- In remote `url` and `headers`, credential variables such as `ANTHROPIC_API_KEY` and `AWS_BEARER_TOKEN_BEDROCK` read as empty, so a project's `.mcp.json` can't exfiltrate them. Users must copy the value into their own variable name. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**OAuth**
- Claude Code flags a server as needing auth when it returns 401 or 403. Run `/mcp` for the browser flow, or `claude mcp login <name>` (`--no-browser` prints a URL). Tokens are stored and refreshed automatically. `claude mcp logout` clears them; removing a server does not revoke at the AS. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- "Claude Code discovers [DCR and CIMD] automatically." Error "Incompatible auth server: does not support dynamic client registration" means you need pre-configured credentials. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Pre-configured client: `claude mcp add --transport http --client-id … --client-secret --callback-port 8080 …`.
  - The secret is entered as masked input, or via `MCP_CLIENT_SECRET` for CI.
  - `--callback-port` fixes the redirect to `http://localhost:PORT/callback`.
  - v2.1.229 used `127.0.0.1` and broke exact-match servers; v2.1.231 restored `localhost`.
  - `.mcp.json` supports `oauth.authServerMetadataUrl` (https) and `oauth.scopes`.
  — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Claude Code "doesn't use" the hosted apps' OAuth client. It "uses its own Client ID Metadata Document and a loopback redirect". It "declares `http://localhost/callback` and `http://127.0.0.1/callback` in its Client ID Metadata Document" at `https://claude.ai/oauth/claude-code-client-metadata`. Servers should match both with the port ignored (RFC 8252 §7.3). — [Authentication for connectors](https://claude.com/docs/connectors/building/authentication.md)
- `headersHelper`: a command prints JSON headers. It has a 10-second limit, is re-run on 401/403, and if it returns `Authorization`, OAuth isn't used. It runs only after workspace trust for project or local scope. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**Scopes and claude.ai connectors**
- Config scopes are local (`~/.claude.json`, per project), project (`.mcp.json`) and user (`~/.claude.json`). Precedence: local > project > user > plugin > claude.ai connectors. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- "MCP servers you've added in claude.ai ... are automatically available in Claude Code" when the active auth method is a claude.ai subscription login. "A server you've added in Claude Code takes precedence over a claude.ai connector that points at the same URL", and the connector is shown as hidden. Opt-outs are `disableClaudeAiConnectors` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**Limits, timeouts and descriptions**
- Output limits: warning at 10,000 tokens; default limit 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`); text results over 50,000 characters are saved to file. A tool can raise its own threshold with `_meta["anthropic/maxResultSizeChars"]`, up to 500,000. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Timeouts:
  - `MCP_TIMEOUT` sets the startup timeout.
  - `MCP_TOOL_TIMEOUT` defaults to about 28 hours.
  - An idle timeout of 5 minutes applies to HTTP and connectors.
  - Calls still running after 2 minutes auto-background.
  — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Tool search is on by default: "Only tool names and server instructions load at session start". "Claude Code doesn't impose a fixed per-server tool cap." Server instructions and upfront tool descriptions are cut at 4,096 characters; tool-search-loaded descriptions at 16,384 (since v2.1.296; previously 2,048). `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` overrides this. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- A tool whose full name `mcp__<server>__<tool>` exceeds 128 characters is dropped. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**Annotations, resources, prompts and elicitation**
- `readOnlyHint` lets read-only calls run in parallel. `readOnlyHint` or `idempotentHint` lets Claude Code repeat a call once after a dropped connection. `_meta["anthropic/requiresUserInteraction"]: true` forces a prompt on every call, even in auto or bypass modes. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Resources are referenced via `@server:protocol://path`. Prompts become `/server:prompt (MCP)` commands. Elicitation dialogs appear automatically; Claude Code declares `{form, url}` on 2026-07-28 connections and for user-configured `http` servers (v2.1.287+), but bare `elicitation: {}` (form only) on claude.ai connector connections. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

**2026 changes**
- v2.1.232+ has a "v2 runtime (MCP TypeScript SDK 2.0, protocol revision 2026-07-28)", used by default on v2.1.274+ in some configurations. It is controlled by `MCP_SDK_GENERATION=v1|v2` and `MCP_PROTOCOL_NEGOTIATION=auto|legacy`. Other changes: MCP tasks public beta (v2.1.304+) and `/mcp reconnect all` (v2.1.284+). — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Claude Code connects to a `localhost` server directly, for example `claude mcp add --transport http authtest http://localhost:3000/mcp`. — [Lazy authentication](https://claude.com/docs/connectors/building/lazy-authentication.md)

### Inferences
- mem's current Claude Code setup (static bearer header to localhost:8787) keeps working unchanged. The tool list in this research session already exposes `mcp__mem__recall`/`retain`/etc., which suggests it is wired up today.
- Once mem has OAuth and a public URL, the same AS must accept Claude Code's CIMD and any-port loopback redirects for both `localhost` and `127.0.0.1`. Otherwise Claude Code can keep using the static header.
- Keep `retain`/`recall` descriptions and the server `instructions` under 4,096 characters, with key guidance first.

### Gaps
- Not checked: how Claude Code's v2 runtime negotiates with a 2025-11-25-only server like SDK 1.32.1 in practice. The docs only say negotiation is `auto|legacy`.

## Q6. Claude's built-in memory now: what it stores, view/edit, import/export, API, and guidelines on what it remembers

### Takeaway
Claude's memory is now stored as "individual topics" saved as you chat. The legacy experience instead kept a 24-hour synthesis. Users can view, edit and delete memory under Settings > Your Claude > Manage. Memory is per project, can be paused or reset, and is skipped in incognito chats.

Import is a paste box that takes "[date saved, if available] - memory content" lines. Export means viewing memory or asking Claude to write it out verbatim, plus inclusion in the account data export. I found no structured memory export or memory API. Published rules say sensitive categories are excluded by default and some data is never saved.

### Cited Findings
**What memory stores and where it applies**
- Current experience: Claude saves memory as "a set of individual topics as you chat, rather than summarizing conversations after they end."
- Legacy: a memory summary that "is updated every 24 hours" and "focuses on work-related context". The current scope is broader: communication preferences and some personal context.
- Each project has its own memory; turning off "Use account memory" keeps a project separate.
— [Use Claude's chat search and memory (help center, updated this week)](https://support.claude.com/en/articles/11817273)
- Memory is on by default for Free, Pro and Max; Team/Enterprise owners must enable it. It applies on web, Desktop and mobile. Chat search (RAG over past chats, shown as a tool call) is on paid plans. — [Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273)

**Viewing, editing and controls**
- View and edit under Settings > Your Claude > "Manage" next to "Your memory": read, edit or delete individual topics, or tell Claude in chat to remember, change or forget something.
- "Pause" keeps memory but stops use and creation. "Reset" "Permanently deletes all memories including project memories."
- Memory can be turned off for a single chat. Incognito chats aren't saved to memory or searched.
— [Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273)

**What Claude chooses not to remember**
- Sensitive topics (health, race, ethnicity, religion, politics, gender identity) are not stored by default; opting in is "Include sensitive topics in memory".
- Never saved, even on request: government ID numbers, criminal history, financial account numbers, immigration status.
— [Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273)

**Export and deletion**
- Memory "is included in data exports". Deleting a conversation doesn't remove memories derived from it. — [Use Claude's chat search and memory](https://support.claude.com/en/articles/11817273)

**Import**
- Import is available on Free, Pro, Max, Team and Enterprise, on web and Desktop.
- Flow: Settings > Your Claude > "Start import", paste text, "Add to memory".
- The provided prompt asks the other assistant to output all memories in one code block, formatted "[date saved, if available] - memory content". A Markdown export is an option if the other service can generate files.
- Claude "will extract key information and store it as individual memory entries". Verify via "See what Claude learned about you". Legacy imports "may take up to 24 hours".
- Imports are "experimental and still in active development". Because memory "is designed to focus on work-related topics", imported personal details unrelated to work may be dropped.
— [Import and export your memory from Claude (help center, updated this week)](https://support.claude.com/en/articles/12123587)
- Export described in that article: view memory under "Manage", or ask Claude to "Write out your memories of me verbatim, exactly as they appear in your memory" and copy the output. No file or structured export or API is described. — [Import and export your memory from Claude](https://support.claude.com/en/articles/12123587)
- Launch coverage (March 2026, >6 months old, possibly stale): memory came to the free tier and the import tool launched around 2026-03-02/03, with no API involved. — [Gigazine, 2026-03-03](https://gigazine.net/gsc_news/en/20260303-anthropic-upgrades-claude-memory-attract-ai-switchers)

**Directory policy relevant to mem**
- Directory connectors must not "query Claude's memory, chat history, conversation summaries, or user files". — [Connector pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria.md)

### Inferences
- A one-way mem → Claude bridge is possible by rendering mem facts as "[YYYY-MM-DD] - fact" lines for the paste-import flow. A Claude → mem bridge would rely on the verbatim write-out or the account data export, which have no stable schema.
- The two memories will diverge unless the owner turns off or pauses Claude memory while using mem as the source of truth. That is the owner's design choice.
- Claude's exclusions (government IDs, financial account numbers, etc.) are a reasonable reference policy for mem's own extraction filter.

### Gaps
- I found no public memory API and no documented structured (JSON) memory export. The data-export format for memory entries is not described in the pages fetched.
- I found no published, detailed guidelines on how Claude decides what to save beyond the help-center statements on sensitive categories, never-saved items and the (legacy) work focus.

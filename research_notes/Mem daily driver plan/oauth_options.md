# OAuth 2.1 for mem's MCP server: library and provider options, and how tokens map onto principals

_Researched 2026-10-28. Web pages were read through a fetch tool that summarises pages, so short quotes are close paraphrases unless they come from node_modules. Package versions and dates come from `npm view` and `gh api` run on 2026-10-28. "Stale" marks a source older than about six months (before about 2026-04-28)._

## 1. MCP TypeScript SDK server auth helpers, and what @hono/mcp 0.3 adds (plus the spec and client baseline every option must meet)

### Takeaway
In SDK v1, the authorization-server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`, `OAuthServerProvider`) only work with Express. They support only DCR: nothing on the server side implements CIMD. The v2 docs call these helpers "deprecated, frozen" and tell you to "migrate AS to a dedicated IdP/OAuth library". What the SDK still supports is the resource-server half: protected resource metadata and bearer verification. @hono/mcp 0.3.x ports the same authorization-server router to Hono. The installed 0.3.2 generates DCR client secrets with `Math.random` and rate-limits every caller from one global bucket. Both are fixed in 0.3.5. So the most mem should take from these packages is the resource-server pieces.

### Cited Findings
**Spec baseline (MCP revision 2026-07-28, current "latest")**
- Authorization servers and clients **SHOULD** support OAuth Client ID Metadata Documents (CIMD). Dynamic Client Registration (DCR, RFC 7591) is **MAY** and "is deprecated and retained for backwards compatibility". MCP servers **MUST** implement RFC 9728 Protected Resource Metadata (PRM). Authorization servers **MUST** offer RFC 8414 or OIDC Discovery. — [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Clients pick a registration method in this order: pre-registered client, then CIMD (if the AS advertises `client_id_metadata_document_supported`), then DCR (if a `registration_endpoint` exists), then manual entry. An AS supporting CIMD **MUST** check that the fetched document's `client_id` equals its URL, and **MUST** validate redirect URIs against the document. — [MCP Client Registration 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
- Clients **MUST** send `resource` (RFC 8707) in both the authorization and token requests, set to the server's canonical URI. A path is allowed, e.g. `https://mcp.example.com/server/mcp`. Servers **MUST** check that the token's audience is them, **MUST NOT** accept or pass on any other token, and **MUST** return 401 for invalid or expired tokens. — [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Servers **SHOULD** put `scope` in the `WWW-Authenticate` challenge, and **SHOULD** answer a token with too little scope with 403 `insufficient_scope`. They **SHOULD NOT** list `offline_access` in PRM `scopes_supported`. Authorization servers **SHOULD** emit the RFC 9207 `iss` parameter and, if they do, **MUST** advertise `authorization_response_iss_parameter_supported`. — [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/latest/basic/authorization)

**What claude.ai requires (Claude connector docs, undated, fetched 2026-10-28)**
- Out of the box, Claude supports `oauth_dcr`, `oauth_cimd` and `none`. `static_headers`, where a fixed API key is sent in a header, is "Beta, for a limited set of organizations". — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- Claude uses CIMD only when the AS metadata advertises both `"client_id_metadata_document_supported": true` and `"none"` in `token_endpoint_auth_methods_supported`. Otherwise it falls back to DCR. With DCR, Claude "register[s] a new client on every fresh connection". — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- The claude.ai callback is exactly `https://claude.ai/api/mcp/auth_callback`. Claude Code uses its own CIMD (`https://claude.ai/oauth/claude-code-client-metadata`) with loopback redirects to `http://localhost/callback` and `http://127.0.0.1/callback` on any port. — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- A 401 is required; a `WWW-Authenticate` header on a 200 is ignored. Claude uses only the first `authorization_servers` entry. The PRM `resource` must equal the URL the user enters, path included. Without a `resource_metadata` pointer, Claude probes `/.well-known/oauth-protected-resource/<mcp-path>` and then the root. — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- The token endpoint must accept `application/x-www-form-urlencoded`. Claude refreshes on a 401 and up to 5 minutes before expiry. Expired refresh tokens must get `invalid_grant`. Refresh tokens should rotate for public clients (DCR and CIMD clients are public). Time limits are 10 s for discovery, registration and token calls, and 30 s for refresh. Claude adds `offline_access` if the AS lists it. Egress is from `160.79.104.0/21`. `client_credentials` is not supported. — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)

**What ChatGPT requires (OpenAI Apps SDK auth docs, undated, fetched 2026-10-28)**
- ChatGPT "prioritizes CIMD when it is available", and can use DCR. Its CIMD client IDs are `https://chatgpt.com/oauth/client.json` or `https://chatgpt.com/oauth/{callback_id}/client.json`. Its redirects are `https://chatgpt.com/connector_platform_oauth_redirect` when the AS supports `iss`, otherwise `https://chatgpt.com/connector/oauth/{callback_id}`. For CIMD it authenticates with `none` or `private_key_jwt`. It sends `resource` on both requests and requires S256 PKCE. — [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth)
- ChatGPT also presents an OpenAI-managed mTLS client certificate with SAN `mtls.prod.connectors.openai.com`. The docs strongly recommend an established IdP, naming Auth0 and Stytch, and prefer IdPs that support CIMD. — [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth)

**MCP SDK v1 as installed (1.32.1; latest v1 is 1.32.2, published 2026-10-23 per [npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk))**
- `mcpAuthRouter` returns an Express `RequestHandler` and `mcpAuthMetadataRouter` returns an `express.Router`. The file opens with `import express ... from 'express'`. — `/Users/blackpr/code/mem/node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/router.d.ts`
- With the `OAuthServerProvider` interface, you write `clientsStore`, `authorize(client, params, res: express.Response)`, `challengeForAuthorizationCode`, `exchangeAuthorizationCode(..., resource?)`, `exchangeRefreshToken`, `verifyAccessToken` and an optional `revokeToken`. In other words, you write all storage and token minting yourself. — `/Users/blackpr/code/mem/node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/provider.d.ts`
- `requireBearerAuth({verifier, requiredScopes, resourceMetadataUrl, expectedResource})` is Express middleware. When set, `expectedResource` compares against `AuthInfo.resource`. `AuthInfo` is `{token, clientId, scopes, expiresAt?, resource?, extra?}`. — `/Users/blackpr/code/mem/node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/middleware/bearerAuth.d.ts`, `.../server/auth/types.d.ts`
- `client_id_metadata_document_supported` appears only in `shared/auth.*` (schemas) and `client/auth.js`, never under `server/auth/`. So the v1 authorization-server helpers do not implement CIMD (grep of `/Users/blackpr/code/mem/node_modules/@modelcontextprotocol/sdk/dist/esm`).
- The v1 README calls one example an "OAuth demo authorization server": an in-memory provider (`demoInMemoryOAuthProvider.ts`). The v1 README does not call `mcpAuthRouter` itself demo-only. — `/Users/blackpr/code/mem/node_modules/@modelcontextprotocol/sdk/README.md`

**MCP SDK v2 (`@modelcontextprotocol/server` 2.4.0, 2026-10-23; `@modelcontextprotocol/hono` 2.0.2, 2026-10-02 per [npm](https://www.npmjs.com/package/@modelcontextprotocol/server))**
- The authorization-server helpers moved to `@modelcontextprotocol/server-legacy/auth`, described as "(deprecated, frozen v1 copy)". The guidance is to "migrate AS to a dedicated IdP/OAuth library". Staying on the frozen copy is "a supported interim choice". `@modelcontextprotocol/hono` is listed under built-in framework support. — [SDK v2 upgrade guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
- The SDK "never issues" tokens. `requireBearerAuth` for fetch-style hosts, which names Hono, is exported from `@modelcontextprotocol/server`, along with `oauthMetadataResponse` for PRM. You supply `verifyAccessToken`. If `expiresAt` is unset the token gets a 401. In `@modelcontextprotocol/express` 2.0.1, `expectedResource` is not passed through, so audience goes unchecked. "Use a dedicated identity provider for new servers." — [SDK v2: Require authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html)
- Open issue #2751 (opened 2026-09-03): with the SDK's defaults, an MCP endpoint that has a path gets discovery that does not meet RFC 9728. PRM is served only at the root, with `resource` set to the origin. Stricter clients (Gemini CLI, Antigravity) reject this. — [typescript-sdk#2751](https://github.com/modelcontextprotocol/typescript-sdk/issues/2751)

**@hono/mcp (installed 0.3.2; latest 0.3.5, published 2026-10-28 per [npm](https://www.npmjs.com/package/@hono/mcp))**
- `@hono/mcp/auth` exports `mcpAuthRouter`, `ProxyOAuthServerProvider`, `authorizeHandler`, `tokenHandler`, `clientRegistrationHandler`, `revokeHandler`, `authenticateClient`, `wellKnownRouter`, `simpleMcpAuthRouter` and `bearerAuth`. They are Hono ports that reuse the SDK's `OAuthServerProvider` type (with a Hono `Context` in place of the Express `res`). Rate limiting needs the `hono-rate-limiter` peer dependency. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.d.mts`
- The authorize handler requires `code_challenge_method` S256 and accepts `resource`. It matches redirect URIs exactly, except loopback hosts, where the port is ignored per RFC 8252. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.mjs` (lines 9-60)
- The metadata builder advertises only `token_endpoint_auth_methods_supported: ["client_secret_post"]` and no `client_id_metadata_document_supported`. Claude would therefore never choose CIMD against it. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.mjs` (lines 292-312)
- In 0.3.2, a DCR client secret is `genRanHex(64)`, built on `Math.random()`. The secret is compared with `!==`. Every rate limiter uses `keyGenerator: () => "some-unique-key"`, a single global bucket. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.mjs` (lines 120, 146, 272, 326-360). The 0.3.5 changelog: "Enforces `mcpAuthRouter` rate limits per client address and generates `client_secret` from the CSPRNG". — [@hono/mcp CHANGELOG](https://github.com/honojs/middleware/blob/main/packages/mcp/CHANGELOG.md)
- `bearerAuth` wraps `hono/bearer-auth`. Its `WWW-Authenticate` value is `Bearer error="Unauthorized", ... resource_metadata="<origin>/.well-known/oauth-protected-resource"`, which points at the root rather than a path. `wellKnownRouter` does serve path-aware PRM at `/.well-known/oauth-protected-resource{path}` and mirrors AS metadata at `/.well-known/oauth-authorization-server`. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.mjs` (lines 240-250, 385-388). RFC 6750 defines only `invalid_request`, `invalid_token` and `insufficient_scope` as error codes. — [RFC 6750 §3.1](https://datatracker.ietf.org/doc/html/rfc6750#section-3.1)
- The `@hono/mcp` transport reads `ctx.get("auth")` and passes it on as the SDK's `authInfo`. So middleware that runs `c.set("auth", AuthInfo)` makes token data visible to tool handlers. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/index.mjs` (line 225)
- The README documents only `simpleMcpAuthRouter`, "the simplest way to setup MCP Auth when using 3rd party auth providers". It gives no production warning and does not mention CIMD or SDK v2. — [@hono/mcp README](https://github.com/honojs/middleware/blob/main/packages/mcp/README.md)
- Hono 4.13.13 ships a `jwk` middleware with options `jwks_uri`, `alg` and `verification` (which includes `aud`). `jose` 6.2.13 is already installed as an SDK dependency. — `/Users/blackpr/code/mem/node_modules/hono/dist/types/middleware/jwk/jwk.d.ts`, `/Users/blackpr/code/mem/node_modules/hono/dist/types/utils/jwt/jwt.d.ts`

### Inferences
- Building mem's authorization server on `mcpAuthRouter` (SDK or @hono/mcp) breaks the owner's "battle-tested over hand-rolled" rule. Clients, codes, tokens, refresh rotation, consent and storage would all be written in-house. It also lacks CIMD, which both claude.ai and ChatGPT prefer, and upstream has frozen it.
- The resource-server half is small and safe to own. It consists of: (a) PRM JSON per bank, served at `/.well-known/oauth-protected-resource/v1/banks/{bankId}/mcp`; (b) a 401 challenge whose `resource_metadata` points at that path-specific URL, not the root one @hono/mcp's `bearerAuth` emits; (c) JWT verification with `jose.createRemoteJWKSet` plus `jwtVerify({issuer, audience})`; (d) `c.set("auth", ...)`.
- If any @hono/mcp auth export is kept, upgrade to at least 0.3.5.

### Gaps
- No v1.x support window was found, so it is unknown how long `@modelcontextprotocol/sdk` 1.x will get fixes. The upgrade guide was read only up to 100k characters.
- The CIMD URL Claude uses for claude.ai web (as distinct from Claude Code) is not published on the page read.

## 2. better-auth: MCP plugin, OAuth provider, CIMD, maturity

### Takeaway
better-auth is the most complete option that embeds in mem as TypeScript. `@better-auth/mcp`, built on `@better-auth/oauth-provider`, combined with `@better-auth/cimd`, `jwt()` and `@better-auth/passkey`, provides CIMD, opt-in DCR, PKCE S256, RFC 8707 audiences, automatic RFC 9728 metadata, hooks for login and consent pages, and refresh rotation. It is fetch-native, so it mounts in Hono in one line, and it can live in its own Postgres schema over `pg`. The costs:
- **Churn:** the MCP plugin changed packages in 1.7.0 (Aug 2026), and the 1.8 beta has breaking OAuth-provider changes.
- **Security history:** many advisories in 2026, several in OAuth-adjacent code (mostly the legacy plugins).
- **Static resource list:** the list of resource identifiers is fixed in config, so each bank's MCP URL has to be registered through the admin API.
- **JWT revocation:** JWT access tokens cannot be revoked server-side.

### Cited Findings
- Versions on 2026-10-28: `better-auth`, `@better-auth/mcp`, `@better-auth/oauth-provider` and `@better-auth/cimd` are all at 1.7.14 (published 2026-10-26/27). The beta is 1.8.0-beta.3. 1.7.0 was published 2026-08-18 and 1.6.0 on 2026-04-06. — [npm better-auth](https://www.npmjs.com/package/better-auth), [npm @better-auth/mcp](https://www.npmjs.com/package/@better-auth/mcp)
- 30.5k GitHub stars and 912 open issues; last push 2026-10-28. — [github.com/better-auth/better-auth](https://github.com/better-auth/better-auth) (via `gh api`)
- Release cadence: 10 releases between 15 and 27 Oct (1.7.9 to 1.7.14, plus 1.8.0-beta.0 to beta.3). 1.8.0-beta.0 brings breaking `oauth-provider` changes: device approval moved into `/oauth2/authorize`, revocation and introspection errors changed, and repeated form parameters are rejected. 1.7.12 fixed `requireMcpAuth` so it accepts only OAuth access tokens and rejects session JWTs. — [better-auth releases](https://github.com/better-auth/better-auth/releases)
- Is the old MCP plugin deprecated? Yes. The 1.7.0-beta.6 notes say "Moved the MCP plugin into its own package, @better-auth/mcp, built on @better-auth/oauth-provider". `withMcpAuth` became `requireMcpAuth`, and the `oauthApplication` table became `oauthClient`. `oidcProvider` was removed from `better-auth/plugins`, with `@better-auth/oauth-provider` as its replacement. — [newreleases.io: v1.7.0-beta.6](https://newreleases.io/project/github/better-auth/better-auth/release/v1.7.0-beta.6) (secondary mirror of the GitHub release). The old `docs/plugins/oidc-provider` page now returns 404. — [better-auth.com/docs/plugins/oidc-provider](https://www.better-auth.com/docs/plugins/oidc-provider)
- The MCP plugin install is `npm install @better-auth/mcp @better-auth/cimd @modelcontextprotocol/server zod`. Config is `plugins: [jwt(), mcp({ loginPage, consentPage, resource }), cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" })]`. `jwt()` is required; it supplies the signing key and `/jwks`. "`mcp()` is the OAuth provider", so do not also register `oauthProvider()`. — [better-auth MCP plugin](https://www.better-auth.com/docs/plugins/mcp)
- What the MCP plugin supports:
  - DCR is off by default and needs both `allowDynamicClientRegistration` and `allowUnauthenticatedClientRegistration`.
  - CIMD is the recommended mechanism.
  - PKCE.
  - The `resource` value becomes the JWT `aud`.
  - RFC 9728 metadata is served automatically at the well-known path.
  - `consentPage`.
  - DPoP.
  - The device flow.
  - A refresh-reuse interval that defaults to 30 s for `mcp()` clients.
  - `insufficient_scope` step-up.

  — [better-auth MCP plugin](https://www.better-auth.com/docs/plugins/mcp)
- On the resource side, `requireMcpAuth(auth, (request) => handler.fetch(request), { resource })` checks signature, issuer, audience and expiry against the JWKS. Its options are `resource`, `issuer`, `jwksUrl`, `requiredScopes` and `challengeScopes`. It returns 401 with `WWW-Authenticate`, or 403 `insufficient_scope`. `createMcpProtectedRequestHandler({issuer, audience, jwksUrl}, handler)` serves a separate resource server. Both work on standard `Request`/`Response`. — [better-auth MCP plugin](https://www.better-auth.com/docs/plugins/mcp)
- In `@better-auth/oauth-provider`, `resources` is a static list of strings or `{identifier, allowedScopes, accessTokenTtl}`. Admin resource endpoints handle runtime changes. An unknown or disabled resource gets `invalid_target`. DCR clients can request no resource unless `clientRegistrationDefaultResources` or `clientRegistrationAllowedResources` is set. — [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider)
- Token claims: `sub`, `iss`, `aud`, `exp`, `iat`, `sid`, `scope` and `azp`. No `client_id` claim is listed. `customAccessTokenClaims` adds claims but drops reserved names. — [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider)
- Revocation and lifetimes:
  - `POST /oauth2/revoke` follows RFC 7009.
  - "JWT access tokens cannot be revoked server-side".
  - `adminUpdateOAuthClient({ disabled: true })` disables a client, though locally verified JWTs stay valid until they expire.
  - `deleteOAuthClient` and `deleteOAuthConsent` exist.
  - Defaults: access token 1 h, refresh token 30 d, code 10 min, `refreshTokenReuseInterval` 0. A new refresh token is issued on every refresh.
  - `skip_consent` is admin-only, for trusted clients.
  - `clientRegistrationAllowedScopes` should be set explicitly, otherwise all scopes are registrable.

  — [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider)
- `@better-auth/cimd` details:
  - `isMetadataDocumentUrlAllowed(url)` is the trust-policy hook.
  - The Node fetcher resolves DNS once and rejects RFC 6890 special-use addresses, pins the connection to the approved address, follows no redirects, times out after 5 s and caps documents at 5 KB.
  - `metadataFetchPolicy` rate-limits fetches.
  - CIMD clients are stored in `oauthClient` with `clientDiscoveryId: "cimd"`.
  - Loopback client-ID URLs are unsupported.
  - A DNS check followed by `globalThis.fetch` is flagged as vulnerable to DNS rebinding.

  — [better-auth CIMD plugin](https://www.better-auth.com/docs/plugins/cimd)
- Hono mount: `app.all("/api/auth/*", (c) => auth.handler(c.req.raw))`. Register CORS before it, and add origins to `trustedOrigins`. — [better-auth Hono integration](https://www.better-auth.com/docs/integrations/hono)
- Postgres: pass `database: new Pool({ connectionString })` (Kysely adapter). `database.schemaName: "auth"`, or `options: "-c search_path=auth"`, keeps it in its own schema. `npx auth@latest generate` emits SQL (including `create schema if not exists "auth"`), and `migrate` applies it. — [better-auth PostgreSQL adapter](https://www.better-auth.com/docs/adapters/postgresql)
- Security advisories, 2026:
  - **June 2026 cycle:** GHSA-g38m-r43w-p2q7 (OAuth account linking, High, fixed in 1.6.11), CVE-2026-45337 (device authorization owner binding, High) and GHSA-fmh4 (organization invitations, High). The cycle's advice was to update all directly installed Better Auth packages. — [Better Auth: Security update June 2026](https://better-auth.com/blog/security-update-june-2026)
  - **GHSA-wxw3-q3m9-c3jr**, published 2026-05-15: the OAuth callback accepted a mismatched `state` (below 1.6.2, cookie state without PKCE, Medium). — [CIRCL: GHSA-wxw3-q3m9-c3jr](https://vulnerability.circl.lu/vuln/GHSA-WXW3-Q3M9-C3JR)
  - **CVE-2026-67333**, published 2026-07-07, CVSS 7.7: stored XSS through a `javascript:` redirect_uri in the legacy `oidc-provider` and `mcp` plugins, fixed in 1.6.13 and 1.7.0-beta.4. "`@better-auth/oauth-provider` is not affected". — [Corgea: CVE-2026-67333](https://corgea.com/advisories/vulnerabilities/CVE-2026-67333)
  - **CVE-2026-53512**: refresh-token replay through missing client authentication in the legacy `oidc-provider` and `mcp` plugins (title only, seen in search results). — [Corgea: CVE-2026-53512](https://corgea.com/advisories/vulnerabilities/CVE-2026-53512)
  - **September 2026:** GHSA-965c-763c-88jm, Critical: "OAuth state can be used as a Magic Link to sign in as another user" (2026-09-30). GHSA-r4xp-prcw-77qf, High: OAuth Proxy (2026-09-30). GHSA-q84f-53jg-9ppm, High: device login approval did not show the requesting client or permissions (2026-09-28). — [better-auth security advisories](https://github.com/better-auth/better-auth/security/advisories)
  - **GHSA-qq9h-g4jm-xgf3**, High: an attacker's password kept working after a magic-link or email-OTP sign-in (2026-06-26). — [better-auth security advisories](https://github.com/better-auth/better-auth/security/advisories)
  - One aggregator counts 13 advisories for the npm package, snapshot date unknown. — [Corgea: better-auth](https://corgea.com/advisories/packages/npm/better-auth)

### Inferences
- How it fits mem: it runs in the same Node process and the same Postgres, in its own `auth` schema, so "one schema per bounded context" holds. The generated SQL can be checked into mem's plain-SQL migrations, and the single-npm-package rule holds because these are ordinary dependencies. mem still has to build a sign-in page and a consent page (Hono JSX is enough), set up passkeys, and register one `resource` per bank through the admin resource API when a bank is created.
- Most advisories hit plugins mem would not enable: legacy `oidcProvider`/`mcp`, oauth-proxy, magic-link, SSO, SCIM, Stripe. The volume and cadence still mean pinning exact versions, watching GitHub advisories and upgrading often. Stay on the 1.7.x stable line, not the 1.8 beta.
- JWT access tokens cannot be revoked. Keep their lifetime short (5-15 min), and rely on mem's existing per-request Scope resolution against `governance.grants`/`principals` to cut off a client immediately (see question 7).

### Gaps
- Not documented: whether `mcp()` accepts several `resources`, or a callback, to support one audience per bank without admin-API calls. The oauth-provider docs show a static list plus admin endpoints only.
- Not documented: whether the built-in consent flow passes the CIMD client name and redirect-URI host to the consent page. The CIMD doc is silent.
- No support-window policy was found for the 1.7 line after 1.8 ships. Note that a `release-1.6` dist-tag at 1.6.33 exists.

## 3. panva `oidc-provider`: coverage, certification, mounting in Hono, Postgres adapter, effort

### Takeaway
`oidc-provider` is the most standards-mature option. It is OpenID Certified (including FAPI 2.0) and has one long-time maintainer; v9.13.2 was published 2026-10-28. It covers DCR, PKCE, RFC 8707 resource indicators with a callback (`getResourceServerInfo`) that fits per-bank audiences, JWT access tokens (RFC 9068), RFC 9207 and DPoP. CIMD is experimental (draft-02) but comes with SSRF protection built in. mem would have to write a Postgres adapter, the login and consent "interaction" pages, a Hono-to-Node bridge, and PRM on the resource side. That is moderate work but entirely its own code paths.

### Cited Findings
- 3.8k stars. "OpenID Certified™ OAuth 2.0 Authorization Server implementation for Node.js". Certified profiles include Basic, Implicit, Hybrid, Config, Form Post, 3rd-Party-Init, Back-Channel and RP-Initiated Logout, FAPI 1.0, FAPI CIBA and FAPI 2.0. — [panva/node-oidc-provider](https://github.com/panva/node-oidc-provider)
- Stable features include RFC 7591/7592 DCR, PKCE, RFC 7662 introspection, RFC 7009 revocation, RFC 8707 resource indicators, RFC 9068 JWT access tokens, DPoP, PAR, JAR, RAR, mTLS, device flow, RFC 8252 and RFC 9207. CIMD (draft-02) is experimental, and "updates to experimental feature specification versions are released as MINOR library versions", so pin with `~`. — [panva/node-oidc-provider](https://github.com/panva/node-oidc-provider)
- The author is the "sole maintainer". Auth0 by Okta sponsors the project. — [panva/node-oidc-provider](https://github.com/panva/node-oidc-provider)
- Releases: 9.0.0 (2025-04-15), 9.11.0 (2026-07-26), 9.12.0 (2026-08-28), 9.13.2 (2026-10-28). — [npm oidc-provider](https://www.npmjs.com/package/oidc-provider)
- 9.13.2 applies the current resource's scopes at token issuance, and its docs recommend atomic replay detection in adapters. 9.11.4 brought "cimd: reject empty URL components" and exact comparison of registered redirects. — [oidc-provider releases](https://github.com/panva/node-oidc-provider/releases)
- Storage: the in-memory adapter is "suitable for development and testing purposes only", and "Production deployments MUST provide a custom adapter implementation". `upsert` "SHOULD use an atomic insert-if-absent operation". The interface lives in `/example/my_adapter.js`. — [oidc-provider docs](https://github.com/panva/node-oidc-provider/blob/main/docs/README.md)
- Mounting: `expressApp.use("/oidc", provider.callback())`. In Koa, `mount("/oidc", provider)`, since the provider is a Koa app. The Hapi and Nest examples call `callback(req, res)` directly, i.e. it is a Node req/res handler. — [oidc-provider docs](https://github.com/panva/node-oidc-provider/blob/main/docs/README.md)
- Login and consent: "implementations MUST provide these components", using `interactionDetails()` and `interactionFinished()`. `devInteractions` is on by default and accepts any username and password; "Production deployments MUST disable this feature". — [oidc-provider docs](https://github.com/panva/node-oidc-provider/blob/main/docs/README.md)
- Resource indicators are on by default. `getResourceServerInfo` "MUST be replaced by a deployment before use". Each resource server definition takes `scope`, `audience`, `accessTokenTTL` and `accessTokenFormat` (`'opaque' | 'jwt'`, RS256 by default). Rejections use `errors.InvalidTarget`. Registration is disabled by default, and `initialAccessToken: false` makes it open. — [oidc-provider docs](https://github.com/panva/node-oidc-provider/blob/main/docs/README.md)
- CIMD feature details: `allowFetch(ctx, clientId)` hook for domain allowlists, `allowClient(ctx, client)` hook, cache bounded to 30 s-86400 s, 5120-byte cap, 2500 ms timeout, and private and loopback IPs blocked. — [oidc-provider docs](https://raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md)
- Default lifetimes: access token 1 h, code 60 s, grant 14 d, session 14 d, refresh token 14 d. Refresh tokens from public, non-sender-constrained clients are always rotated. `loadExistingGrant` lets a request resolve without new user interaction, i.e. remembered consent. — [oidc-provider docs](https://raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md)
- `@hono/node-server` 2.1.5, as installed, exposes `HttpBindings` (`c.env.incoming`, `c.env.outgoing`) and `RESPONSE_ALREADY_SENT`. Together these let a Hono route hand the raw Node request and response to a Node handler. — `/Users/blackpr/code/mem/node_modules/@hono/node-server/dist/index.d.mts` (lines 38-43), `/Users/blackpr/code/mem/node_modules/@hono/node-server/dist/utils/response.d.mts`

### Inferences
- Bridge pattern: `app.all('/oidc/*', async (c) => { await runNodeHandler(provider.callback(), c.env.incoming, c.env.outgoing); return RESPONSE_ALREADY_SENT })`. No Hono body parser may run first on those routes. Test this; no official Hono example was found.
- Effort estimate (not sourced):
  - A generic Postgres adapter: one `oidc.payloads(id, kind, payload jsonb, grant_id, user_code, uid, expires_at, consumed_at)` table plus about 150 lines.
  - Two interaction pages, login and consent.
  - Config for `getResourceServerInfo` (map the `resource` URL onto a bank; refuse unknown banks with `InvalidTarget`; return `accessTokenFormat: 'jwt'`, `audience = resource`, and `scope: 'mem:read mem:write'`).
  - Enabling CIMD and DCR.
  - Total: more than better-auth, but none of the code is security-critical cryptography.
- Interop risk: MCP 2026-07-28 references CIMD draft-00, while `oidc-provider` implements draft-02. Check that the discovery document advertises `client_id_metadata_document_supported: true` and `none`, and test against Claude's and ChatGPT's real CIMD documents.
- Passkey or WebAuthn login is not included. It would need a separate library such as `@simplewebauthn/server` inside the interaction page; this was not researched.

### Gaps
- No public report was found of claude.ai or ChatGPT connecting to an `oidc-provider` AS through CIMD.
- Not confirmed: whether `oidc-provider` sets `client_id_metadata_document_supported` in its metadata automatically when the feature is on. That section of the docs was truncated.

## 4. Hosted authorization servers with MCP support

### Takeaway
WorkOS AuthKit, Clerk, Auth0 and Descope all now support CIMD as well as DCR. With any of them, mem shrinks to a pure resource server: it serves PRM, verifies JWTs against a JWKS with issuer and audience checks, and maps claims onto principals. WorkOS has the most generous free tier (first 1M MAU free). For one user every provider is free, so the real cost is an external sign-in dependency for a self-hosted memory system, plus vendor-specific claim and audience quirks. Cloudflare's library runs only on Workers and does not fit mem.

### Cited Findings
- **WorkOS AuthKit:**
  - Supports both DCR and CIMD. CIMD "is off by default", enabled under Connect → Configuration.
  - Tokens carry `aud` equal to the requested `resource`, provided resource indicators are registered in the Dashboard; otherwise `aud` falls back to the client ID.
  - The MCP server serves PRM with `authorization_servers: ['https://<authkit_domain>']` and verifies with `createRemoteJWKSet('https://<authkit_domain>/oauth2/jwks')` plus `jwtVerify({issuer, audience})`.
  - "Standalone" mode sends users to your own Login URI, so you keep your own login.
  - The page does not cover client revocation.

  — [WorkOS AuthKit MCP docs](https://workos.com/docs/authkit/mcp)
- WorkOS pricing: AuthKit's "First 1M MAUs" are free, a custom domain is $99/mo, and staging is free. The page does not price Connect, CIMD or DCR. — [WorkOS pricing](https://workos.com/pricing)
- WorkOS blog (2026-08-12) on open DCR's problems: client sprawl, "a public write endpoint that becomes an abuse target", credential churn, and no lifecycle policy in RFC 7591. — [WorkOS: MCP client identity, DCR vs CIMD](https://workos.com/blog/mcp-client-identity-dcr-cimd-auth-md)
- **Clerk:** CIMD has been GA for all applications since 2026-09-17 and is off by default. Admission controls let you allow clients by URL or restrict to pre-registered clients. Clerk's guide says to enable DCR only for clients that need it. — [Clerk changelog: CIMD GA](https://clerk.com/changelog/2026-09-17-client-id-metadata-documents-ga), [Clerk: Build an MCP server](https://clerk.com/docs/expressjs/guides/ai/mcp/build-mcp-server). The Hobby plan has a 50,000 MRU limit per app and includes a custom domain; the pricing page does not say whether OAuth apps, DCR or CIMD are on Hobby. — [Clerk pricing](https://clerk.com/pricing)
- **Auth0:**
  - Supports CIMD, both manual import and "dynamic CIMD registration", capped at 500 dynamic CIMD clients per tenant. The stage label for dynamic CIMD rendered empty, so it may be pre-GA.
  - The page does not mention DCR or RFC 8707.

  — [Auth0: CIMD overview](https://auth0.com/docs/get-started/auth0-overview/create-applications/cimd-overview)
  - Third-party table (verified 2026-07-31): Auth0 DCR "Yes" (enabled per tenant). Resource indicators "Partial": "if both `resource` and `audience` are sent, `audience` wins". — [Zuplo: MCP identity provider support](https://zuplo.com/learn/mcp/compatibility/identity-providers)
  - Free plan: up to 25,000 MAU, 1 custom domain (credit-card verification), passkeys, 1-day log retention, 1 tenant. — [Auth0 pricing](https://auth0.com/pricing)
- **Stytch:**
  - CIMD support was announced 2025-10-17 as part of Connected Apps and was labelled beta (stale). — [Stytch: CIMD support](https://stytch.com/blog/stytch-supports-cimd/)
  - Twilio's acquisition closed 2025-11-14; Twilio is now the parent company. — [Stytch changelog](https://stytch.com/docs/resources/changelog)
  - Free tier is about 10,000 MAU, but only third-party sources confirm it: an aggregator snapshot from May 2026 and a SuperTokens post from Aug 2025 (stale). — [xpay: Stytch](https://www.xpay.sh/agent-ready-index/stytch/), [SuperTokens: Stytch pricing](https://supertokens.com/blog/stytch-pricing)
- **Descope:**
  - Supports CIMD (recommended), DCR (as a fallback) and pre-registration.
  - DCR can be restricted with approved callback-URL patterns and approved scopes.
  - Pre-registered clients get no access until a policy links them to a Resource.

  — [Descope: Client registration methods](https://docs.descope.com/agentic-identity-hub/mcp-servers/registration-methods)
  - Free plan: 7,500 MAU and 2,000 "monthly active consents" (which cover inbound apps and MCP auth). The page contradicts itself on whether a custom domain is included. — [Descope pricing](https://www.descope.com/pricing)
- **Cloudflare `workers-oauth-provider`** (1.2.4, 2026-10-22; 1.9k stars):
  - An OAuth 2.1 library "running on Cloudflare Workers". It needs a KV namespace bound as `OAUTH_KV`, plus `global_fetch_strictly_public` for CIMD.
  - Supports DCR, CIMD (`clientIdMetadataDocumentEnabled`), RFC 8707 and RFC 9728.
  - Tokens are stored only as hashes.
  - The consent page is yours to build.
  - It "doesn't enforce" scopes.

  — [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider), [npm](https://www.npmjs.com/package/@cloudflare/workers-oauth-provider)

### Inferences
- With any hosted AS, mem's own code is the same small resource-server layer from question 1. The work is per-bank PRM, JWKS verification with `audience = https://<host>/v1/banks/{bankId}/mcp`, and claim mapping. Every vendor needs each per-bank URL registered as a resource or API: Auth0 "APIs", WorkOS "Resource Indicators", Descope "Resources". This is a manual or Admin-API step at bank creation.
- Lock-in and availability: when the vendor has an outage or changes policy, claude.ai and ChatGPT lose access to a server that is otherwise self-hosted, and identity data leaves the box. Moving vendors changes the issuer. Claude and ChatGPT re-register on their own when PRM changes, and CIMD client IDs carry over, but every grant has to be re-consented. For a "self-hosted, one npm package" project this cuts against the brief; for least code, it wins.
- Cloudflare's library is out unless the AS were split onto Workers, which would break "one repo, one npm package" in spirit. It is still a useful design reference: hashed tokens, a separate RS and AS, and scopes not enforced by the library.

### Gaps
- No primary source gave Stytch's current (2026) pricing or whether Connected Apps CIMD is still beta.
- No source said whether Auth0's free plan includes DCR or dynamic CIMD, or whether WorkOS bills Connect or MCP features separately.
- No source compared token-claim shapes across vendors (`client_id` vs `azp`, scope claim name). Each vendor's token reference would need reading.

## 5. Self-hosted identity servers (Keycloak, Authentik, Zitadel, Ory Hydra)

### Takeaway
None is a good fit for one person running one user. Keycloak is the only one with DCR plus CIMD plus RFC 8707, but CIMD and resource indicators are experimental feature flags, it explicitly does not support ChatGPT's CIMD, and it needs about 1.25 GB of RAM. Zitadel has DCR (open mode) but ignores `resource`, so `aud` never narrows to one bank. authentik has no DCR. Hydra has DCR but no resource indicators, and needs a separate login and consent app anyway.

### Cited Findings
- **Keycloak:**
  - Conforms to MCP 2025-03-26 ("Supported"); 2025-06-18, 2025-11-25 and 2026-07-28 are "Experimental".
  - DCR is supported, with anonymous-registration policies (Trusted Hosts, Allowed Registration Web Origins).
  - CIMD is experimental (`--features=cimd`), configured through client policies (`client-id-metadata-document` executor, `client-id-uri` condition, trusted domains).
  - RFC 8707 is experimental (`--features=resource-indicators`). Without it, `resource` is ignored and an Audience mapper is the workaround.
  - "Keycloak does not support ChatGPT's Client ID Metadata Document".
  - Versions on the docs selector: 26.6.4, 26.7.5, nightly 26.8.1.

  — [Keycloak: Integrating with MCP](https://www.keycloak.org/securing-apps/mcp-authz-server)
- Keycloak sizing: base memory per pod is 1250 MB, including realm caches and 10,000 sessions. 70% of the memory limit goes to heap, plus about 300 MB non-heap. — [Keycloak: Memory and CPU sizing](https://www.keycloak.org/high-availability/concepts-memory-and-cpu-sizing) (undated docs; possibly stale)
- Third-party claim, unverified: CIMD arrived in Keycloak 26.6.0, and 26.7.0 documented Claude Code. — [Skycloak blog](https://skycloak.io/blog/keycloak-cimd-mcp-authorization/)
- **Zitadel:**
  - Implements RFC 7591/7592 DCR. It is disabled by default, with a token-authenticated mode and an open mode (`allowUnauthenticated = true`, "Required for the MCP flow").
  - The `resource` parameter "is accepted on the authorization code flow but ignored, so it does not narrow `aud`". A JWT issued to one client in a project "carries every client ID registered in that project".
  - CIMD is not mentioned.
  - The docs version shown is v4.20.

  — [Zitadel: Dynamic client registration](https://zitadel.com/docs/guides/integrate/dynamic-client-registration)
  - Conflict: a third-party table (verified 2026-07-24) lists Zitadel DCR as "not implemented", so it is probably older than the docs. — [Zuplo: MCP identity provider support](https://zuplo.com/learn/mcp/compatibility/identity-providers)
  - Sizing: around 512 MB RAM and under one CPU core, per a search-result summary of Zitadel's production docs that was not opened directly. — [Zitadel help: minimum self-hosted specs](https://help.zitadel.com/what-are-zitadel-minimum-self-hosted-specs)
- **authentik:** no DCR and no resource indicators ("Not shipped"; implementation in review, tracking issue #8751, verified 2026-07-24). — [Zuplo: MCP identity provider support](https://zuplo.com/learn/mcp/compatibility/identity-providers). The official Compose baseline is about 2 CPU and 2 GB RAM, per a secondary vendor guide. — [ZimaSpace: authentik hardware requirements](https://shop.zimaspace.com/pages/authentik-hardware-requirements)
- **Ory Hydra:** DCR "Yes" (off by default), no resource indicators, and empty `client_uri`/`logo_uri` in registration responses that "can fail some clients" (verified 2026-07-24). — [Zuplo: MCP identity provider support](https://zuplo.com/learn/mcp/compatibility/identity-providers). Its last GitHub push was 2026-07-29, with 17.6k stars. — [ory/hydra](https://github.com/ory/hydra) (via `gh api`). On memory, a community answer says under 100 MB at about 30 ops/s; Ory publishes no official figure (old forum post, stale). — [Ory community](https://community.ory.sh/t/hydra-docker-memory-usage-performance/2325)
- Stars and activity on 2026-10-28: Keycloak 37.6k, authentik 26.2k, Zitadel 15.5k, Hydra 17.6k. — [keycloak/keycloak](https://github.com/keycloak/keycloak), [goauthentik/authentik](https://github.com/goauthentik/authentik), [zitadel/zitadel](https://github.com/zitadel/zitadel) (via `gh api`)

### Inferences
- Running a second stateful service (JVM or Go, plus its own schema or database, upgrades and backups) for a single user roughly doubles mem's operating surface. An embedded library (questions 2 and 3) gives the same standards coverage in-process.
- Zitadel's shared-audience behaviour violates the MCP rule that tokens be bound to their resource, unless mem checks `azp`/`client_id` itself. Keycloak's lack of support for ChatGPT's CIMD forces DCR for ChatGPT.

### Gaps
- No primary sources were found for authentik's or Hydra's CIMD status, or for Hydra's memory footprint.
- Pocket ID and similar small passkey-only OIDC providers were not researched.

## 6. Login and consent for a single user

### Takeaway
Use a passkey as the primary login, with a password+TOTP or recovery-code fallback that is set up once from the CLI, and turn sign-up off after the owner exists. Avoid magic links, which need email sending and have had flaws. Upstream "Sign in with GitHub/Google" also works if it is restricted to the owner's account ID, but it adds an external dependency. The consent page must name the client, show the redirect-URI host and the scopes, and say which bank is being granted. Remember consent per client.

### Cited Findings
- better-auth's passkey plugin is `@better-auth/passkey` (1.7.14). Registration requires an existing session by default (`registration.requireSession: true`). For passkey-first onboarding, set it to `false` and use `registration.resolveUser`. The page does not cover disabling sign-up. — [better-auth Passkey plugin](https://www.better-auth.com/docs/plugins/passkey), [npm @better-auth/passkey](https://www.npmjs.com/package/@better-auth/passkey)
- Example of risk in magic-link and OTP code paths: GHSA-qq9h-g4jm-xgf3, "Attacker's password keeps working after magic link or email OTP sign-in" (High, 2026-06-26), and GHSA-965c-763c-88jm, "OAuth state can be used as a Magic Link to sign in as another user" (Critical, 2026-09-30). — [better-auth security advisories](https://github.com/better-auth/better-auth/security/advisories)
- The MCP-level consent page **MUST**: name the requesting client; show the scopes; show the registered `redirect_uri`; use CSRF protection; and block framing with `frame-ancestors` or `X-Frame-Options: DENY`. Consent cookies **MUST** use the `__Host-` prefix, `Secure`, `HttpOnly` and `SameSite=Lax`, be signed, and be bound to the specific `client_id`. — [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- Authorization servers **MUST** clearly show the redirect-URI hostname, and **SHOULD** show extra warnings for redirect URIs that are only `localhost`. CIMD cannot stop localhost impersonation. — [MCP Security Considerations 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- Claude's docs repeat this: "On your consent screen, display the redirect URI's hostname clearly". — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- A better-auth advisory was about device login approval that "does not show the requesting client or permissions" (High, 2026-09-28). The consent screen's contents are therefore a security property, not decoration. — [better-auth security advisories](https://github.com/better-auth/better-auth/security/advisories)
- `oidc-provider`'s `loadExistingGrant` and better-auth's consent records both support remembered consent. better-auth's `skip_consent` is admin-only, for trusted clients. — [oidc-provider docs](https://raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md), [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider)

### Inferences
- Suggested flow:
  1. A `mem auth bootstrap` CLI command prints a one-time enrolment URL.
  2. The owner registers a passkey there, plus recovery codes.
  3. Sign-up is then disabled for good.
  4. At `/authorize`, an unauthenticated owner gets the passkey prompt.
  5. The consent page says, for example: "ChatGPT (chatgpt.com) wants **read and write** access to bank **personal** at https://mem.example.com/v1/banks/personal/mcp; it will redirect to chatgpt.com".
  6. Approving creates or updates mem's Principal and Grant (question 7).
- No erase or admin checkbox should ever appear on the OAuth consent page.
- Do not use `skip_consent` for claude.ai or ChatGPT. Per-client consent is cheap for one user and is the defence the spec mandates against confused-deputy and phishing.

### Gaps
- No source compared passkey UX on claude.ai's in-app browser or ChatGPT's OAuth pop-up. Passkeys inside embedded webviews on mobile may behave differently, and this should be tested.

## 7. Mapping OAuth identities onto mem's principals, grants and capabilities

### Takeaway
Create one mem Principal per connected OAuth client, keyed by issuer plus `client_id` (stable CIMD URLs make this clean), of kind `integration`. Give it a Grant on exactly the bank named by the token's audience. Derive its capabilities from the granted scopes (`mem:read`, `mem:write`; never `erase` or `admin`). Re-resolve the Scope from Postgres on every request, so revoking the grant takes effect at once even while a JWT is still valid. Keep API keys as a second credential type behind the same resolver.

### Cited Findings
- mem today: `governance.principals(id, tenant_id, kind CHECK IN ('human','agent','integration'), display_name)`, `governance.grants(principal_id, bank_id, capabilities text[], granted_at, expires_at, PK(principal_id, bank_id))` and `governance.api_keys(key_hash PK, principal_id, label, created_at, revoked_at)`. The REST layer resolves `deps.scopes.resolve(bearerToken(authorization), bankId)`. — `/Users/blackpr/code/mem/src/governance/infrastructure/postgres/migrations/0001_governance.sql`, `.../0002_api_keys.sql`, `/Users/blackpr/code/mem/src/attachment/rest/app.ts` (lines 69-87, 270)
- The token's audience must be the MCP server's canonical URI, which can include a path. The server must reject tokens whose audience is not itself. — [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/latest/basic/authorization), [MCP Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- The PRM `resource` must equal the URL the user enters, path included. — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- RFC 9068 JWT access tokens carry `iss`, `exp`, `aud`, `sub`, `client_id`, `iat` and `jti`, plus `scope`. — [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html). better-auth instead emits `azp` (no `client_id`) alongside `sub`, `aud`, `scope` and `sid`. — [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider). Zitadel's `aud` lists every client in the project, so validate `azp`/`client_id` there. — [Zitadel DCR](https://zitadel.com/docs/guides/integrate/dynamic-client-registration)
- CIMD client IDs are stable URLs: ChatGPT's is `https://chatgpt.com/oauth/client.json`, Claude Code's is `https://claude.ai/oauth/claude-code-client-metadata`. With DCR, Claude registers a new client on every fresh connection. — [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth), [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)
- Servers **MUST** account for scope hierarchies and **SHOULD** return 403 `insufficient_scope` with a `scope` value. Recommended practice: start with a minimal scope set and step up for privileged operations, and avoid wildcard or omnibus scopes. — [MCP Authorization 2026-07-28](https://modelcontextprotocol.io/specification/latest/basic/authorization), [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- Revocation building blocks: better-auth has `POST /oauth2/revoke` (a refresh-token revoke also deletes the access tokens it minted), `deleteOAuthConsent`, and client `disabled`, but JWT access tokens stay valid until they expire. — [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider). `oidc-provider` supports RFC 7009 revocation and grant-based revocation. — [panva/node-oidc-provider](https://github.com/panva/node-oidc-provider)
- Claude.ai's static-header auth is beta for a limited set of organisations and represents the organisation, not a person. Claude Code can use OAuth through its CIMD and a loopback redirect. — [Claude: Authentication for connectors](https://claude.com/docs/connectors/building/authentication)

### Inferences
- **Principal per client, created at consent time.** The id would be something like `oauth:<sha256(iss|client_id)>`, with `kind='integration'` and `display_name` taken from the CIMD `client_name` and host (e.g. "ChatGPT (chatgpt.com)"). Store `(iss, client_id) → principal_id` in a new `governance.oauth_clients` table, with `revoked_at` and evidence, mirroring `api_keys`. Audit rows then tell claude.ai, ChatGPT and Claude Code apart for free. Record the human `sub` in audit `details` as "on behalf of".
- **DCR churn.** If a client falls back to DCR (for example claude.ai against an AS that does not advertise `none`), each fresh connection yields a new `client_id`. That means either keying principals per DCR client and pruning, or grouping by `client_name` plus redirect host. Advertising CIMD properly (`client_id_metadata_document_supported: true` and `"none"`) avoids this for both claude.ai and ChatGPT.
- **Bank from audience.** The resource is `https://<host>/v1/banks/{bankId}/mcp`. On every MCP request:
  1. Verify the JWT, with `audience` set to the exact canonical URL of the bank in the route.
  2. Look up the principal from `(iss, client_id/azp)`.
  3. Load the Grant for `(principal, bankId)`.
  4. Intersect the token's scopes with the grant's capabilities.

  A token for bank A presented at bank B fails audience validation before any database read. One token per bank is the price; for one user with a handful of banks that is fine, and it matches MCP's "token bound to resource" model.
- **Scope to capability table.** `mem:read` → `read`; `mem:write` → `write` (implies `read`, per the scope-hierarchy rule). `admin` and `erase` are never requestable over OAuth: leave them out of `scopes_supported` and the AS's allowed scopes, and reject them if a token claims them. Put `scope="mem:read"` in the 401 challenge and step up to `mem:write` with 403 `insufficient_scope` on the first write. Alternatively offer both at once, which is less friction for one user.
- **Revoke one client.** Set `revoked_at` on its `oauth_clients` row, or delete its Grant: that is immediate, because the Scope is re-resolved per request. Then revoke its refresh tokens and consent at the AS so it cannot mint new access tokens. Keep access-token lifetimes short (5-15 min) as a backstop.
- **API keys alongside OAuth.** In the existing resolver, branch on token shape. A three-segment JWS goes to JWKS verification (issuer pinned, audience = this bank's URL); anything else goes to the sha256 lookup in `governance.api_keys`. Both produce the same `Scope`. Claude Code and scripts keep using static keys (Claude Code can send custom headers), and API-key principals can keep `admin`/`erase`. Unauthenticated or invalid requests still have to return 401 with `resource_metadata` so OAuth clients can discover the AS.

### Gaps
- No public "best practice" document was found for mapping OAuth clients to internal principal models in MCP servers. The mapping above is inference from the spec rules cited.
- Not confirmed: whether claude.ai reuses one token across all banks when the user adds several per-bank connectors. Each connector URL should get its own token, since `resource` differs, but this was not verified.

## 8. Security pitfalls for this setup

### Takeaway
The main risks:
- **Open DCR**: an unauthenticated write endpoint that causes client sprawl.
- **Loose redirect-URI matching**: anything short of exact matching, with loopback as the only exception.
- **CIMD fetching**: SSRF and DNS rebinding, plus localhost impersonation.
- **Missing audience checks**: accepting a token without checking `aud`, or passing it through to another service.
- **Refresh tokens**: not rotating them for public clients.
- **Token lifetimes**: long-lived JWT access tokens that cannot be revoked.

For mem specifically, there are three more: the path-aware PRM URL; libraries' early-2026 OAuth bugs, so pin and patch; and refusing to expose erase over OAuth.

### Cited Findings
- **Open DCR abuse.** WorkOS lists client sprawl, "a public write endpoint that becomes an abuse target", credential churn, and no lifecycle policy in RFC 7591. — [WorkOS blog (2026-08-12)](https://workos.com/blog/mcp-client-identity-dcr-cimd-auth-md). The MCP spec deprecates DCR. — [MCP Client Registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration). better-auth keeps DCR off unless two flags are set, and DCR clients get no resources unless they are allowlisted. — [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider). Descope can restrict DCR by approved callback-URL patterns. — [Descope](https://docs.descope.com/agentic-identity-hub/mcp-servers/registration-methods)
- **Redirect URIs.**
  - Authorization servers **MUST** match exact redirect URIs against registered values, and every redirect URI **MUST** be either `localhost` or HTTPS. — [MCP Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
  - Proxy servers **MUST** use "exact string matching (not pattern matching or wildcards)". — [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
  - Loopback is the exception: RFC 8252 §7.3 says ignore the port, and Claude Code needs this for both `localhost` and `127.0.0.1`. — [Claude: Authentication](https://claude.com/docs/connectors/building/authentication)
  - CVE-2026-67333 (stored XSS through a `javascript:` redirect_uri in better-auth's legacy plugins) shows what weak validation costs. — [Corgea](https://corgea.com/advisories/vulnerabilities/CVE-2026-67333)
- **Confused deputy.** This applies when an MCP server acts as an OAuth proxy with a static client ID to a third-party AS. Such servers **MUST** obtain per-client consent before forwarding, and the consent page must show the client, scopes and `redirect_uri`. — [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices). It matters to mem only if mem fronts an upstream IdP: the SDK's `ProxyOAuthServerProvider` or "Sign in with GitHub" behind mem's own AS. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.d.mts`
- **Token passthrough and audience.** Servers "**MUST NOT** accept any tokens that were not explicitly issued for the MCP server". — [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices). They **MUST** reject tokens that do not include them in `aud`. — [MCP Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations). In SDK v2, `@modelcontextprotocol/express` 2.0.1 silently ignored `expectedResource`. — [SDK v2 authorization](https://ts.sdk.modelcontextprotocol.io/v2/serving/authorization.html). better-auth 1.7.12 fixed `requireMcpAuth` accepting session JWTs that shared issuer and audience. — [better-auth releases](https://github.com/better-auth/better-auth/releases)
- **Refresh tokens and lifetimes.**
  - Authorization servers **SHOULD** issue short-lived access tokens and **MUST** rotate refresh tokens for public clients. — [MCP Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
  - Claude asks for `invalid_grant` on dead refresh tokens and for the new refresh token in the same response; refresh requests time out after 30 s. — [Claude: Authentication](https://claude.com/docs/connectors/building/authentication)
  - Defaults: better-auth access token 1 h and refresh token 30 d, with a new refresh token on every refresh. The `mcp()` reuse window is 30 s and the `oauthProvider` window 0. — [better-auth OAuth 2.1 Provider](https://www.better-auth.com/docs/plugins/oauth-provider), [better-auth MCP](https://www.better-auth.com/docs/plugins/mcp). `oidc-provider` uses access token 1 h and refresh token 14 d, always rotating for public clients. — [oidc-provider docs](https://raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md)
  - CVE-2026-53512, refresh-token replay through missing client authentication in better-auth's legacy plugins. — [Corgea](https://corgea.com/advisories/vulnerabilities/CVE-2026-53512)
- **CIMD fetching (SSRF).** Authorization servers fetching CIMD documents face SSRF. Block private, loopback and link-local ranges, use egress proxies, and beware DNS rebinding. Do not hand-roll IP validation. — [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices). better-auth's Node fetcher and `oidc-provider`'s CIMD fetcher both block private and loopback addresses, cap size and time out. — [better-auth CIMD](https://www.better-auth.com/docs/plugins/cimd), [oidc-provider docs](https://raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md)
- **Trust policies.** Authorization servers **MAY** allowlist CIMD domains. — [MCP Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations). better-auth has `isMetadataDocumentUrlAllowed`, `oidc-provider` has `allowFetch`/`allowClient`, and Clerk allows by URL. — [better-auth CIMD](https://www.better-auth.com/docs/plugins/cimd), [oidc-provider docs](https://raw.githubusercontent.com/panva/node-oidc-provider/main/docs/README.md), [Clerk changelog](https://clerk.com/changelog/2026-09-17-client-id-metadata-documents-ga)
- **Mix-up.** Authorization servers **SHOULD** emit `iss` (RFC 9207). ChatGPT uses its stable redirect URI only if `iss` is supported on every response. — [MCP Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [OpenAI Apps SDK: Authentication](https://developers.openai.com/apps-sdk/build/auth)
- **Path-aware discovery.** SDK defaults produce PRM that does not meet RFC 9728 for endpoints with a path; issue still open. — [typescript-sdk#2751](https://github.com/modelcontextprotocol/typescript-sdk/issues/2751). @hono/mcp's `bearerAuth` points `resource_metadata` at the root. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.mjs` (lines 385-388)
- **Weak primitives in installed code.** @hono/mcp 0.3.2 generates DCR secrets with `Math.random`, compares secrets with `!==`, and uses a global rate-limit key; fixed in 0.3.5. — `/Users/blackpr/code/mem/node_modules/@hono/mcp/dist/auth.mjs`, [@hono/mcp CHANGELOG](https://github.com/honojs/middleware/blob/main/packages/mcp/CHANGELOG.md)
- **Network.** Discovery and token calls to the AS come from Anthropic's egress range (`160.79.104.0/21`), so a WAF in front of the AS can break the flow. — [Claude: Authentication](https://claude.com/docs/connectors/building/authentication)

### Inferences
- mem-specific guardrails:
  1. Advertise CIMD and keep DCR off, or behind an allowlist of redirect hosts (`claude.ai`, `chatgpt.com`, loopback). This should suffice for claude.ai, ChatGPT and Claude Code.
  2. Allowlist CIMD hosts (`claude.ai`, `chatgpt.com`) through the library hook, since this is a single-user server.
  3. Access tokens: JWT, lifetime of 15 min or less, `aud` = per-bank URL, issuer pinned.
  4. Rotate refresh tokens. Keep refresh lifetimes at 30 days or less. Rely on per-request grant checks for revocation.
  5. Never pass the access token to the LLM extraction provider or any other downstream service.
  6. No `erase` or `admin` over OAuth.
  7. Put rate limits per IP and per client on `/authorize`, `/token` and the registration endpoint.
  8. Set CSP `frame-ancestors 'none'` on login and consent pages.
  9. Log every consent, token issuance and revocation into `governance.audit_log`.
- Single-user special case: since only the owner can ever consent, the per-client consent page plus passkey login is the decisive control. An attacker who registers a client still needs the owner to approve a consent page that shows the attacker's redirect host.

### Gaps
- No incident reports were found of DCR abuse against small self-hosted MCP servers specifically. The abuse claims come from vendor blogs and the spec.
- Neither the OAuth 2.1 draft text nor RFC 9700 was read directly. The requirements were taken as the MCP spec restates them.

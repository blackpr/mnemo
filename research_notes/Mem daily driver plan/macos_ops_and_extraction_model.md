# macOS daily-driver operations for `mem`, and the cheapest extraction model that keeps quality

Research date: 2026-10-28. All prices were seen on official pages on 2026-10-28 unless noted. Facts about this repository are cited to local files; everything else to a URL. Nothing was installed, run or bought.

## 1. Auto-start at login on macOS (Apple Silicon): which combination survives reboot and sleep best?

### Takeaway
The fewest moving parts come from native Postgres (Homebrew `postgresql@17` plus the `pgvector` bottle, started by `brew services`) and a user LaunchAgent that runs the Node server with an absolute nvm `node` path, `KeepAlive` and a wait-for-Postgres wrapper. With no Linux VM, there is no "Docker not ready yet" race. If the database stays in Docker, these are all required: "Start Docker Desktop when you sign in" (off by default), `restart: unless-stopped` on the `db` service (missing today), and a server that retries until port 5433 answers. Colima and OrbStack are lighter VM runtimes that work the same way.

### Cited Findings
**launchd / LaunchAgents**
- Per-user agents live in `~/Library/LaunchAgents`. `RunAtLoad` launches the job once when it is loaded. `KeepAlive` defaults to false ("only demand will start the job"). Set to true it "unconditionally" keeps the job alive. Its dictionary form has `SuccessfulExit`, `Crashed`, `PathState` and `OtherJobEnabled`, ORed together. `NetworkState` "is no longer implemented" — [launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)
- `WorkingDirectory` does a chdir before the job runs. `EnvironmentVariables` sets extra environment variables. `StandardOutPath` and `StandardErrorPath` map stdout and stderr to files. By default jobs are not spawned more than once every 10 seconds (`ThrottleInterval`) — [launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)
- A job launched by launchd must not daemonize: no `daemon(3)`, and no fork-then-parent-exit — [launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)
- Sleep behaviour matters for scheduled jobs. With `StartCalendarInterval`, "unlike cron… launchd will start the job the next time the computer wakes up". With `StartInterval`, an interval that falls during sleep "will be missed" — [launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)
- `launchctl bootstrap | bootout domain-target [service-path]` loads and removes services. `gui/<uid>/[service-name]` targets the user's login domain. `kickstart -k` kills a running instance and restarts it. `enable`/`disable` state "persists across boots". `print` shows status. `load`/`unload` are legacy, and the recommended replacements are `bootstrap | bootout | enable | disable` — [launchctl(1)](https://keith.github.io/xcode-man-pages/launchctl.1.html)
- A launchd job does not inherit the login shell's environment (no rc files, no user PATH), and launchd does not expand `~` or shell variables in a plist. Third-party guide — [StackHarbor](https://stackharbor.com/en/knowledge-base/openclaw-as-launchd-service/)
- Repo facts: `npm start` runs `node --env-file-if-exists=.env --import tsx src/attachment/rest/main.ts`; the server listens on 8787 and Postgres on host port 5433 — [/Users/blackpr/code/mem/package.json](file:///Users/blackpr/code/mem/package.json), [/Users/blackpr/code/mem/docker-compose.yml](file:///Users/blackpr/code/mem/docker-compose.yml)

**Homebrew services and native Postgres**
- `brew services start` "start[s] the service formula immediately and register[s] it to launch at login (or boot)". Without sudo it writes to `~/Library/LaunchAgents` (started at login); with sudo, `/Library/LaunchDaemons` (started at boot). `brew services run` runs without registering — [Homebrew manpage](https://docs.brew.sh/Manpage)
- `postgresql@17` is at 17.11 and keg-only. Its caveats are "Start now and at login: `brew services start postgresql@17`", data cluster at `$HOMEBREW_PREFIX/var/postgresql@17`. Deprecation date 2029-11-08, disable date 2030-11-08 — [formulae.brew.sh postgresql@17](https://formulae.brew.sh/formula/postgresql@17)
- `pgvector` is at 0.8.7 with bottles for Apple Silicon "golden gate", tahoe and sequoia. It builds from source against both `postgresql@17` and `postgresql@18` — [formulae.brew.sh pgvector](https://formulae.brew.sh/formula/pgvector)

**Docker Desktop**
- "Start Docker Desktop when you sign in to your computer" is **disabled by default** — [Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
- Containers and volumes live in the Linux VM disk image, set under Settings > Resources > Advanced > "Disk image location" ("where containers and images are stored") — [Docker Desktop settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/)
- Resource Saver (on by default) stops the VM after no containers have run for 5 minutes (default). Exiting it takes about 3–10 s on Mac — [Resource Saver](https://docs.docker.com/desktop/use-desktop/resource-saver/)
- Restart policies:
  - `unless-stopped` is like `always`, but a container that was stopped (manually or otherwise) stays stopped after a daemon restart.
  - A policy applies only after the container "is up for at least 10 seconds".
  - After a manual stop, the policy is ignored until the daemon or the container restarts.
  - The default is `no`.
  — [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
- Repo facts:
  - The `db` service in `docker-compose.yml` has **no `restart:` key**, so it uses the default `no`. Only the Honcho services set `unless-stopped`.
  - `npm run db:down` runs `docker compose down`, which removes containers. The named volume `mem-db-data` is kept.
  — [/Users/blackpr/code/mem/docker-compose.yml](file:///Users/blackpr/code/mem/docker-compose.yml), [/Users/blackpr/code/mem/package.json](file:///Users/blackpr/code/mem/package.json)
- Licensing: Docker Desktop is free for personal use, education, non-commercial open source and small businesses (<250 employees **and** <$10M revenue). Larger organisations, government and other commercial use need Pro, Team or Business. The page is undated — [Docker Desktop license](https://docs.docker.com/subscription/desktop-license/)

**Lighter runtimes**
- Colima, from its FAQ:
  - "the easiest way to autostart Colima is to use brew services": `brew services start colima`.
  - The Docker socket is at `$HOME/.colima/default/docker.sock`, and Colima makes itself the default docker context.
  - From v0.9.0 container data lives on a separate disk that survives `colima delete`; `colima delete --data` clears it.
  - The FAQ does not say whether restart-policy containers come back when Colima starts.
  — [Colima FAQ](https://github.com/abiosoft/colima/blob/main/docs/FAQ.md)
- A Colima setup guide advises stopping the brew service for the first manual `colima start`, so launchd is not supervising the VM during setup — [NJ innovation guide](https://newjersey.github.io/innovation-engineering/guides/development/colima/)
- OrbStack:
  - It is "Always free for personal use"; Pro is $8/user/month for business use — [OrbStack pricing](https://orbstack.dev/pricing)
  - The default memory cap is 8 GB — [OrbStack settings](https://docs.orbstack.dev/settings)
  - A v1.6.4 release note fixed the service "sometimes not auto-starting on login", so login start exists, but I found no settings documentation for it — [OrbStack release notes](https://docs.orbstack.dev/release-notes)

### Inferences
- **Recommended combination: native Postgres plus a LaunchAgent for Node.** Steps:
  1. `brew services start postgresql@17`, with pgvector from the bottle.
  2. Move the data once with `pg_dump -Fc` from `mem-db` and `pg_restore` into the Homebrew cluster. This doubles as the first restore test (section 2).
  3. Change `DATABASE_URL`, or set `port = 5433` in the Homebrew `postgresql.conf`. Homebrew's default port (5432) is not in the fetched pages.
  4. After a reboot, both come up at login as LaunchAgents, with no VM boot and no Docker readiness race.
  5. After sleep, processes resume and nothing restarts.
  6. Before restoring, check that the Homebrew pgvector version (0.8.7) is at least the version in the `pgvector/pgvector:pg17` image (`SELECT extversion FROM pg_extension WHERE extname='vector'`).
- **If Docker stays:**
  - Enable "Start Docker Desktop when you sign in". Put `restart: unless-stopped` on `db` (or `always`, which also brings back a container that was stopped by hand once the daemon restarts).
  - Never use `npm run db:down` (`docker compose down`) day to day: it deletes the container, so no restart policy can bring it back. `docker compose stop` keeps it.
  - The Node agent must tolerate Postgres arriving late: Docker Desktop at login plus VM boot plus Postgres recovery is slower than a LaunchAgent.
- **Colima and OrbStack:** the same rules apply. `brew services start colima` gives a login-time LaunchAgent. Docker's restart policies apply inside the VM's dockerd, so `unless-stopped` should bring `mem-db` back when Colima starts. This is inferred from Docker's semantics, not confirmed in the Colima docs.
- **Node LaunchAgent sketch** (not tested):
  - Label `dev.mem.server`.
  - `ProgramArguments`: `/bin/zsh -c 'until /opt/homebrew/opt/postgresql@17/bin/pg_isready -h 127.0.0.1 -p 5433 -q; do sleep 2; done; exec /Users/blackpr/.nvm/versions/node/v22.17.0/bin/node --env-file-if-exists=.env --import tsx src/attachment/rest/main.ts'`.
  - `WorkingDirectory` `/Users/blackpr/code/mem`.
  - `EnvironmentVariables` with `PATH=/Users/blackpr/.nvm/versions/node/v22.17.0/bin:/opt/homebrew/bin:/usr/bin:/bin`.
  - `RunAtLoad` true; `KeepAlive` true (or `{Crashed: true, SuccessfulExit: false}`); `ThrottleInterval` 10–30.
  - `StandardOutPath` and `StandardErrorPath` under `~/Library/Logs/mem/`.
  - Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.mem.server.plist`, restart with `launchctl kickstart -k gui/$(id -u)/dev.mem.server`.
  - Using `exec` keeps node as the launchd-managed process (no daemonizing).
  - The absolute nvm path breaks when Node is upgraded under nvm. Update the plist, or point it at a stable symlink.
  - The `/opt/homebrew` prefix is the Apple Silicon default; it is not in the fetched pages, so check it with `brew --prefix`.
- Docker Desktop's Resource Saver is not a concern while `mem-db` runs: it triggers only when no containers are running.

### Gaps
- No official source found on Docker Desktop or Colima VM clock drift, or network re-attach after sleep on Apple Silicon.
- No OrbStack documentation found for the start-at-login setting or for restart-policy behaviour when the engine starts.
- Not verified: macOS Ventura+ "Background Items Added" / Login Items listing for user LaunchAgents, and how the user approves them.
- Not verified from Postgres docs: client/server version rules if `pg_dump` runs from host Homebrew `libpq` against the container.

## 2. Backups: `pg_dump` on a schedule, an encrypted off-machine copy, retention, restore testing, and how backups fit an erasure promise

### Takeaway
Take a daily `pg_dump -Fc` from a launchd `StartCalendarInterval` job (it runs at wake if the Mac was asleep). Push it with restic (always encrypted, password-protected) to Backblaze B2 or Cloudflare R2 (a few GB fit the 10 GB free tiers) or a Hetzner Storage Box (€3.20/month for 1 TB). Keep a short, documented retention (for example 7 daily plus 4 weekly, `forget --prune`). Test the restore monthly into a scratch database, with row counts and the hash-chain check.

For erasure: the ICO lets backup copies persist until they are overwritten on an established schedule, as long as they are "beyond use" and the individual is told. The EDPB's 2025 enforcement report asks controllers to track erasures and re-apply them on any restored system. So `mem`'s receipt should name the backup expiry date, and the restore procedure should replay erasures.

### Cited Findings
**pg_dump / pg_restore**
- pg_dump "makes consistent backups even if the database is being used concurrently" and "does not block other users… (readers or writers)" — [pg_dump (PG 17)](https://www.postgresql.org/docs/17/app-pgdump.html)
- `-Fc` is a custom-format archive for `pg_restore`, "compressed by default", and allows selective and reordered restore. Parallel `-j` dumps work only with the directory format (`-Fd`) — [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
- pg_dump dumps one database only. Roles and tablespaces need `pg_dumpall` — [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
- `--no-owner` makes a restore that works for any user. `--clean --if-exists` drops objects before recreating them. All non-system extensions are dumped unless `-e` filters them — [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

**restic**
- A repository requires a password. "Losing your password means that your data is irrecoverably lost" — [restic: preparing a repo](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)
- For B2, "the recommended way… is by using its S3-compatible API", because of error-handling issues in the native B2 library. Other S3-compatible services such as R2 use the generic S3 URL plus `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. SFTP uses `sftp:user@host:/path` and needs passwordless (key) login for automation — [restic: preparing a repo](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)
- `forget` only removes snapshot records, and `prune` removes the data they alone referenced. `--prune` on `forget` runs prune automatically. `--keep-daily/weekly/monthly` keep the newest snapshot per calendar period. Prune locks the repo, and `--dry-run` previews — [restic: forget](https://restic.readthedocs.io/en/stable/060_forget.html)

**Storage prices for a few GB** (seen 2026-10-28)
- **Backblaze B2** (pay as you go) — [B2 pricing](https://www.backblaze.com/cloud-storage/pricing):
  - $6.95/TB/month; "First 10GB storage is always free".
  - Egress is free up to 3× average stored, then $0.01/GB.
  - Class A/B/C calls are free; no minimum storage duration.
  - The page shows no effective date and its footer reads "© 2024", so the price is **possibly stale**.
- **Cloudflare R2** (page last updated 2026-10-26) — [R2 pricing](https://developers.cloudflare.com/r2/pricing/):
  - Standard storage: $0.015/GB-month; Class A $4.50/M requests; Class B $0.36/M; no minimum duration.
  - Free tier: 10 GB-month, 1M Class A and 10M Class B per month.
  - Egress is free.
  - Infrequent Access: $0.01/GB-month with a 30-day minimum, and no free tier.
- **Hetzner Storage Box** — [Hetzner Storage Box](https://www.hetzner.com/storage/storage-box/):
  - BX11: 1 TB at €3.20/month excl. VAT, plus a one-time setup fee whose amount is not shown.
  - Protocols include SFTP, rsync, BorgBackup and Restic.
  - 10 manual and 10 automated snapshots; locations in Germany or Finland.
  - The page is undated.

**Erasure and backups**
- ICO right-to-erasure guidance — [ICO right to erasure](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/):
  - If a valid request has no exemption, you must take steps to erase from backups as well as live systems.
  - Data may "remain within the backup environment for a certain period of time until it is overwritten". "The key issue is to put the backup data 'beyond use'", held "until it is replaced in line with an established schedule".
  - "You must be absolutely clear with individuals as to what will happen to their data".
  - Respond "at the latest within one month".
  - The page notes it is under review because of the Data (Use and Access) Act.
- ICO storage-limitation guidance: if it is appropriate to delete from a live system, also "delete it from any back-up". Offline data is still processing. "The key issue is to ensure you put the data beyond use" — [ICO storage limitation](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/data-protection-principles/a-guide-to-the-data-protection-principles/storage-limitation/)
- ICO on processor contracts: delayed deletion from backups can be acceptable with safeguards such as putting the data immediately beyond use, if retention is appropriate and deletion follows as soon as possible. This is from a search summary of the page — [ICO contracts](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/contracts-and-liabilities-between-controllers-and-processors-multi/what-needs-to-be-included-in-the-contract/)
- EDPB CEF 2025 report on the right to erasure (adopted February 2026, about 8 months old), Issue 6, pp. 20–21 — [EDPB CEF 2025 report (PDF)](https://www.edpb.europa.eu/system/files/2026-02/edpb_cef-report_2025_right-to-erasure_en.pdf):
  - It may not be advisable to modify backups. In that case organisations "should have appropriate procedures to keep track of erasure requests and comply with them on restored systems".
  - Many controllers relied only on backup retention periods, or on overwrite cycles (for example one month). One SA found that long incremental deletion makes "without undue delay" hard to establish.
  - Recommendations: follow established standards for secure erasure, and "verify that erasure has been carried out and be able to demonstrate such erasure".
  - Practices seen: replacing deleted personal data with random strings; moving data to an inaccessible store and deleting it later.
  - The EDPB may issue further guidance on backups and on "without undue delay".
- Scope: the ICO says purely personal or household processing is outside the UK GDPR ("the UK GDPR doesn't apply, which is a bit different to an exemption"). A business run from home is not covered by this. Search summary of ICO pages — [ICO exemptions guide](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/exemptions/a-guide-to-the-data-protection-exemptions/), [ICO: who does the UK GDPR apply to](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/personal-information-what-is-it/who-does-the-uk-gdpr-apply-to/)

### Inferences
- **Daily backup job** (a LaunchAgent with `StartCalendarInterval`):
  1. `docker exec mem-db pg_dump -U mem -d mem -Fc > ~/Backups/mem/mem-YYYY-MM-DD.dump`. Do not pass `-t`, so no TTY mangles the binary stream. After moving to Homebrew Postgres, use `pg_dump -h 127.0.0.1 -p 5433 -U mem -Fc -f …` instead.
  2. Optionally `pg_dumpall --globals-only`. There is only the `mem` role, so this is optional.
  3. `restic backup ~/Backups/mem`.
  4. `restic forget --keep-daily 7 --keep-weekly 4 --prune`.
  5. A weekly `restic check`.
  6. On success, ping Healthchecks.io (section 3) so a missed backup alerts.
  - Store the restic password in the macOS Keychain. restic's `RESTIC_PASSWORD_COMMAND` exists but was not verified in the fetched pages.
  - Keep a second copy of the password off the Mac. Losing it loses every backup.
- **Cost for a few GB:** about $0 on B2 or R2 (within the 10 GB free tiers, with daily uploads far below the free operation quotas), versus €3.20/month flat for a Hetzner BX11.
- **Choosing a destination:** R2 has a dated, current pricing page. Hetzner's built-in snapshots would keep pruned data longer, which conflicts with a short erasure window unless snapshots are off or their retention is counted in the window.
- **Monthly restore test** (scriptable):
  1. `createdb mem_restore_check`.
  2. `pg_restore --no-owner --exit-on-error -d mem_restore_check <latest dump>`.
  3. Compare `count(*)` per table against the live database at dump time. Record the counts in a sidecar file at backup time.
  4. Run the hash-chained audit-log verification. The repo's admin CLI has paged chain verification and `verify-receipt` / `erasure-status` (see [/Users/blackpr/code/mem/STATUS.md](file:///Users/blackpr/code/mem/STATUS.md)).
  5. Re-verify one or two erasure receipts.
  6. Drop the scratch database.
  - Also store the audit chain head hash outside the database with each dump, so a restore can prove it is not a truncated or forked chain.
- **Erasure promise:** state the backup window in the receipt, for example "erased from the live store at T; encrypted backup copies containing it expire by T + 35 days (7 daily + 4 weekly, then pruned)". This follows the ICO's "be clear with the individual" and "established schedule".
- **Re-applying erasures after a restore:** keep an append-only erasure ledger outside the dumps (bank id, receipt id and hash, time; no personal content). Make "replay every erasure newer than the dump, then re-verify receipts" a required restore step before the server serves traffic. This is the EDPB's "comply with them on restored systems".
- **Crypto-shredding (stronger "beyond use"):** a per-bank data key kept outside the dumps, destroyed at erasure. This is a larger design change.
- **Legal position:** for a single-user personal system the UK GDPR probably does not apply (household scope). The receipt is a product claim, not a legal duty. If others ever use the system, the ICO and EDPB guidance above become the bar.

### Gaps
- B2's default bucket lifecycle (whether old file versions are kept after restic prunes) was not checked. If versions are kept, pruned data persists until a lifecycle rule removes it, which lengthens the erasure window.
- Not fetched: `pg_restore` docs for `--single-transaction` / `--exit-on-error` wording, and restic's `RESTIC_PASSWORD_COMMAND` docs.
- Kopia and Borg were not researched, beyond Hetzner listing BorgBackup support.
- The ICO's dedicated domestic-purposes guidance page did not come up; its position comes from search summaries of ICO pages.

## 3. Health checks: how a tool notices that memory is down, and how MCP clients show an unreachable server

### Takeaway
Use three layers:
- a local LaunchAgent watchdog that curls `/healthz` and raises a macOS notification;
- a Claude Code `SessionStart` hook that pings `/healthz` and warns the user (and Claude) at session start;
- a free external monitor (a Healthchecks.io dead-man's switch for the backup job; Better Stack or Uptime Kuma for the public URL that claude.ai and ChatGPT need).

Claude Code is not silent mid-session: it retries, then says the server disconnected. At startup it only marks the server as failed in `/mcp` or `claude mcp list`, with no notice. claude.ai shows "Couldn't reach the MCP server" at connect time and "Unexpected error while invoking tool" on failed calls. ChatGPT's behaviour is undocumented in what I found.

### Cited Findings
**Claude Code**
- `SessionStart` runs when a session starts or resumes; matchers are `startup`, `resume`, `clear`, `compact` and `fork`. Its plain-text stdout is "add[ed] as context that Claude can see and act on". `hookSpecificOutput.additionalContext` also adds context. It has no blocking control — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- For `SessionStart`, exit code 2 "shows stderr to user only", rendered as a hook error notice; "Claude doesn't see it" and the session continues. JSON `systemMessage` is the documented way to show users a warning, but the fetched excerpt did not confirm `SessionStart`'s handling of it. Command hooks default to a 600 s timeout, and the page says SessionStart hooks should be fast — [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- MCP status — [Claude Code MCP](https://code.claude.com/docs/en/mcp):
  - `claude mcp list` shows `✔ Connected` / `! Needs authentication` / `✘ Failed to connect` with detail; `/mcp` shows status.
  - A failed first HTTP/SSE connection (5xx, connection refused, timeout) is retried up to 3 times, then marked failed.
  - A dropped remote server is retried 5 times with exponential backoff from 1 s. Then the user sees `MCP server "<name>" disconnected · open /mcp to reconnect`.
  - `/mcp reconnect all` retries everything (v2.1.284+).
  - The startup notice covers servers needing authentication only.
  - In `claude -p` / Agent SDK, background retries last about half an hour.

**claude.ai**
- claude.ai connectors run on Anthropic's infrastructure and reach servers over the public internet. Hostnames resolving to private, loopback, CGNAT or IPv6-only addresses are rejected with "Couldn't reach", before any request leaves Anthropic's network — [claude.com connector troubleshooting](https://claude.com/docs/connectors/building/troubleshooting)
- "Works in Claude Code or curl but not claude.ai" usually means the server is not publicly routable. The fix is a public endpoint or tunnel — [claude.com connector troubleshooting](https://claude.com/docs/connectors/building/troubleshooting)
- When a connected tool call fails, users see "Unexpected error while invoking tool" followed by the tool name. Connection failures carry an `ofid_` reference ID — [claude.com connector troubleshooting](https://claude.com/docs/connectors/building/troubleshooting)

**ChatGPT**
- No official help page came up. Community threads report 424 / "TaskGroup" errors at connector creation even when the endpoint was never contacted, and tools that list but whose calls never reach the server. These are anecdotal — [OpenAI community: 424 TaskGroup](https://community.openai.com/t/mcp-connector-creation-fails-with-424-taskgroup-error-endpoint-never-contacted/1357635), [OpenAI community: resource not found](https://community.openai.com/t/mcp-connector-resource-not-found-tools-call-never-reaches-server/1370632)
- Third-party guides say ChatGPT needs a public HTTPS MCP server (a tunnel for local servers) and Developer Mode. They disagree on which plans have it — [gofastmcp ChatGPT](https://gofastmcp.com/v3/integrations/chatgpt), [Boomi guide](https://help.boomi.com/docs/Atomsphere/Platform/Connect_chatgpt_setup)

**Monitoring services**
- **Healthchecks.io** — [Healthchecks.io pricing](https://healthchecks.io/pricing/):
  - Hobbyist (free): 20 checks, 100 log entries per check.
  - Supporter: $5/month, same limits.
  - Business: $20/month (100 checks, SMS and phone credits).
- **Better Stack** (free): 10 monitors and heartbeats combined, 1 status page, Slack and email alerts. Free-tier check frequency is not stated — [Better Stack pricing](https://betterstack.com/pricing)
- **Uptime Kuma** (MIT, self-hosted) — [Uptime Kuma](https://github.com/louislam/uptime-kuma):
  - Monitor types: HTTP(s), keyword, JSON query, TCP, ping, DNS, Push and Docker container.
  - 20-second intervals and 90+ notification services.
  - Install: `docker run -d --restart=always -p 3001:3001 … louislam/uptime-kuma:2`.
- **macOS notifications:** `display notification "…" with title "…" subtitle "…" sound name "Frog"` (AppleScript, via `osascript -e`). The calling app is added to the notifying apps under Notifications settings — [Apple Mac Automation Scripting Guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)

### Inferences
- **Local watchdog:** a LaunchAgent with `StartInterval` 60. Missed runs while asleep are fine.
  - It runs `curl -fsS --max-time 2 http://127.0.0.1:8787/healthz` and on failure calls `osascript -e 'display notification …'`.
  - Add a state file so it notifies once per outage, not every minute.
  - This catches "server crashed while the Mac is awake". KeepAlive should already restart it, so the notification mainly flags crash loops and a database that is down.
- **Liveness vs readiness:** `/healthz` is liveness only. If it does not touch Postgres, a server whose database is down still looks healthy. A readiness check (`SELECT 1` plus an extraction-queue depth check) would make every layer above more useful. This is a design suggestion, not built.
- **Claude Code hook** (in `~/.claude/settings.json`, matcher `startup|resume`): `curl -fsS --max-time 2 http://127.0.0.1:8787/healthz >/dev/null || { echo "mem is DOWN: recall/retain will fail. Restart: launchctl kickstart -k gui/$(id -u)/dev.mem.server" >&2; exit 2; }`.
  - Exit 2 shows the warning to the user but not to Claude.
  - To make Claude aware too, print the message on stdout and exit 0. Stdout becomes context, so Claude can tell the user and skip `recall`.
  - The `--max-time 2` bound matters because the default hook timeout is 600 s.
- **Healthchecks.io fits scheduled jobs better than laptop liveness:** ping it at the end of a successful backup and restore test, with a grace period of about 1 day. A per-minute liveness ping from a laptop would alert every time the lid closes.
- **External uptime monitoring** (Better Stack free, or Uptime Kuma on another always-on machine) makes sense only for the public tunnel URL that claude.ai and ChatGPT use. There, "down because the Mac sleeps" is a true positive: those clients cannot reach memory either.
- **Uptime Kuma on the same Mac** dies with the Mac, so it adds little over the launchd watchdog.

### Gaps
- No official documentation found on what claude.ai shows mid-conversation when an already-connected connector becomes unreachable (versus a tool error), or whether the model is told.
- No official OpenAI page found on how ChatGPT surfaces an unreachable MCP app mid-chat.
- Not verified: how `systemMessage` is delivered for `SessionStart` (the fetched excerpt was truncated before that section).
- `terminal-notifier` was not researched; only `osascript` is sourced.
- Better Stack's free-tier check interval is not stated on the pricing page.

## 4. Extraction model: list prices, structured output and caching through the Vercel AI SDK, and public evidence on small extractors

### Takeaway
Seen on 2026-10-28, the cheapest current candidates are Claude Haiku 5.5 and OpenAI gpt-6-luna, both $0.10 in / $0.50 out per MTok, 40× below Opus 5.5 ($4 / $20). Next come Gemini 3.1 Flash-Lite ($0.25 / $1.50), Gemini 3.5 Flash-Lite ($0.30 / $2.50), gpt-5.4-mini ($0.75 / $4.50) and Gemini 3.8 Flash ($0.75 / $3.75 until 2026-12-31, doubling on 2027-01-01). Sonnet 5.5 is exactly half of Opus 5.5.

All three providers support JSON-schema structured output through the AI SDK, and `mem`'s client already resolves anthropic, google, openai and openai-compatible models. Caching differs: Anthropic needs explicit `cacheControl`; OpenAI caches automatically from 1,024 tokens; Gemini 3's implicit cache needs 4,096 tokens, so `mem`'s 1,700-token prefix would not be cached there.

Public evidence that small or mid models extract nearly as well as frontier ones is thin and mostly vendor-run. Hindsight reports a 20B open-weights extractor within 2.5–8 points of its best configuration.

### Cited Findings
**Anthropic** (seen 2026-10-28; page undated) — [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing). Per MTok: base input / 5-minute cache write / 1-hour cache write / cache read / output.

| Model | Input | 5m write | 1h write | Cache read | Output |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |
| Claude Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 | $10 |
| Claude Haiku 5.5, prompts ≤100k tokens | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| Claude Haiku 5.5, prompts >100k tokens | $0.50 | $0.625 | $1 | $0.05 | $2.50 |
| Claude Haiku 4.5 (for comparison) | $1 | — | — | — | $5 |

- Cache reads on Opus 5.5 and Sonnet 5.5 are priced at 0.05× base input; "all other models use the standard 0.1x".
- Haiku 5.5's prompt length counts cache reads and writes, and each request is priced on its own.
- Batch API: 50% off input and output. Opus 5.5 $2/$10, Sonnet 5.5 $1/$5, Haiku 5.5 (≤100k) $0.05/$0.25. Batch and caching discounts stack.
- `inference_geo: "us"` multiplies all categories by 1.1×.
- Opus 5.5 fast mode is $8/$40.

- Structured outputs (`output_config.format`) list `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` among supported models. Limits: `additionalProperties: false` is required; no numeric or string-length constraints; at most 24 optional parameters and 16 union-typed parameters across all strict schemas in a request. Compiled grammars are cached for 24 h. Changing `output_config.format` invalidates the prompt cache — [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

**Google Gemini** (paid Standard tier, page last updated 2026-10-27, seen 2026-10-28) — [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). Per MTok: input / output (including thinking) / context-cache price.

| Model | Input | Output | Cache | Notes |
| --- | --- | --- | --- | --- |
| `gemini-3.8-flash` | $0.75 | $3.75 | $0.075 | Through 2026-12-31; from 2027-01-01 $1.50 / $7.50 / $0.15. Cache storage $0.50/MTok-hour (→ $1.00). "our most intelligent Flash model" |
| `gemini-3.6-flash` | same as 3.8 Flash | | | "previous generation" |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | $0.03 | |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 | $0.025 | |
| `gemini-2.5-flash` | $0.30 | $2.50 | | |
| `gemini-2.5-flash-lite` | $0.10 | $0.40 | | |
| `gemini-3-flash-preview` | | | | Described as "legacy" |

- Batch is about 50% off; for example 3.8 Flash is $0.375/$1.875 through 2026-12-31.
- The free tier covers these Flash models; Batch is not available on the free tier.
- The top model is "Gemini 4 Argon" at $2/$10.

**OpenAI** (Standard tier, ≤272k context, seen 2026-10-28; page undated) — [OpenAI API pricing](https://developers.openai.com/api/docs/pricing). Per MTok: input / cached input / output.

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| gpt-6-luna | $0.10 | $0.01 | $0.50 |
| gpt-6.1-terra | $1.00 | $0.05 | $5.00 |
| gpt-6.1-sol | $2.00 | $0.10 | $10.00 |
| gpt-5.6-luna | $0.20 | $0.02 | $1.20 |
| gpt-5.6-sol | $4.00 | $0.40 | $20.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |
| gpt-5.4-nano | $0.20 | $0.02 | $1.25 |
| gpt-5-mini | $0.25 | $0.025 | $2.00 |
| gpt-5-nano | $0.05 | $0.005 | $0.40 |

- Batch and Flex are 50% off; for example gpt-5.4-mini is $0.375 / $0.0375 / $2.25.
- Regional-processing endpoints add 10% for models released on or after 2026-03-05.
- The page does not label "luna" as a small tier; that is my reading of the price.

**Caching and structured output through the AI SDK**
- OpenAI prompt caching is "enabled by default for supported OpenAI models". The minimum is 1,024 tokens for GPT-5.6 and later; in-memory retention is about 5–10 minutes; extended (`24h`) retention exists. For GPT-5.6+ cache writes are billed at a cache-write rate instead of an added fee. Usage reports `cached_tokens` and `cache_write_tokens` — [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- AI SDK OpenAI provider: structured outputs with `strictJsonSchema` (default true). "optional schema properties are not supported. You need to change Zod `.nullish()` and `.optional()` to `.nullable()`". `promptCacheKey` and `promptCacheRetention: '24h'` are available. `reasoningEffort` defaults to `medium` — [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
- AI SDK Google provider: `structuredOutputs` defaults to true, with "a subset of JSON Schema". Implicit caching needs 4,096 tokens minimum on Gemini 3 and 2,048 on Gemini 2.5; explicit caching is via `cachedContent`. Gemini 3 uses `thinkingLevel` (Gemini 3 Flash: minimal, low, medium, high) — [AI SDK Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai)
- Repo facts — [/Users/blackpr/code/mem/src/extraction/infrastructure/ai-sdk-llm-client.ts](file:///Users/blackpr/code/mem/src/extraction/infrastructure/ai-sdk-llm-client.ts), [/Users/blackpr/code/mem/eval/RESULTS.md](file:///Users/blackpr/code/mem/eval/RESULTS.md):
  - `mem`'s extractor uses `generateText` with `Output.object({schema})`. It resolves `anthropic`, `google`, `openai` and an OpenAI-compatible base URL.
  - Prompt caching (`providerOptions.anthropic.cacheControl`) is enabled only when the provider is anthropic.
  - The cached prefix measured 1,700 tokens: the system prompt plus the structured-output schema, rendered ahead of the system text.

**Public evidence on small vs frontier extractors**
- **Hindsight paper** (vendor-run; arXiv 2512.12818, December 2025, older than 6 months) — [Hindsight paper](https://arxiv.org/html/2512.12818v1):
  - GPT-OSS-20B for both extraction and answers: LongMemEval-S 83.6%, LoCoMo 83.18%.
  - GPT-OSS-120B: 89.0% and 85.67%.
  - Gemini-3 Pro answering over GPT-OSS-120B-extracted memory: 91.4% and 89.61%.
  - The judge is GPT-OSS-120B at temperature 0.
- **Mem0 paper** (vendor-run; April 2025, stale) — [Mem0 paper](https://ar5iv.labs.arxiv.org/html/2504.19413):
  - "All language model operations utilized GPT-4o-mini".
  - LoCoMo LLM-judge: Mem0 66.88%, Mem0g 68.44%, full context 72.90%, Zep 65.99%, OpenAI memory 52.90%.
- **Independent critique:** LoCoMo's answer key is about 6.4% wrong, and its judge accepts many deliberately wrong answers. Third party — [Penfield Labs audit](https://penfieldlabs.substack.com/p/we-audited-locomo-64-of-the-answer)
- **"Fidelity Before Structure"** (arXiv 2601.00821): with a gpt-4o answerer, verbatim chunks scored 43.9% vs 28.0% for LLM-extracted artifacts. This comes from a search summary; I did not read the full text — [arXiv 2601.00821](https://arxiv.org/pdf/2601.00821)
- **Eywa** (arXiv 2605.30771) reports Sonnet 4.6 90.19%, GPT-4o 88.77% and Kimi K2.5 84.09%, without separating the write model from the answer model. From a search summary; not verified — [arXiv 2605.30771](https://arxiv.org/pdf/2605.30771)
- **This repo's own data:** extraction with Opus 5.5 under extract-v3 scored 31/40 on the LoCoMo subset. Raw pgvector with no extraction scored 27/40, and full context 30/40 — [/Users/blackpr/code/mem/spike-results.md](file:///Users/blackpr/code/mem/spike-results.md)

### Inferences
- Haiku 5.5 is the obvious first candidate:
  - It is 40× cheaper than Opus 5.5 at the same token mix.
  - It is a same-provider swap, so the explicit cache, the structured-output path and the Claude-5 schema behaviour stay the same (the same schema limits apply to all three Claude 5.5 models).
  - Calls of about 12k tokens sit far below its 100k-token price step.
- gpt-6-luna has the same list price but would need the schema's `.optional()` fields changed to `.nullable()` for OpenAI strict mode, if the schema has any (not checked). It also needs `reasoningEffort` set explicitly, or output tokens may balloon at the `medium` default.
- On Gemini, the 1,700-token prefix is below the implicit-cache minimums, so all input is billed uncached. Explicit caching would add per-hour storage for a cache that saves about $0.01 per run, so it is not worth it here.
- The Hindsight numbers suggest that going from a 20B to a 120B open extractor (with the answerer scaled too) bought 2.5 points on LoCoMo and 5.4 on LongMemEval on the vendor's own judge. Extraction quality appears to plateau below frontier size, but this is vendor-run, on different models from 2025, and with a lenient LLM judge that our stricter grader does not match.

### Gaps
- No public LoCoMo or LongMemEval results found for Haiku 5.5, Sonnet 5.5, Gemini 3.x Flash or Flash-Lite, gpt-6-luna or gpt-5.4-mini as memory extractors.
- No independent (non-vendor) extractor-model ablation found.
- Not checked:
  - Haiku 5.5's minimum cacheable prompt length. The pricing page's per-model token table is tool-use overhead, not the cache minimum. The repo's code comment says 512 tokens on Opus 5.5.
  - Cache-write rates for gpt-6-luna.
  - Gemini 3.x Flash's default thinking level.
  - Whether `mem`'s zod schema uses `.optional()` (it matters for OpenAI strict mode).
  - Whether the Opus 5.5 run used extended or adaptive thinking (it changes the output-token baseline).
- The OpenAI and Anthropic pricing pages are undated. Gemini's page was updated 2026-10-27.

## 5. Cost of the 6.32 USD Opus 5.5 write run on each candidate, how to verify quality, and the daily cost for one heavy user

### Takeaway
At the same token mix, the arm-B write run would cost:

| Model | Run cost (USD) |
| --- | --- |
| Opus 5.5 | 6.32 |
| Sonnet 5.5 | 3.16 |
| Gemini 3.8 Flash | 1.32 (2.64 from 2027) |
| gpt-5.4-mini | 1.26 |
| Gemini 3.5 Flash-Lite | 0.62 |
| Gemini 3.1 Flash-Lite | 0.46 |
| gpt-5.4-nano | 0.34 |
| Haiku 5.5 | 0.16 |
| gpt-6-luna | 0.16 |

Rerunning arm B on the same 40 LoCoMo questions with the same frozen grader costs about 0.8–3.8 USD per candidate (write plus about 0.61 USD for answering and grading). Six candidates cost about 10 USD, or about 17 USD with a 2× buffer for reasoning tokens and retries. That run can only rule out large regressions: the paired MDD on this subset is 10–27 points (4–11 of 40 questions).

A heavy user at 50–200 retained statements a day costs about 2.8–11 USD/day on Opus 5.5, versus about 0.07–0.28 USD/day on Haiku 5.5 (conservative per-call mix).

### Cited Findings
- The measured extract-v3 token mix (114 calls, 88.7k corpus tokens) — [/Users/blackpr/code/mem/eval/RESULTS.md](file:///Users/blackpr/code/mem/eval/RESULTS.md):
  - Nominal input 1,325,729 tokens, of which 192,100 cache reads and 1,700 cache writes. Output 87,401.
  - Mean input per call 11,629; context at most about 6,400 of that.
  - Write cost 6.32 USD: uncached input 4.53 (72%), output 1.75 (28%).
  - Read cost 0.37 USD and grader 0.24 USD for 40 questions.
- Repricing that mix at Opus 5.5 list prices ($4 in, $5 cache write, $0.20 cache read, $20 out) reproduces 6.32 USD. Uncached input 4.528, output 1.748, cache 0.047. Prices from [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- MDD and power, from the CI tool `eval/stats/ci.ts` — [/Users/blackpr/code/mem/spike-results.md](file:///Users/blackpr/code/mem/spike-results.md):
  - The paired comparisons on this 40-question LoCoMo subset (4 conversation clusters) had MDDs at 80% power of 10.4 points (stage 2), 17.0 (B vs B-raw under v3) and 26.9 (C vs B under v3).
  - v2→v3 differed on 1 question of 40.
  - A run that could promote a 7.5-point edge to a finding needs about 150 questions over all 10 LoCoMo conversations.
- The extractor for arm B is chosen with `EVAL_B_EXTRACTOR`, and fresh banks with `EVAL_BANK_SUFFIX`. The v3 run used `--filter-providers B-pgvector` — [/Users/blackpr/code/mem/eval/arms/pgvector.ts](file:///Users/blackpr/code/mem/eval/arms/pgvector.ts), [/Users/blackpr/code/mem/eval/RESULTS.md](file:///Users/blackpr/code/mem/eval/RESULTS.md)
- Context budget: `EXTRACTION_CONTEXT_CHARS` 16,000, `EXTRACTION_CONTEXT_TURNS` 12, candidate facts cut at 3k by rank — [/Users/blackpr/code/mem/STATUS.md](file:///Users/blackpr/code/mem/STATUS.md)
- The prices used are in section 4: [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), [Gemini](https://ai.google.dev/gemini-api/docs/pricing), [OpenAI](https://developers.openai.com/api/docs/pricing). Caching minimums are from [AI SDK Google](https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai) and [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

### Inferences

**Assumptions.** These are my estimates:
- Each candidate sees the same token counts: 1,131,929 uncached input, 192,100 cache-read, 1,700 cache-write and 87,401 output tokens.
- Anthropic and OpenAI cache the 1,700-token prefix (OpenAI's minimum is 1,024).
- Gemini caches nothing, because the prefix is below its 4,096 (Gemini 3) and 2,048 (2.5) minimums, so all 1,325,729 input tokens are billed uncached.
- Output prices include thinking and reasoning tokens.

**Estimates at the same token mix:**

| Model | Write run (USD) | × Opus | Per call (USD) |
| --- | --- | --- | --- |
| Claude Opus 5.5 | 6.32 | 1.00 | 0.0555 |
| Claude Sonnet 5.5 | 3.16 | 0.50 | 0.0277 |
| Claude Haiku 5.5 | 0.16 | 0.025 | 0.0014 |
| Gemini 3.8 Flash (2026 price) | 1.32 | 0.21 | 0.0116 |
| Gemini 3.8 Flash (from 2027-01-01) | 2.64 | 0.42 | 0.0232 |
| Gemini 3.5 Flash-Lite | 0.62 | 0.10 | 0.0054 |
| Gemini 3.1 Flash-Lite | 0.46 | 0.07 | 0.0041 |
| Gemini 2.5 Flash-Lite (older GA) | 0.17 | 0.027 | 0.0015 |
| gpt-5.4-mini | 1.26 (1.39 uncached) | 0.20 | 0.0110 |
| gpt-5.4-nano / gpt-5.6-luna | 0.34 | 0.05 | 0.0030 |
| gpt-6-luna | 0.16 | 0.025 | 0.0014 |

**Caveats:**
1. **Cache ratios differ, but barely matter here.** Cache reads cost 0.05× input on Opus and Sonnet 5.5, 0.1× on Haiku 5.5, Gemini and most OpenAI models, and Gemini adds storage for explicit caches. Caching is only 0.7% of the Opus bill, so the difference moves totals by less than 2%.
2. **Tokenizers differ.** LoCoMo dialogue counted about 2.5 characters per token on the Anthropic ledger; other providers will count differently. This is not measured.
3. **Reasoning output.** gpt-5.x and gpt-6 models default to `reasoningEffort: medium` in the AI SDK, and Gemini 3 bills thinking as output. Output could be several times the Opus run's 767 tokens per call. Set the effort or thinking level to minimal or low, and read the ledger.
4. **Retries.** Schema-validation failures and retries add cost. The ledger keeps only the last attempt's usage (STATUS.md), so read the `llmAttempts` count.
5. **Batch.** The Batch API halves Anthropic and OpenAI prices, but facts would land hours later. That suits a bulk import, not live retain.

**Verification method (sketch).** Per candidate:
1. Run `EVAL_B_EXTRACTOR=<provider:model> EVAL_BANK_SUFFIX=<name> npm run eval:run -- --filter-providers B-pgvector -o eval/results/locomo-b-<name>.json`. Use the same 40 questions, seed, corpus, recall limit 10, Opus 5.5 answering model and frozen grader. The exact `provider:model` format of `EVAL_B_EXTRACTOR` should be checked in `eval/llm.js` / `ModelRef`.
2. Run `npm run eval:ci` for the paired difference against `locomo-b-v3.json` and its MDD.
3. Also compare:
   - per-question flips, especially the adversarial 8/8 abstentions and false specifics;
   - facts written, superseded and rejected counts from `extraction.runs` before the banks are erased;
   - schema-failure and retry counts;
   - output tokens per call.

**Decision rule.** Because the MDD is 4–11 questions, "within MDD" is weak evidence of equivalence. A stricter rule is: no more than 2 net questions lost against Opus v3's 31/40, no new adversarial failures, and no rise in false specifics. If a candidate passes, confirm it on the larger set.

**Spend for the 40-question check.** Each candidate costs its write plus about 0.61 USD (0.37 answering, 0.24 grading):

| Candidate | Spend (USD) |
| --- | --- |
| Haiku 5.5 | 0.77 |
| gpt-6-luna | 0.77 |
| Gemini 3.1 Flash-Lite | 1.07 |
| gpt-5.4-mini | 1.87 |
| Gemini 3.8 Flash | 1.93 |
| Sonnet 5.5 | 3.77 |

- All six: about 10.2 USD, or about 16.7 USD with the writes doubled for reasoning and retries.
- An optional Opus v3 control rerun to measure run-to-run noise adds 6.93 USD.

**Stronger confirmation for the winner.** About 150 questions over all 10 LoCoMo conversations:
- Assume the corpus scales about 2.5× from 4 to 10 conversations (not measured), and reads and grading scale with question count (about 2.29 USD per arm).
- That gives about 2.7 USD for Haiku 5.5 or gpt-6-luna, about 10 USD for Sonnet 5.5, and about 18 USD for the needed Opus 5.5 reference.
- The cheap arm is cheap; the Opus reference is the expensive part.

**Daily cost for one heavy user.** Assumptions:
- Each retained statement is one extraction call (triage would skip some).
- Each call has the LoCoMo-measured mix (11,629 input with 1,685 cached, 767 output). This is conservative: with extract-v3, per-call input is bounded by the 16,000-character context budget and the 3k candidate-facts cut, not by bank size.

| Model | 50 statements/day | 200/day | 200/day × 30 days |
| --- | --- | --- | --- |
| Opus 5.5 | 2.77 | 11.09 | 333 |
| Sonnet 5.5 | 1.39 | 5.55 | 166 |
| Gemini 3.8 Flash (2026) | 0.58 | 2.32 | 70 |
| gpt-5.4-mini | 0.55 | 2.21 | 66 |
| Gemini 3.1 Flash-Lite | 0.20 | 0.81 | 24 |
| Haiku 5.5 / gpt-6-luna | 0.07 | 0.28 | 8.4 |

All figures are USD.

Chat-turn episodes are much shorter than LoCoMo's session chunks: about 1,700 cached plus about 7,800 uncached input and about 400 output, which is my assumption. With that mix the figures drop to roughly 70% (Opus about 2.0–7.9 USD/day; Haiku 5.5 about 0.05–0.20 USD/day). A tighter `EXTRACTION_CONTEXT_CHARS` (for example 8,000) would cut about 2,500 tokens per call on session-sized episodes, according to the repo's offline estimate.

### Gaps
- The scale factor for the 150-question, 10-conversation run is assumed: only the 4 conversations used were measured (88.7k tokens).
- No measured token counts for any non-Anthropic tokenizer on this corpus.
- No measured reasoning-token overhead for gpt-5.x/gpt-6 or Gemini 3 at minimal or low effort.
- Whether `EVAL_B_EXTRACTOR` accepts `google:` / `openai:` model refs, and whether the arm needs the matching API keys in `.env`, was not checked beyond the header comment.
- The grader and answering model stay Opus 5.5, so the 0.61 USD per arm assumes the same read path and question count as the v3 run.

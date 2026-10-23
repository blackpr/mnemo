import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { asBankId, asPrincipalId, asSubjectId, asTenantId, systemClock, type BankId, type Capability, type Scope } from "../shared-kernel/index.js";
import { createPool } from "../platform/postgres/pool.js";
import { migrate } from "../platform/postgres/migrator.js";
import { migrationSources } from "../platform/postgres/migrations.js";
import { randomUUID } from "node:crypto";
import { AbandonErasureHandler, EraseBankHandler, type ErasureRequest, generateApiKey, hashApiKey, PgApiKeyStore, PgAuditLog, PgErasureRequestRepository, PgErasureUnitOfWork, PgPrincipalRepository, resolveScope, scopeAccessPolicy, type Grant } from "../governance/index.js";
import { sha256 } from "../platform/hash.js";
import { createBank, PgBankRepository, PgEpisodeRepository, PgFactRepository, PgMemoryErasure, PgOutboxRelay, PgUnitOfWork, RecordEpisodeHandler } from "../memory/index.js";
import { EXPORT_FORMATS, ExportBankHandler, ExportsErasableStore, ImportDocumentsHandler, PgExportStore, readClaudeCodeMemory, type ExportFormat } from "../portability/index.js";
import { ExtractionErasableStore, parseModelSpec, PgExtractionRunStore } from "../extraction/index.js";
import { embedderFromEnv, EngineErasableStore, PgvectorEngine, type Embedder } from "../retrieval/index.js";

/**
 * Bootstrap CLI. Creates the records the REST attachment needs before a first request:
 *
 *   npm run admin -- create-bank --id bank-vangelis --tenant t1 --subject vangelis
 *   npm run admin -- create-principal --id claude-code --tenant t1 --kind agent --name "Claude Code"
 *   npm run admin -- grant --principal claude-code --bank bank-vangelis --caps read,write
 *   npm run admin -- issue-key --principal claude-code --label laptop
 *   npm run admin -- revoke-key --key mem_...
 *   npm run admin -- requeue-dead-letters
 *   npm run admin -- set-extractor --bank bank-vangelis --model anthropic:claude-opus-5-5
 *   npm run admin -- clear-extractor --bank bank-vangelis
 *   npm run admin -- extraction-status
 *   npm run admin -- requeue-extraction
 *   npm run admin -- reindex --bank bank-vangelis        # after changing EMBEDDER
 *   npm run admin -- export --bank bank-vangelis --out exports/bank-vangelis.jsonl [--format jsonl|markdown]
 *   npm run admin -- import-claude-code --bank bank-vangelis --dir ~/.claude/projects/<project>/memory
 *   npm run admin -- render-import --bank bank-vangelis --target claude|gemini [--out <path>]
 *   npm run admin -- erase-bank --bank bank-vangelis --principal vangelis --yes   # principal needs the erase capability
 *   npm run admin -- erasure-status --id <request id>
 *   npm run admin -- erasure-abandon --id <request id> --reason "worker died mid-purge" [--force]   # unblock a stuck request
 *
 * Portability commands act as the internal principal "system:admin" (admin capability on the
 * bank); exports are recorded in portability.exports and audited like any other read.
 * Erasure is different: it acts as a named principal that must hold `erase` (or `admin`) on the
 * bank, so the audit chain records who asked, and the CLI cannot bypass the policy the REST
 * attachment applies. It is synchronous and irreversible (hence --yes); the receipt digest is printed at
 * the end. `erasure-abandon` is the recovery path for a request left non-terminal by a crash: it marks it
 * failed (as "system:admin", audited) so the bank can be erased again; it deletes nothing, and refuses a
 * request whose row changed in the last 10 minutes (presumed still running) unless --force is given.
 *
 * The API key is printed once and never stored in plaintext. Every command refuses to silently
 * change existing state: create-* fail if the id exists, grants require matching tenants.
 */

const CAPABILITIES: readonly Capability[] = ["read", "write", "admin", "erase"];
const KINDS = ["human", "agent", "integration"] as const;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (see .env.example)");
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    id: { type: "string" },
    tenant: { type: "string" },
    subject: { type: "string" },
    kind: { type: "string" },
    name: { type: "string" },
    principal: { type: "string" },
    bank: { type: "string" },
    caps: { type: "string" },
    label: { type: "string" },
    key: { type: "string" },
    model: { type: "string" },
    version: { type: "string" },
    out: { type: "string" },
    dir: { type: "string" },
    format: { type: "string" },
    target: { type: "string" },
    reason: { type: "string" },
    yes: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const need = (k: keyof typeof values): string => {
  const v = values[k];
  return typeof v === "string" ? v : die(`--${k} is required`);
};

/** Erasure never embeds (count and delete by bank id), so it must not depend on the embedding provider's credentials being in the shell. */
const noEmbedder: Embedder = {
  id: "none",
  dimensions: undefined,
  embed: async () => {
    throw new Error("erasure does not embed");
  },
};

const adminScope = (bankId: BankId, tenantId: Scope["tenantId"]): Scope => ({ tenantId, bankId, principalId: asPrincipalId("system:admin"), capabilities: new Set<Capability>(["admin"]) });

const pool = createPool(url, 2);
try {
  await migrate(pool, migrationSources);
  const banks = new PgBankRepository(pool);
  const principals = new PgPrincipalRepository(pool);
  const keys = new PgApiKeyStore(pool);

  switch (command) {
    case "create-bank": {
      const id = asBankId(need("id"));
      if (await banks.get(id)) die(`bank ${id} already exists; refusing to modify it`);
      const bank = createBank(id, asTenantId(need("tenant")), asSubjectId(need("subject")), new Date());
      await banks.create(bank);
      console.log(`bank ${bank.id} created for subject ${bank.subjectId} in tenant ${bank.tenantId}`);
      break;
    }
    case "create-principal": {
      const id = asPrincipalId(need("id"));
      if (await principals.get(id)) die(`principal ${id} already exists`);
      const kind = values.kind ?? "agent";
      if (!(KINDS as readonly string[]).includes(kind)) die(`--kind must be one of ${KINDS.join(", ")}`);
      await principals.save({ id, tenantId: asTenantId(need("tenant")), kind: kind as (typeof KINDS)[number], displayName: values.name ?? id, grants: [] });
      console.log(`principal ${id} created`);
      break;
    }
    case "grant": {
      const id = asPrincipalId(need("principal"));
      const principal = (await principals.get(id)) ?? die(`principal ${id} not found`);
      const bankId = asBankId(need("bank"));
      const bank = (await banks.get(bankId)) ?? die(`bank ${bankId} not found`);
      if (bank.tenantId !== principal.tenantId) die(`tenant mismatch: principal is in ${principal.tenantId}, bank is in ${bank.tenantId}`);
      const caps = need("caps").split(",").map((s) => s.trim());
      const bad = caps.filter((c) => !(CAPABILITIES as readonly string[]).includes(c));
      if (bad.length > 0) die(`unknown capabilities: ${bad.join(", ")} (valid: ${CAPABILITIES.join(", ")})`);
      const grant: Grant = { bankId, capabilities: new Set(caps as Capability[]), grantedAt: new Date() };
      await principals.save({ ...principal, grants: [...principal.grants.filter((g) => g.bankId !== bankId), grant] });
      console.log(`granted ${caps.join(",")} on ${bankId} to ${id}`);
      break;
    }
    case "issue-key": {
      const id = asPrincipalId(need("principal"));
      if (!(await principals.get(id))) die(`principal ${id} not found`);
      const key = generateApiKey();
      await keys.issue(id, key.hash, values.label ?? "default");
      console.log(`API key for ${id} (shown once):\n${key.token}`);
      break;
    }
    case "revoke-key": {
      const revoked = await keys.revoke(hashApiKey(need("key")));
      console.log(revoked ? "key revoked" : "no active key matched");
      break;
    }
    case "set-extractor": {
      const bankId = asBankId(need("bank"));
      const bank = (await banks.get(bankId)) ?? die(`bank ${bankId} not found`);
      const extractor = (() => {
        try {
          return parseModelSpec(need("model"), values.version ?? "v1");
        } catch (e) {
          return die(e instanceof Error ? e.message : String(e));
        }
      })();
      await banks.update({ ...bank, policy: { ...bank.policy, extractor } });
      console.log(`bank ${bankId} will extract with ${extractor.provider}:${extractor.model} (${extractor.version}); new episodes only`);
      break;
    }
    case "clear-extractor": {
      const bankId = asBankId(need("bank"));
      const bank = (await banks.get(bankId)) ?? die(`bank ${bankId} not found`);
      const { extractor: _drop, ...policy } = bank.policy;
      await banks.update({ ...bank, policy });
      console.log(`bank ${bankId} extraction disabled; existing facts untouched`);
      break;
    }
    case "reindex": {
      const bankId = asBankId(need("bank"));
      const bank = (await banks.get(bankId)) ?? die(`bank ${bankId} not found`);
      const engine = new PgvectorEngine(pool, embedderFromEnv());
      const scope = { tenantId: bank.tenantId, bankId, principalId: asPrincipalId("system:admin"), capabilities: new Set<Capability>(["admin"]) };
      const facts = await new PgFactRepository(pool).listAll(scope);
      const episodes = await new PgEpisodeRepository(pool).listByBank(scope, { limit: 1_000_000 });
      const started = Date.now();
      await engine.rebuild(bankId, iterate(facts), iterate(episodes));
      console.log(`reindexed ${bankId} with ${engine.embedderId}: ${facts.length} facts, ${episodes.length} episodes in ${Date.now() - started} ms`);
      const remaining = await engine.staleRowCount(bankId);
      if (remaining > 0) console.warn(`${remaining} row(s) from another embedder appeared during the rebuild: a server with a different EMBEDDER is still writing. Restart it with the same .env.`);
      else console.log("if the server was started with a different EMBEDDER, restart it so recall uses this index");
      break;
    }
    case "export":
    case "render-import": {
      const bankId = asBankId(need("bank"));
      const bank = (await banks.get(bankId)) ?? die(`bank ${bankId} not found`);
      const format: ExportFormat = (() => {
        if (command === "render-import") {
          const target = need("target");
          if (target === "claude") return "claude-paste";
          if (target === "gemini") return "gemini-paste";
          return die("--target must be claude or gemini");
        }
        const f = values.format ?? "jsonl";
        if (f !== "jsonl" && f !== "markdown") return die(`--format must be jsonl or markdown (all formats: ${EXPORT_FORMATS.join(", ")})`);
        return f;
      })();
      const handler = new ExportBankHandler(banks, new PgFactRepository(pool), scopeAccessPolicy, new PgExportStore(pool), new PgAuditLog(pool), systemClock);
      const r = await handler.handle(adminScope(bankId, bank.tenantId), { bankId, format });
      const produced = r.ok ? r.value : die(`export failed: ${r.error.kind}`);
      const out = command === "export" ? need("out") : values.out;
      if (out !== undefined) {
        const path = resolve(out);
        await mkdir(dirname(path), { recursive: true });
        try {
          await writeFile(path, produced.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        } catch (e) {
          if ((e as { code?: string }).code === "EEXIST") die(`${path} already exists; refusing to overwrite it`);
          throw e;
        }
        console.error(`wrote ${format} export ${produced.exportId} of ${bankId} to ${path}: ${produced.factCount} fact(s), ${produced.tombstoneCount} tombstone(s)`);
      } else {
        process.stdout.write(produced.content);
        console.error(`export ${produced.exportId} of ${bankId} (${format}): ${produced.factCount} fact(s) considered`);
      }
      break;
    }
    case "import-claude-code": {
      const bankId = asBankId(need("bank"));
      const bank = (await banks.get(bankId)) ?? die(`bank ${bankId} not found`);
      const dir = resolve(need("dir"));
      const docs = await readClaudeCodeMemory(dir);
      if (docs.length === 0) die(`no memory files found under ${dir} (looking for memory/*.md, MEMORY.md, CLAUDE.md, CLAUDE.local.md)`);
      const handler = new ImportDocumentsHandler(new RecordEpisodeHandler(new PgUnitOfWork(pool), scopeAccessPolicy, systemClock));
      const r = await handler.handle(adminScope(bankId, bank.tenantId), bankId, docs);
      const outcome = r.ok ? r.value : die(`import stopped at ${r.error.path}: ${r.error.kind}`);
      for (const i of outcome.imported) console.log(`imported ${i.path} -> episode ${i.episodeId}`);
      for (const k of outcome.skipped) console.log(`skipped  ${k.path} (unchanged)`);
      console.log(`${outcome.imported.length} imported, ${outcome.skipped.length} unchanged, from ${docs.length} file(s); extraction runs on the server for banks with an extractor`);
      break;
    }
    case "erase-bank": {
      const bankId = asBankId(need("bank"));
      const bank = (await banks.get(bankId)) ?? die(`bank ${bankId} not found`);
      const principalId = asPrincipalId(need("principal"));
      const principal = (await principals.get(principalId)) ?? die(`principal ${principalId} not found`);
      const scope = resolveScope(principal, bankId, new Date()) ?? die(`principal ${principalId} has no live grant on ${bankId}`);
      if (!values.yes) die(`erase-bank deletes every fact, episode, index row, extraction run and export record of ${bankId} (subject ${bank.subjectId}) and cannot be undone; re-run with --yes`);
      const memoryErasure = new PgMemoryErasure(pool);
      const handler = new EraseBankHandler(
        scopeAccessPolicy,
        memoryErasure,
        new PgErasureUnitOfWork(pool),
        // Memory first: see ErasableStore.
        [memoryErasure, new EngineErasableStore(new PgvectorEngine(pool, noEmbedder)), new ExtractionErasableStore(new PgExtractionRunStore(pool)), new ExportsErasableStore(new PgExportStore(pool))],
        systemClock,
        randomUUID,
        sha256,
      );
      console.error(`erasing bank ${bankId} (subject ${bank.subjectId}) as ${principalId}`);
      const r = await handler.handle(scope, bankId);
      const request = r.ok ? r.value : die(`erasure refused: ${r.error.kind}`);
      printErasure(request);
      if (request.state !== "receipted") process.exitCode = 1;
      break;
    }
    case "erasure-status": {
      const request = (await new PgErasureRequestRepository(pool).get(need("id"))) ?? die(`erasure request ${values.id} not found`);
      printErasure(request);
      break;
    }
    case "erasure-abandon": {
      const requests = new PgErasureRequestRepository(pool);
      const request = (await requests.get(need("id"))) ?? die(`erasure request ${values.id} not found`);
      const handler = new AbandonErasureHandler(scopeAccessPolicy, requests, new PgErasureUnitOfWork(pool), systemClock);
      const r = await handler.handle(adminScope(request.bankId, request.tenantId), request.bankId, request.id, need("reason"), { force: values.force === true });
      if (!r.ok) {
        if (r.error.kind === "ErasureTerminal") die(`request is already ${r.error.state}; nothing to abandon`);
        if (r.error.kind === "ErasureStillRunning") die(`request changed at ${r.error.updatedAt.toISOString()}, less than ${r.error.staleAfterMs / 60_000} min ago: it may still be running. Re-run with --force only if you are sure its process is gone`);
        die(`abandon refused: ${r.error.kind}`);
      } else printErasure(r.value);
      const status = (await banks.get(request.bankId))?.status ?? "missing";
      console.log(`bank ${request.bankId} is ${status}${status === "active" ? "" : "; run erase-bank again to finish the job"}`);
      break;
    }
    case "extraction-status": {
      console.log(JSON.stringify(await new PgExtractionRunStore(pool).counts()));
      break;
    }
    case "requeue-extraction": {
      const n = await new PgExtractionRunStore(pool).requeueFailed();
      console.log(`${n} failed/dead extraction run(s) requeued`);
      break;
    }
    case "requeue-dead-letters": {
      const relay = new PgOutboxRelay(pool);
      const n = await relay.requeueDeadLetters();
      console.log(`${n} dead-lettered event(s) requeued`);
      break;
    }
    default:
      die("usage: admin <create-bank|create-principal|grant|issue-key|revoke-key|set-extractor|clear-extractor|reindex|export|import-claude-code|render-import|erase-bank|erasure-status|erasure-abandon|extraction-status|requeue-extraction|requeue-dead-letters> [options]");
  }
} finally {
  await pool.end();
}

async function* iterate<T>(items: readonly T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

function printErasure(r: ErasureRequest): void {
  console.log(`erasure ${r.id} for bank ${r.bankId}: ${r.state} (requested by ${r.requestedBy} at ${r.requestedAt.toISOString()})`);
  for (const i of r.inventory) {
    const deleted = r.deletions.find((d) => d.store === i.store)?.deleted;
    const after = r.verifications.find((v) => v.store === i.store)?.hitsAfter;
    console.log(`  ${i.store.padEnd(22)} before ${i.countBefore}  deleted ${deleted ?? "-"}  after ${after ?? "-"}`);
  }
  if (r.receipt) console.log(`  receipt ${r.receipt.digest} issued at ${r.receipt.issuedAt.toISOString()} (verify with verifyReceipt over the stored request)`);
  if (r.failure) console.log(`  failure: ${r.failure}`);
}

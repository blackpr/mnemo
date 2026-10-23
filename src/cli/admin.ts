import { parseArgs } from "node:util";
import { asBankId, asPrincipalId, asSubjectId, asTenantId, type Capability } from "../shared-kernel/index.js";
import { createPool } from "../platform/postgres/pool.js";
import { migrate } from "../platform/postgres/migrator.js";
import { migrationSources } from "../platform/postgres/migrations.js";
import { generateApiKey, hashApiKey, PgApiKeyStore, PgPrincipalRepository, type Grant } from "../governance/index.js";
import { createBank, PgBankRepository, PgOutboxRelay } from "../memory/index.js";

/**
 * Bootstrap CLI. Creates the records the REST attachment needs before a first request:
 *
 *   npm run admin -- create-bank --id bank-vangelis --tenant t1 --subject vangelis
 *   npm run admin -- create-principal --id claude-code --tenant t1 --kind agent --name "Claude Code"
 *   npm run admin -- grant --principal claude-code --bank bank-vangelis --caps read,write
 *   npm run admin -- issue-key --principal claude-code --label laptop
 *   npm run admin -- revoke-key --key mem_...
 *   npm run admin -- requeue-dead-letters
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
  },
});

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const need = (k: keyof typeof values): string => values[k] ?? die(`--${k} is required`);

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
    case "requeue-dead-letters": {
      const relay = new PgOutboxRelay(pool);
      const n = await relay.requeueDeadLetters();
      console.log(`${n} dead-lettered event(s) requeued`);
      break;
    }
    default:
      die("usage: admin <create-bank|create-principal|grant|issue-key|revoke-key|requeue-dead-letters> [options]");
  }
} finally {
  await pool.end();
}

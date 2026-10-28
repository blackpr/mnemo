import { createHash } from "node:crypto";
import pg from "pg";
import type { BankId, Capability, PrincipalId, TenantId } from "../../../shared-kernel/index.js";
import type { Queryable } from "../../../platform/postgres/pool.js";
import { withTransaction } from "../../../platform/postgres/pool.js";
import { appendEntry, type AuditEntry } from "../../domain/audit-log.js";
import type { Grant, Principal, PrincipalKind } from "../../domain/principal.js";
import type { ApiKeyStore, AuditLogStore, NewAuditEntry, PrincipalRepository } from "../../ports/repositories.js";

interface PrincipalRow {
  id: string;
  tenant_id: string;
  kind: PrincipalKind;
  display_name: string;
}
interface GrantRow {
  bank_id: string;
  capabilities: Capability[];
  granted_at: Date;
  expires_at: Date | null;
}

const toGrant = (r: GrantRow): Grant =>
  Object.freeze({
    bankId: r.bank_id as BankId,
    capabilities: new Set(r.capabilities),
    grantedAt: r.granted_at,
    ...(r.expires_at !== null ? { expiresAt: r.expires_at } : {}),
  });

export class PgPrincipalRepository implements PrincipalRepository {
  constructor(private readonly db: Queryable) {}

  async get(id: PrincipalId): Promise<Principal | undefined> {
    const { rows } = await this.db.query<PrincipalRow>("SELECT * FROM governance.principals WHERE id = $1", [id]);
    return rows[0] ? this.hydrate(rows[0]) : undefined;
  }

  async findByApiKeyHash(hash: string): Promise<Principal | undefined> {
    const { rows } = await this.db.query<PrincipalRow>(
      `SELECT p.* FROM governance.api_keys k JOIN governance.principals p ON p.id = k.principal_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hash],
    );
    return rows[0] ? this.hydrate(rows[0]) : undefined;
  }

  /**
   * The grants are replaced, not merged. On a pool this runs in its own transaction so no reader (erasure's access store included) sees the principal with its grants half-written.
   * A principal id that already exists in another tenant is refused: the upsert only updates a row of the same tenant, so another tenant's principal is never renamed or handed these grants.
   */
  async save(p: Principal): Promise<void> {
    const write = async (db: Queryable) => {
      const upsert = await db.query(
        `INSERT INTO governance.principals (id, tenant_id, kind, display_name) VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, display_name = EXCLUDED.display_name
         WHERE principals.tenant_id = EXCLUDED.tenant_id`,
        [p.id, p.tenantId, p.kind, p.displayName],
      );
      if (upsert.rowCount === 0) throw new Error(`Principal ${p.id} already exists in another tenant; refusing to save it for tenant ${p.tenantId}`);
      await db.query("DELETE FROM governance.grants WHERE principal_id = $1", [p.id]);
      for (const g of p.grants) {
        await db.query(
          "INSERT INTO governance.grants (principal_id, bank_id, capabilities, granted_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
          [p.id, g.bankId, [...g.capabilities], g.grantedAt, g.expiresAt ?? null],
        );
      }
    };
    if (this.db instanceof pg.Pool) await withTransaction(this.db, write);
    else await write(this.db);
  }

  private async hydrate(r: PrincipalRow): Promise<Principal> {
    const { rows } = await this.db.query<GrantRow>("SELECT bank_id, capabilities, granted_at, expires_at FROM governance.grants WHERE principal_id = $1", [r.id]);
    return Object.freeze({
      id: r.id as PrincipalId,
      tenantId: r.tenant_id as TenantId,
      kind: r.kind,
      displayName: r.display_name,
      grants: rows.map(toGrant),
    });
  }
}

export class PgApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: Queryable) {}

  async issue(principalId: PrincipalId, hash: string, label: string): Promise<void> {
    await this.db.query("INSERT INTO governance.api_keys (key_hash, principal_id, label) VALUES ($1, $2, $3)", [hash, principalId, label]);
  }

  async revoke(hash: string): Promise<boolean> {
    const r = await this.db.query("UPDATE governance.api_keys SET revoked_at = now(), revocation_reason = 'operator' WHERE key_hash = $1 AND revoked_at IS NULL", [hash]);
    return (r.rowCount ?? 0) > 0;
  }
}

interface AuditRow {
  seq: string;
  tenant_id: string;
  bank_id: string | null;
  principal_id: string;
  action: AuditEntry["action"];
  details: AuditEntry["details"];
  at: Date;
  prev_hash: string;
  hash: string;
}

const toAuditEntry = (r: AuditRow): AuditEntry =>
  Object.freeze({
    seq: Number(r.seq),
    tenantId: r.tenant_id as TenantId,
    principalId: r.principal_id as PrincipalId,
    action: r.action,
    details: r.details,
    at: r.at,
    prevHash: r.prev_hash,
    hash: r.hash,
    ...(r.bank_id !== null ? { bankId: r.bank_id as BankId } : {}),
  });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Appends one entry using an already-open transaction. The per-tenant transaction-scoped
 * advisory lock serializes appends so two writers cannot fork the chain; it is released at
 * COMMIT/ROLLBACK together with the entry, so the entry and whatever it audits are atomic.
 */
async function appendOnClient(client: Queryable, input: NewAuditEntry): Promise<AuditEntry> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`audit:${input.tenantId}`]);
  const last = await client.query<AuditRow>("SELECT * FROM governance.audit_log WHERE tenant_id = $1 ORDER BY seq DESC LIMIT 1", [input.tenantId]);
  const prev = last.rows[0] ? toAuditEntry(last.rows[0]) : undefined;
  const entry = appendEntry(prev, input, sha256);
  await client.query(
    `INSERT INTO governance.audit_log (seq, tenant_id, bank_id, principal_id, action, details, at, prev_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [entry.seq, entry.tenantId, entry.bankId ?? null, entry.principalId, entry.action, JSON.stringify(entry.details), entry.at, entry.prevHash, entry.hash],
  );
  return entry;
}

/**
 * Hash-chained audit log in Postgres. Two modes:
 *  - `new PgAuditLog(pool)`: each append is its own transaction (reads, denials).
 *  - `PgAuditLog.onClient(client)`: appends inside the caller's open transaction, so a write
 *    and its audit entry commit or roll back together (the unit of work uses this).
 * The table forbids UPDATE and DELETE by trigger (migration 0001_governance).
 */
export class PgAuditLog implements AuditLogStore {
  constructor(private readonly pool: pg.Pool) {}

  /** `client` must be a connection with an open transaction (a PoolClient after BEGIN), never a Pool. */
  static onClient(client: pg.PoolClient): AuditLogStore {
    return {
      append: (input) => appendOnClient(client, input),
      list: (tenantId, opts) => listEntries(client, tenantId, opts),
      find: (tenantId, match) => findEntry(client, tenantId, match),
    };
  }

  append(input: NewAuditEntry): Promise<AuditEntry> {
    return withTransaction(this.pool, (client) => appendOnClient(client, input));
  }

  list(tenantId: TenantId, opts: { readonly limit?: number } = {}): Promise<readonly AuditEntry[]> {
    return listEntries(this.pool, tenantId, opts);
  }

  find(tenantId: TenantId, match: { readonly action: AuditEntry["action"]; readonly requestId: string }): Promise<AuditEntry | undefined> {
    return findEntry(this.pool, tenantId, match);
  }
}

async function findEntry(db: Queryable, tenantId: TenantId, match: { readonly action: AuditEntry["action"]; readonly requestId: string }): Promise<AuditEntry | undefined> {
  const { rows } = await db.query<AuditRow>("SELECT * FROM governance.audit_log WHERE tenant_id = $1 AND action = $2 AND details->>'requestId' = $3 ORDER BY seq ASC LIMIT 1", [tenantId, match.action, match.requestId]);
  return rows[0] ? toAuditEntry(rows[0]) : undefined;
}

async function listEntries(db: Queryable, tenantId: TenantId, opts: { readonly limit?: number } = {}): Promise<readonly AuditEntry[]> {
  const { rows } = await db.query<AuditRow>("SELECT * FROM governance.audit_log WHERE tenant_id = $1 ORDER BY seq ASC LIMIT $2", [tenantId, opts.limit ?? 10_000]);
  return rows.map(toAuditEntry);
}

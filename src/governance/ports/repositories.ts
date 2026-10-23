import type { BankId, PrincipalId, TenantId } from "../../shared-kernel/index.js";
import type { AuditEntry } from "../domain/audit-log.js";
import type { Principal } from "../domain/principal.js";

export interface PrincipalRepository {
  get(id: PrincipalId): Promise<Principal | undefined>;
  /** Upsert the principal and replace its grants. */
  save(principal: Principal): Promise<void>;
  findByApiKeyHash(hash: string): Promise<Principal | undefined>;
}

export interface ApiKeyStore {
  issue(principalId: PrincipalId, hash: string, label: string): Promise<void>;
  /** Returns false if the key was unknown or already revoked. */
  revoke(hash: string): Promise<boolean>;
}

export type NewAuditEntry = Omit<AuditEntry, "seq" | "prevHash" | "hash">;

export interface AuditLogStore {
  /** Append one hash-chained entry for the tenant. Serialized per tenant by the adapter. */
  append(entry: NewAuditEntry): Promise<AuditEntry>;
  list(tenantId: TenantId, opts?: { readonly limit?: number }): Promise<readonly AuditEntry[]>;
}

/** The one thing Governance needs to know about a Bank: which tenant owns it. Implemented by Memory's bank repository. */
export interface BankTenantLookup {
  tenantOf(bankId: BankId): Promise<TenantId | undefined>;
}

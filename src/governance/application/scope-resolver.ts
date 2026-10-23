import type { BankId, Clock, PrincipalId, Result, Scope, TenantId } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import { hashApiKey, looksLikeApiKey } from "./api-key.js";
import { resolveScope } from "../domain/principal.js";
import type { BankTenantLookup, PrincipalRepository } from "../ports/repositories.js";

export type ScopeResolutionError =
  | { readonly kind: "Unauthorized" } // no/invalid/revoked credential
  | { readonly kind: "NoGrant"; readonly bankId: BankId; readonly principalId: PrincipalId; readonly tenantId: TenantId }; // valid principal, no usable grant on this bank

/**
 * Turns a presented credential and a target Bank into a Scope, or an error.
 * The attachment layer calls this once per request; everything downstream carries the Scope.
 * Deliberately returns the same error for unknown and revoked keys. A grant on a bank owned by
 * another tenant is treated as no grant at all, so the tenant boundary is enforced once, here,
 * for every operation (the schema cannot express it yet).
 */
export class ScopeResolver {
  constructor(
    private readonly principals: PrincipalRepository,
    private readonly banks: BankTenantLookup,
    private readonly clock: Clock,
  ) {}

  async resolve(token: string | undefined, bankId: BankId): Promise<Result<Scope, ScopeResolutionError>> {
    if (!token || !looksLikeApiKey(token)) return err({ kind: "Unauthorized" });
    const principal = await this.principals.findByApiKeyHash(hashApiKey(token));
    if (!principal) return err({ kind: "Unauthorized" });
    const denied = { kind: "NoGrant", bankId, principalId: principal.id, tenantId: principal.tenantId } as const;
    const scope = resolveScope(principal, bankId, this.clock.now());
    if (!scope) return err(denied);
    const bankTenant = await this.banks.tenantOf(bankId);
    if (bankTenant === undefined || bankTenant !== principal.tenantId) return err(denied);
    return ok(scope);
  }
}

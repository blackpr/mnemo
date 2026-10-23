import type { BankId, Capability, PrincipalId, Scope, TenantId } from "../../shared-kernel/index.js";

export type PrincipalKind = "human" | "agent" | "integration";

export interface Grant {
  readonly bankId: BankId;
  readonly capabilities: ReadonlySet<Capability>;
  readonly grantedAt: Date;
  readonly expiresAt?: Date;
}

/** Principal: who is calling. A human, an agent, or a tool integration. Holds Grants on Banks. */
export interface Principal {
  readonly id: PrincipalId;
  readonly tenantId: TenantId;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly grants: readonly Grant[];
}

/** Resolve a Scope for a Principal on a Bank. Returns undefined if no live grant exists. */
export function resolveScope(principal: Principal, bankId: BankId, now: Date): Scope | undefined {
  const grant = principal.grants.find(
    (g) => g.bankId === bankId && (g.expiresAt === undefined || g.expiresAt.getTime() > now.getTime()),
  );
  if (!grant) return undefined;
  return {
    tenantId: principal.tenantId,
    bankId,
    principalId: principal.id,
    capabilities: grant.capabilities,
  };
}

import type { BankId, Capability, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";

export interface AccessDenied {
  readonly kind: "AccessDenied";
  readonly bankId: BankId;
  readonly required: Capability;
}

/**
 * AccessPolicy: the single decision point for every operation.
 * Memory's application layer calls this on every read and write, including GET by id.
 * There is no path that skips it (the MemClaw sub-tenant GET bypass is the failure we design against).
 */
export interface AccessPolicy {
  canRead(scope: Scope, bankId: BankId): Result<true, AccessDenied>;
  canWrite(scope: Scope, bankId: BankId): Result<true, AccessDenied>;
  canErase(scope: Scope, bankId: BankId): Result<true, AccessDenied>;
}

const check = (scope: Scope, bankId: BankId, required: Capability): Result<true, AccessDenied> => {
  // A Scope is bound to exactly one Bank. Asking about a different Bank is always denied,
  // regardless of capabilities: cross-bank reads need a new Scope resolved by Governance.
  if (scope.bankId !== bankId) return err({ kind: "AccessDenied", bankId, required });
  if (scope.capabilities.has("admin")) return ok(true);
  if (!scope.capabilities.has(required)) return err({ kind: "AccessDenied", bankId, required });
  return ok(true);
};

export const scopeAccessPolicy: AccessPolicy = {
  canRead: (scope, bankId) => check(scope, bankId, "read"),
  canWrite: (scope, bankId) => check(scope, bankId, "write"),
  canErase: (scope, bankId) => check(scope, bankId, "erase"),
};

import type { BankId, PrincipalId, TenantId } from "../../shared-kernel/index.js";

/**
 * AuditLog: append-only, hash-chained entries. Each entry's hash covers its content and the
 * previous entry's hash, so tampering or truncation is detectable.
 * Rule: the audit entry for a destructive action is written BEFORE the action; if the write
 * fails, the action does not happen.
 */

export type AuditAction =
  | "recall.served"
  | "episode.recorded"
  | "fact.asserted"
  | "fact.superseded"
  | "fact.invalidated"
  | "access.denied"
  | "erasure.requested"
  | "erasure.deleted"
  | "erasure.verified"
  | "erasure.receipted"
  | "history.redacted"
  | "export.produced";

export interface AuditEntry {
  readonly seq: number;
  readonly tenantId: TenantId;
  readonly bankId?: BankId;
  readonly principalId: PrincipalId;
  readonly action: AuditAction;
  /** Ids and counts only. Never memory content. */
  readonly details: Readonly<Record<string, string | number | readonly string[]>>;
  readonly at: Date;
  readonly prevHash: string;
  readonly hash: string;
}

export type Hasher = (input: string) => string;

export const GENESIS_HASH = "0".repeat(64);

export function appendEntry(
  prev: AuditEntry | undefined,
  input: Omit<AuditEntry, "seq" | "prevHash" | "hash">,
  hash: Hasher,
): AuditEntry {
  const seq = prev ? prev.seq + 1 : 0;
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  const body = JSON.stringify({ seq, prevHash, ...input, at: input.at.toISOString() });
  return Object.freeze({ ...input, seq, prevHash, hash: hash(body) });
}

/** Verify a chain of entries; returns the first broken seq or undefined if intact. */
export function verifyChain(entries: readonly AuditEntry[], hash: Hasher): number | undefined {
  let prevHash = GENESIS_HASH;
  for (const e of entries) {
    const { hash: expected, prevHash: _p, ...rest } = e;
    const body = JSON.stringify({ seq: rest.seq, prevHash, ...stripSeq(rest), at: e.at.toISOString() });
    if (e.prevHash !== prevHash || hash(body) !== expected) return e.seq;
    prevHash = e.hash;
  }
  return undefined;
}

function stripSeq<T extends { seq: number }>(o: T): Omit<T, "seq"> {
  const { seq: _s, ...rest } = o;
  return rest;
}

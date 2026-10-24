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
  | "fact.confirmed"
  | "fact.disputed"
  | "facts.listed"
  | "fact.read"
  | "extraction.applied"
  | "access.denied"
  | "erasure.requested"
  | "erasure.access_revoked"
  | "erasure.deleted"
  | "erasure.verified"
  | "erasure.receipt_issued"
  | "erasure.failed"
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

/**
 * Canonical JSON: keys sorted recursively, no whitespace. Required because the stored form
 * (Postgres jsonb) does not preserve key order, so hashing JSON.stringify output directly
 * would break verification after a round trip.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * The exact bytes that an entry's hash covers. Explicit field list, so adding fields is a
 * deliberate choice. `details` goes through a JSON round trip first so that live values
 * (Date, undefined in arrays) hash exactly as they will after being stored as jsonb.
 */
export function hashBody(e: Omit<AuditEntry, "hash">): string {
  const details: unknown = JSON.parse(JSON.stringify(e.details));
  return canonicalJson({
    seq: e.seq,
    prevHash: e.prevHash,
    tenantId: e.tenantId,
    bankId: e.bankId ?? null,
    principalId: e.principalId,
    action: e.action,
    details,
    at: e.at.toISOString(),
  });
}

export function appendEntry(
  prev: AuditEntry | undefined,
  input: Omit<AuditEntry, "seq" | "prevHash" | "hash">,
  hash: Hasher,
): AuditEntry {
  const seq = prev ? prev.seq + 1 : 0;
  const prevHash = prev ? prev.hash : GENESIS_HASH;
  const unhashed = { ...input, seq, prevHash };
  return Object.freeze({ ...unhashed, hash: hash(hashBody(unhashed)) });
}

/** Verify a chain of entries; returns the first broken seq or undefined if intact. */
export function verifyChain(entries: readonly AuditEntry[], hash: Hasher): number | undefined {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 0;
  for (const e of entries) {
    if (e.seq !== expectedSeq || e.prevHash !== prevHash || hash(hashBody(e)) !== e.hash) return e.seq;
    prevHash = e.hash;
    expectedSeq++;
  }
  return undefined;
}

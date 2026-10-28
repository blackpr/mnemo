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

/** Where a chain verification stands between two pages: the seq the next entry must have and the hash it must link to. */
export interface ChainCursor {
  readonly nextSeq: number;
  readonly prevHash: string;
}

export const CHAIN_START: ChainCursor = Object.freeze({ nextSeq: 0, prevHash: GENESIS_HASH });

/**
 * A break in the chain. `brokenAt` is the first entry that fails; `suspectFrom` is the earliest seq the failure can come from:
 * `brokenAt` itself when it links but its own hash fails (its content was changed), the last verified entry when `brokenAt` does
 * not link to it (that entry may have been rewritten and re-hashed, which leaves its own hash valid; or `brokenAt`'s `prevHash`
 * was changed) or when seqs are missing between them. The chain
 * is unkeyed, so a run of entries rewritten and re-hashed together shows only where the run ends: everything up to the break is
 * consistent, not proven untouched.
 */
export interface ChainBreak {
  readonly brokenAt: number;
  readonly suspectFrom: number;
}

/**
 * Verify the next run of entries of a chain, continuing from `from`, so a long chain can be checked page by page
 * with only the cursor carried between pages. Returns the cursor after the last entry, or the break.
 */
export function verifyChainPage(entries: readonly AuditEntry[], hash: Hasher, from: ChainCursor): { readonly cursor: ChainCursor } | ChainBreak {
  let { nextSeq, prevHash } = from;
  for (const e of entries) {
    if (e.seq !== nextSeq || e.prevHash !== prevHash) return { brokenAt: e.seq, suspectFrom: nextSeq - 1 };
    if (hash(hashBody(e)) !== e.hash) return { brokenAt: e.seq, suspectFrom: e.seq };
    prevHash = e.hash;
    nextSeq++;
  }
  return { cursor: { nextSeq, prevHash } };
}

/** Verify a chain of entries; returns the first broken seq or undefined if intact. */
export function verifyChain(entries: readonly AuditEntry[], hash: Hasher): number | undefined {
  const r = verifyChainPage(entries, hash, CHAIN_START);
  return "brokenAt" in r ? r.brokenAt : undefined;
}

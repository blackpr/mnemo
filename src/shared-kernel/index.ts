/**
 * Shared kernel: the deliberately tiny set of types every bounded context agrees on.
 * Pure TypeScript. No IO, no framework imports. See ARCHITECTURE.md section 3.
 */

// ---------- Identity ----------

declare const brand: unique symbol;
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Branded<string, "TenantId">;
export type SubjectId = Branded<string, "SubjectId">;
export type BankId = Branded<string, "BankId">;
export type EpisodeId = Branded<string, "EpisodeId">;
export type FactId = Branded<string, "FactId">;
export type PrincipalId = Branded<string, "PrincipalId">;

export const asTenantId = (s: string): TenantId => s as TenantId;
export const asSubjectId = (s: string): SubjectId => s as SubjectId;
export const asBankId = (s: string): BankId => s as BankId;
export const asEpisodeId = (s: string): EpisodeId => s as EpisodeId;
export const asFactId = (s: string): FactId => s as FactId;
export const asPrincipalId = (s: string): PrincipalId => s as PrincipalId;

// ---------- Time ----------

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// ---------- Result ----------

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ---------- Scope: who is acting, on which bank, under which tenant ----------

export type Capability = "read" | "write" | "admin" | "erase";

/**
 * Every command and query in the system carries a Scope.
 * Governance decides whether the Scope permits the operation; Memory conforms.
 */
export interface Scope {
  readonly tenantId: TenantId;
  readonly bankId: BankId;
  readonly principalId: PrincipalId;
  /** Capabilities the Principal has been granted on this Bank. Resolved by Governance. */
  readonly capabilities: ReadonlySet<Capability>;
}

// ---------- Model reference: which model wrote or judged something ----------

export interface ModelRef {
  readonly provider: string; // "anthropic" | "google" | "openai" | "ollama" | ...
  readonly model: string; // e.g. "claude-sonnet-5-5"
  readonly version: string; // provider version string or prompt/pipeline version
}

// ---------- Validity (world time) and transaction time ----------

/** When a fact was true in the world. validTo undefined means "still true as far as we know". */
export interface Validity {
  readonly validFrom: Date;
  readonly validTo?: Date;
}

/** When we learned a fact and when we stopped believing it. */
export interface TransactionTime {
  readonly recordedAt: Date;
  readonly retractedAt?: Date;
}

// ---------- Provenance ----------

export type ConfirmationState = "asserted" | "confirmed" | "disputed";

export interface Provenance {
  /** At least one. Invariant enforced by the Fact aggregate. */
  readonly sourceEpisodeIds: readonly EpisodeId[];
  readonly writerPrincipalId: PrincipalId;
  /** Present when a model (extractor) wrote the fact; absent for human-authored facts. */
  readonly extractor?: ModelRef;
  readonly confirmation: ConfirmationState;
  /** 0..1, optional faithfulness score from the write policy. */
  readonly faithfulness?: number;
}

// ---------- Domain events ----------

export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  readonly type: TType;
  readonly occurredAt: Date;
  readonly tenantId: TenantId;
  readonly bankId: BankId;
  readonly payload: TPayload;
}

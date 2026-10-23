import type { BankId, Clock, EpisodeId, FactId, ModelRef, Result, Scope } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { AccessDenied, AccessPolicy } from "../../governance/index.js";
import { canAcceptWrites } from "../domain/bank.js";
import { recordAsHistorical, supersedeWith } from "../domain/conflict-resolver.js";
import { assertFact, invalidate, type Episode, type Fact, type NewFact } from "../domain/index.js";
import type { FactAsserted, FactDisputed, FactInvalidated, FactSuperseded } from "../domain/events.js";
import { decideWrite, type SimilarExisting } from "../domain/write-policy.js";
import type { TransactionalRepositories, UnitOfWork } from "../ports/repositories.js";

/** What the extractor says about how a candidate relates to an existing fact. */
export type Relation = "duplicate" | "contradicts" | "updates";

export interface ExtractedCandidate {
  readonly id: FactId;
  readonly statement: string;
  readonly predicate?: Fact["predicate"];
  /** World time the statement became true. Defaults to the triggering episode's time. */
  readonly validFrom?: Date;
  readonly sourceEpisodeIds: readonly EpisodeId[];
  readonly faithfulness: number;
  readonly related: readonly { readonly factId: FactId; readonly relation: Relation }[];
}

export interface WriteExtractedFactsInput {
  readonly bankId: BankId;
  readonly extractor: ModelRef;
  /** The episode whose extraction this is. Idempotency key: a second application for the same trigger is a no-op. */
  readonly triggerEpisodeId: EpisodeId;
  readonly defaultValidFrom: Date;
  readonly candidates: readonly ExtractedCandidate[];
}

export type RejectReason =
  | "duplicate"
  | "low_faithfulness"
  | "empty"
  | "unknown_source_episode"
  | "no_subject_source"
  | "looks_like_secret"
  | "conflicting_fact_vanished"
  | string;

export interface WriteExtractedFactsResult {
  /** True when this trigger had already been applied; nothing was written. */
  readonly alreadyApplied: boolean;
  readonly asserted: readonly FactId[];
  readonly superseded: readonly { readonly oldFactId: FactId; readonly newFactId: FactId }[];
  readonly invalidated: readonly { readonly oldFactId: FactId; readonly newFactId: FactId }[];
  readonly historical: readonly FactId[];
  readonly rejected: readonly { readonly statement: string; readonly reason: RejectReason }[];
}

export type WriteExtractedFactsError = AccessDenied | { readonly kind: "BankNotFound" } | { readonly kind: "BankNotWritable" };

/**
 * Applies extracted candidates to the system of record in one transaction:
 * WritePolicy decides (contradiction check before dedupe), ConflictResolver executes
 * supersession, invalidation or historical recording, events go to the outbox, one audit entry
 * summarizes. Called by the Extraction context; the only way machine-written facts enter Memory.
 *
 * Code-enforced guards that do not rely on the prompt:
 *  - a candidate must have at least one source episode authored by the Subject (role "user" or
 *    an imported document); assistant and tool output alone never establish a fact;
 *  - statements that look like credentials are rejected;
 *  - a trigger episode is applied at most once (idempotency across retries).
 */
export class WriteExtractedFactsHandler {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: AccessPolicy,
    private readonly clock: Clock,
  ) {}

  async handle(scope: Scope, input: WriteExtractedFactsInput): Promise<Result<WriteExtractedFactsResult, WriteExtractedFactsError>> {
    const allowed = this.access.canWrite(scope, input.bankId);
    if (!allowed.ok) return allowed;

    return this.uow.run(async (tx) => {
      const bank = await tx.banks.get(input.bankId);
      if (!bank) return err({ kind: "BankNotFound" } as const);
      if (bank.tenantId !== scope.tenantId) return err({ kind: "AccessDenied", bankId: input.bankId, required: "write" } as const);
      if (!canAcceptWrites(bank)) return err({ kind: "BankNotWritable" } as const);

      const empty: WriteExtractedFactsResult = { alreadyApplied: true, asserted: [], superseded: [], invalidated: [], historical: [], rejected: [] };
      if (await tx.facts.existsForTrigger(scope, input.triggerEpisodeId, scope.principalId)) return ok(empty);

      const now = this.clock.now();
      const asserted: FactId[] = [];
      const superseded: { oldFactId: FactId; newFactId: FactId }[] = [];
      const invalidated: { oldFactId: FactId; newFactId: FactId }[] = [];
      const historical: FactId[] = [];
      const rejected: { statement: string; reason: RejectReason }[] = [];
      const events: (FactAsserted | FactSuperseded | FactInvalidated | FactDisputed)[] = [];
      const base = { occurredAt: now, tenantId: scope.tenantId, bankId: input.bankId };

      for (const c of input.candidates) {
        const sourceIds = [...new Set(c.sourceEpisodeIds)];
        const sources = await tx.episodes.getMany(scope, sourceIds);
        if (sources.length !== sourceIds.length) {
          rejected.push({ statement: c.statement, reason: "unknown_source_episode" });
          continue;
        }
        if (!sources.some(isSubjectAuthored)) {
          rejected.push({ statement: c.statement, reason: "no_subject_source" });
          continue;
        }
        if (looksLikeSecret(c.statement)) {
          rejected.push({ statement: "[redacted]", reason: "looks_like_secret" });
          continue;
        }

        const validFrom = c.validFrom ?? input.defaultValidFrom;
        const candidate: NewFact = {
          id: c.id,
          bankId: input.bankId,
          statement: c.statement,
          validity: { validFrom },
          provenance: { sourceEpisodeIds: sourceIds, writerPrincipalId: scope.principalId, extractor: input.extractor, triggerEpisodeId: input.triggerEpisodeId, confirmation: "asserted", faithfulness: c.faithfulness },
          ...(c.predicate !== undefined ? { predicate: c.predicate } : {}),
        };

        // Lock related facts in a fixed order (deadlock-safe across workers); superseded facts are history and ignored.
        const related: SimilarExisting[] = [];
        for (const r of [...c.related].sort((a, b) => (a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0))) {
          const existing = await tx.facts.get(scope, r.factId, { forUpdate: true });
          if (!existing || existing.supersededBy !== undefined || existing.transaction.retractedAt !== undefined) continue;
          const sameInstant = validFrom.getTime() === existing.validity.validFrom.getTime();
          related.push({
            fact: existing,
            similarity: r.relation === "duplicate" ? 1 : 0,
            contradicts: r.relation !== "duplicate",
            relation: r.relation === "contradicts" || sameInstant ? "contradicts" : "updates",
            candidateIsNewer: validFrom.getTime() >= existing.validity.validFrom.getTime(),
          });
        }

        const decision = decideWrite(candidate, related, bank.policy);
        switch (decision.action) {
          case "reject":
            rejected.push({ statement: c.statement, reason: decision.reason });
            break;

          case "assert": {
            const r = await insertNew(tx, candidate, now);
            if (!r.ok) {
              rejected.push({ statement: c.statement, reason: r.error });
              break;
            }
            asserted.push(r.value.id);
            events.push({ type: "memory.FactAsserted", ...base, payload: { factId: r.value.id, sourceEpisodeIds: sourceIds, extractor: input.extractor } });
            break;
          }

          case "supersede": {
            const old = related.find((s) => s.fact.id === decision.oldFactId)?.fact;
            if (!old) {
              rejected.push({ statement: c.statement, reason: "conflicting_fact_vanished" });
              break;
            }
            if (decision.mode === "invalidate") {
              const retracted = invalidate(old, "contradicted", now, `contradicted by ${candidate.id}`);
              const fresh = await insertNew(tx, candidate, now);
              if (!retracted.ok || !fresh.ok) {
                rejected.push({ statement: c.statement, reason: retracted.ok ? (fresh as { error: string }).error : retracted.error.kind });
                break;
              }
              await tx.facts.update(retracted.value);
              asserted.push(fresh.value.id);
              invalidated.push({ oldFactId: old.id, newFactId: fresh.value.id });
              events.push({ type: "memory.FactAsserted", ...base, payload: { factId: fresh.value.id, sourceEpisodeIds: sourceIds, extractor: input.extractor } });
              events.push({ type: "memory.FactInvalidated", ...base, payload: { factId: old.id, reason: "contradicted" } });
              break;
            }
            const r = supersedeWith(old, candidate, now);
            if (!r.ok) {
              rejected.push({ statement: c.statement, reason: r.error.kind });
              break;
            }
            await tx.facts.insert(r.value.replacement);
            await tx.facts.update(r.value.old);
            asserted.push(r.value.replacement.id);
            superseded.push({ oldFactId: old.id, newFactId: r.value.replacement.id });
            events.push({ type: "memory.FactAsserted", ...base, payload: { factId: r.value.replacement.id, sourceEpisodeIds: sourceIds, extractor: input.extractor } });
            events.push({ type: "memory.FactSuperseded", ...base, payload: { oldFactId: old.id, newFactId: r.value.replacement.id } });
            break;
          }

          case "flag_dispute": {
            const conflicting = related.find((s) => s.fact.id === decision.conflictingFactId)?.fact;
            if (!conflicting) {
              rejected.push({ statement: c.statement, reason: "conflicting_fact_vanished" });
              break;
            }
            const r = recordAsHistorical(candidate, conflicting, now);
            if (!r.ok) {
              rejected.push({ statement: c.statement, reason: r.error.kind });
              break;
            }
            await tx.facts.insert(r.value);
            historical.push(r.value.id);
            events.push({ type: "memory.FactAsserted", ...base, payload: { factId: r.value.id, sourceEpisodeIds: sourceIds, extractor: input.extractor } });
            events.push({ type: "memory.FactDisputed", ...base, payload: { factId: r.value.id } });
            break;
          }
        }
      }

      if (events.length > 0) await tx.outbox.publish(events);
      await tx.audit.append({
        tenantId: scope.tenantId,
        bankId: input.bankId,
        principalId: scope.principalId,
        action: "extraction.applied",
        details: {
          extractor: `${input.extractor.provider}/${input.extractor.model}@${input.extractor.version}`,
          triggerEpisodeId: input.triggerEpisodeId,
          asserted: asserted.length,
          superseded: superseded.length,
          invalidated: invalidated.length,
          historical: historical.length,
          rejected: rejected.length,
          factIds: [...asserted, ...historical],
        },
        at: now,
      });
      return ok({ alreadyApplied: false, asserted, superseded, invalidated, historical, rejected });
    });
  }
}

async function insertNew(tx: TransactionalRepositories, candidate: NewFact, now: Date): Promise<Result<Fact, string>> {
  const built = assertFact(candidate, now);
  if (!built.ok) return err(built.error.kind);
  await tx.facts.insert(built.value);
  return ok(built.value);
}

/** Only the Subject's own words establish facts about the Subject. Imported documents are theirs too. */
export function isSubjectAuthored(e: Episode): boolean {
  return e.role === "user" || e.kind === "imported_document";
}

/**
 * Credential detection. Tuned to avoid flagging ordinary facts (phone numbers, IBANs, commit
 * SHAs, repository paths, long words): a digit run only counts as a card number if it passes
 * Luhn; a long token only counts as a key if it mixes upper, lower and digits; a keyword must
 * be followed by a token-like value containing a digit or symbol.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/, // OpenAI / Anthropic / Stripe style keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?<!commit\s)(?<!sha\s)\b(?=[a-f0-9]*\d)(?=[a-f0-9]*[a-f])[a-f0-9]{40,}\b/i, // long hex, not a referenced commit
  /\b(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/, // long mixed-case base64
  /\b(?:password|passwd|passphrase|pwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|token)\b\s*(?:[:=]|\bis\b|\bwas\b)\s*(?=\S*[\d!@#$%^&*_+=-])\S{6,}/i,
];

export function looksLikeSecret(statement: string): boolean {
  if (SECRET_PATTERNS.some((p) => p.test(statement))) return true;
  // Card numbers: 13-19 digits possibly separated by spaces or dashes, validated with Luhn.
  for (const m of statement.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

import type { Result } from "../../shared-kernel/index.js";
import { err, ok } from "../../shared-kernel/index.js";
import type { Hasher } from "../domain/audit-log.js";
import { verifyReceipt, type ErasureRequest, type ErasureState } from "../domain/erasure-request.js";
import type { AuditLogStore, ErasableStore, ErasureRequestRepository } from "../ports/repositories.js";

export interface StoreCheck {
  readonly store: string;
  /** Zero-hit count the receipt recorded for the store; undefined when the receipt does not mention it. */
  readonly receipted: number | undefined;
  /** What the store reports for the bank now (summed when several adapters answer for one name); undefined when none answers. */
  readonly now: number | undefined;
  readonly ok: boolean;
  /**
   * `not_in_receipt`: a store wired today that the receipt predates. `not_requeried`: a receipted store no adapter
   * answers for any more, or whose adapter failed to count (the error kind goes to the process log, never here).
   */
  readonly note?: "not_in_receipt" | "not_requeried";
}

export interface ReceiptVerification {
  readonly requestId: string;
  readonly bankId: ErasureRequest["bankId"];
  readonly tenantId: ErasureRequest["tenantId"];
  readonly subjectId: ErasureRequest["subjectId"];
  readonly issuedAt: Date;
  readonly digest: string;
  /** The digest recomputed over the stored receipt matches: the receipt is internally consistent (an unkeyed sha256 beside its payload, so not tamper evidence on its own). */
  readonly digestValid: boolean;
  /** The receipt names the request, bank, tenant and subject of the row it is stored on. */
  readonly bound: boolean;
  /** The tenant's hash-chained audit log carries an `erasure.receipt_issued` entry for this request with this digest: the tamper evidence. */
  readonly chained: boolean;
  readonly stores: readonly StoreCheck[];
  /** Digest valid, receipt bound to its row, digest in the audit chain, every receipted store re-queried to zero, every wired store at zero. */
  readonly ok: boolean;
}

export type VerifyReceiptError =
  | { readonly kind: "ErasureNotFound"; readonly requestId: string }
  | { readonly kind: "NoReceipt"; readonly requestId: string; readonly state: ErasureState }
  /** The row says `receipted` but holds no receipt: a corrupted record, not a benign state. */
  | { readonly kind: "ReceiptMissing"; readonly requestId: string };

/**
 * Operator check of an erasure receipt, after the fact. The stored request is loaded, the receipt's
 * digest is recomputed (`verifyReceipt`), the receipt is checked against the row it sits on and against
 * the tenant's audit chain (`erasure.receipt_issued` carries the digest), and every wired store is asked
 * again what it holds for the bank. It passes only when all of that holds, every store the receipt
 * lists still reports zero, and every store wired today reports zero too (a store the receipt predates
 * is flagged `not_in_receipt` and must still be empty; a receipted store that no adapter answers for,
 * or whose adapter fails, is `not_requeried` and fails, because nothing proves it). Several adapters
 * answering for one name are summed, so a duplicate name can never hide a hit. Like `erasure-status`
 * it is operator tooling without a Scope: it reads counts and digests, never content.
 */
export class VerifyReceiptHandler {
  constructor(
    private readonly requests: ErasureRequestRepository,
    private readonly audit: AuditLogStore,
    private readonly stores: readonly ErasableStore[],
    private readonly hash: Hasher,
  ) {}

  async handle(requestId: string): Promise<Result<ReceiptVerification, VerifyReceiptError>> {
    const request = await this.requests.get(requestId);
    if (!request) return err({ kind: "ErasureNotFound", requestId } as const);
    const receipt = request.receipt;
    if (request.state !== "receipted") return err({ kind: "NoReceipt", requestId, state: request.state } as const);
    if (!receipt) return err({ kind: "ReceiptMissing", requestId } as const);

    const now = new Map<string, number>();
    for (const store of this.stores) {
      try {
        for (const [name, n] of Object.entries(await store.count(request.bankId))) now.set(name, (now.get(name) ?? 0) + n);
      } catch (e) {
        // A store that cannot be counted proves nothing: its receipted names stay `not_requeried`. The message may echo infrastructure details; log only.
        console.error(`verify-receipt ${requestId}: a store failed to count (${e instanceof Error ? e.name : typeof e})`, e);
      }
    }
    const receipted = new Map<string, number>();
    for (const s of receipt.stores) receipted.set(s.store, (receipted.get(s.store) ?? 0) + s.hitsAfter);
    const names = [...new Set([...receipted.keys(), ...now.keys()])];
    const stores: StoreCheck[] = names.map((store) => {
      const was = receipted.get(store);
      const is = now.get(store);
      if (is === undefined) return { store, receipted: was, now: undefined, ok: false, note: "not_requeried" };
      if (was === undefined) return { store, receipted: undefined, now: is, ok: is === 0, note: "not_in_receipt" };
      return { store, receipted: was, now: is, ok: was === 0 && is === 0 };
    });

    const digestValid = verifyReceipt(receipt, this.hash);
    const bound = receipt.requestId === request.id && receipt.bankId === request.bankId && receipt.tenantId === request.tenantId && receipt.subjectId === request.subjectId;
    const issued = await this.audit.find(request.tenantId, { action: "erasure.receipt_issued", requestId: request.id });
    const chained = issued?.details["digest"] === receipt.digest;
    return ok({
      requestId: request.id,
      bankId: request.bankId,
      tenantId: request.tenantId,
      subjectId: request.subjectId,
      issuedAt: receipt.issuedAt,
      digest: receipt.digest,
      digestValid,
      bound,
      chained,
      stores,
      ok: digestValid && bound && chained && stores.every((s) => s.ok),
    });
  }
}

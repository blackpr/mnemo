import type { BankId, EpisodeId, PrincipalId } from "../../shared-kernel/index.js";

export type EpisodeKind = "conversation_turn" | "tool_result" | "imported_document" | "system_note";

/**
 * Episode: an immutable record of something that happened. Append-only.
 * Invariant 1: never updated or deleted except through Erasure (Governance).
 * The raw, non-lossy provenance every Fact points back to.
 */
export interface Episode {
  readonly id: EpisodeId;
  readonly bankId: BankId;
  readonly kind: EpisodeKind;
  /** Which tool/provider the episode came from: "claude-code", "gemini", "chatgpt-export", ... */
  readonly source: string;
  readonly role?: "user" | "assistant" | "tool" | "system";
  readonly text: string;
  /** When it happened in the world (from the transcript), not when we stored it. */
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly recordedBy: PrincipalId;
  /** Idempotency key supplied by the caller (e.g. hash of source + turn index). */
  readonly externalRef?: string;
}

export interface NewEpisode {
  readonly id: EpisodeId;
  readonly bankId: BankId;
  readonly kind: EpisodeKind;
  readonly source: string;
  readonly role?: Episode["role"];
  readonly text: string;
  readonly occurredAt: Date;
  readonly externalRef?: string;
}

export function createEpisode(input: NewEpisode, recordedBy: PrincipalId, recordedAt: Date): Episode {
  if (input.text.trim().length === 0) {
    throw new Error("Episode text must not be empty");
  }
  const episode: Episode = {
    id: input.id,
    bankId: input.bankId,
    kind: input.kind,
    source: input.source,
    text: input.text,
    occurredAt: input.occurredAt,
    recordedAt,
    recordedBy,
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
  };
  return Object.freeze(episode);
}

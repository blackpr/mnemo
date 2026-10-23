import { z } from "zod";

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/**
 * Ids are server-generated. Clients get idempotency through `externalRef` (unique per bank),
 * never by choosing ids: episode and fact ids are global keys, so client-chosen ids would be a
 * cross-tenant existence oracle and allow id squatting.
 */
export const retainBody = z.object({
  kind: z.enum(["conversation_turn", "tool_result", "imported_document", "system_note"]).default("conversation_turn"),
  source: z.string().min(1).max(100),
  role: z.enum(["user", "assistant", "tool", "system"]).optional(),
  text: z.string().min(1).max(200_000),
  occurredAt: isoDate.optional(),
  externalRef: z.string().min(1).max(500).optional(),
});

export const recallBody = z.object({
  query: z.string().min(1).max(10_000),
  limit: z.number().int().min(1).max(100).default(10),
  asOf: isoDate.optional(),
  includeEpisodes: z.boolean().default(false),
});

export const assertFactBody = z.object({
  statement: z.string().min(1).max(10_000),
  predicate: z.object({ subject: z.string(), predicate: z.string(), object: z.string() }).optional(),
  validFrom: isoDate.optional(),
  sourceEpisodeIds: z.array(z.string().min(1)).min(1).max(50),
});

export const listFactsQuery = z.object({
  asOf: isoDate.optional(),
});

/** Over REST only the archival formats; the provider paste formats are an admin concern (`admin render-import`). */
export const exportQuery = z.object({
  format: z.enum(["jsonl", "markdown"]).default("jsonl"),
});

/** Erasure request ids are server-generated UUIDs; anything else is a 404 without touching the database. */
export const erasureIdParam = z.uuid();

export type RetainBody = z.infer<typeof retainBody>;
export type RecallBody = z.infer<typeof recallBody>;
export type AssertFactBody = z.infer<typeof assertFactBody>;

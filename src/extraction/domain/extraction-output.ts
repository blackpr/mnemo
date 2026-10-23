import { z } from "zod";

/**
 * The structured output the extractor model must produce. Kept small and literal so every
 * provider's structured-output mode can satisfy it.
 */
export const extractionOutputSchema = z.object({
  candidates: z
    .array(
      z.object({
        statement: z.string().min(1).max(500).describe("One atomic, self-contained fact about the Subject or their world, in third person, present tense where still true."),
        predicate: z
          .object({ subject: z.string().max(200), predicate: z.string().max(200), object: z.string().max(500) })
          .nullable()
          .describe("Optional structured form, or null."),
        validFrom: z.string().nullable().describe("ISO 8601 date-time when this became true, if the text says so; otherwise null."),
        sourceEpisodeIds: z.array(z.string()).min(1).describe("Ids of the episodes (from the list given) that support this fact."),
        related: z
          .array(
            z.object({
              factId: z.string().describe("Id of an existing fact from the list given."),
              relation: z.enum(["duplicate", "contradicts", "updates"]).describe("duplicate: same meaning; contradicts: cannot both be true; updates: newer state of the same thing."),
            }),
          )
          .describe("Existing facts this candidate duplicates, contradicts or updates. Empty if none."),
        faithfulness: z.number().min(0).max(1).describe("How directly the source text states this (1 = verbatim, 0.5 = reasonable inference, below 0.5 = speculation)."),
      }),
    )
    .describe("Zero or more candidate facts. Return an empty array when the episode contains nothing worth remembering."),
});

export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

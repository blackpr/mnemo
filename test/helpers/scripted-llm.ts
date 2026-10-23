import type { ZodType } from "zod";
import type { ModelRef } from "../../src/shared-kernel/index.js";
import type { LlmClient, StructuredCompletion } from "../../src/extraction/index.js";

/**
 * Test double for LlmClient: returns queued responses in order, validated against the schema
 * the caller passed so a fixture that drifts from the real schema fails loudly. Records prompts.
 */
export class ScriptedLlmClient implements LlmClient {
  readonly model: ModelRef = { provider: "test", model: "scripted", version: "t1" };
  readonly calls: { system: string; user: string }[] = [];
  private readonly queue: unknown[];

  constructor(responses: readonly unknown[]) {
    this.queue = [...responses];
  }

  async completeStructured<T>(input: { readonly system: string; readonly user: string; readonly schema: ZodType<T> }): Promise<StructuredCompletion<T>> {
    this.calls.push({ system: input.system, user: input.user });
    const next = this.queue.shift();
    if (next === undefined) throw new Error("ScriptedLlmClient: no more scripted responses");
    if (next instanceof Error) throw next;
    const parsed = input.schema.safeParse(next);
    if (!parsed.success) throw new Error(`ScriptedLlmClient: scripted response does not match schema: ${parsed.error.message}`);
    return { value: parsed.data, inputTokens: 1234, outputTokens: 56, latencyMs: 7 };
  }
}

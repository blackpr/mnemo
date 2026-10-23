/**
 * Arm A, full context: the whole conversation goes into the answering prompt, no retrieval. This is
 * the ceiling every memory arm is compared against (hypothesis H1). The result records the exact
 * prompt token count per question (`promptTokens` in metadata and `tokenUsage.prompt`).
 *
 * For a temporal question the arm still sees every turn (that is what "full context" means) and is
 * told the as-of instant; filtering turns by time would be a retrieval policy, which this arm has none of.
 */
import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";
import { loadConversation, renderTurn } from "../corpus/store.js";
import { answer, asOfInstruction, evalVars, providerResponse } from "./lib.js";

export const ARM = "A-full-context";

export default class FullContextProvider implements ApiProvider {
  private readonly providerId: string;

  constructor(options: { id?: string } = {}) {
    this.providerId = options.id ?? "arm-a-full-context";
  }

  id(): string {
    return this.providerId;
  }

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const vars = evalVars(context);
    const turns = await loadConversation(vars.conversationId);
    const material = turns.map(renderTurn).join("\n\n");
    const user = `Here is the user's full conversation history, oldest first.\n\n<history>\n${material}\n</history>\n\nQuestion: ${vars.question}${asOfInstruction(vars.asOf)}`;
    const a = await answer(ARM, user, context);
    return providerResponse(ARM, a, context, { questionId: vars.questionId, conversationId: vars.conversationId, type: vars.type, asOf: vars.asOf ?? null, conversationTurns: turns.length, contextChars: material.length });
  }
}

import type { ModelAdapter, ModelConfig } from "../core/types.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { OpenAIResponsesAdapter } from "./openai.ts";

export { AnthropicAdapter, OpenAIResponsesAdapter };
export { streamWithRetry } from "./retry.ts";
export type { RetryOptions, RetryReason } from "./retry.ts";

export function createAdapter(model: ModelConfig): ModelAdapter {
  switch (model.provider) {
    case "anthropic": return new AnthropicAdapter();
    case "openai": return new OpenAIResponsesAdapter();
    default: throw new Error(`Unsupported provider: ${(model as { provider: string }).provider}`);
  }
}

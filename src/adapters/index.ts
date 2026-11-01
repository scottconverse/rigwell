import type { ModelAdapter, ModelConfig } from "../core/types.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { ChatCompletionsAdapter } from "./chat.ts";
import { OpenAIResponsesAdapter } from "./openai.ts";

export { AnthropicAdapter, ChatCompletionsAdapter, OpenAIResponsesAdapter };
export { streamWithRetry } from "./retry.ts";
export type { RetryOptions, RetryReason } from "./retry.ts";

export function createAdapter(model: ModelConfig): ModelAdapter {
  switch (model.provider) {
    case "anthropic": return new AnthropicAdapter();
    case "openai": return new OpenAIResponsesAdapter();
    case "generic-chat-completion-api": return new ChatCompletionsAdapter();
    default: throw new Error(`Unsupported provider: ${(model as { provider: string }).provider}`);
  }
}

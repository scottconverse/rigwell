import type { ModelAdapter, ModelConfig } from "../core/types.ts";
import { AnthropicAdapter } from "./anthropic.ts";
import { BedrockAnthropicAdapter, BedrockConverseAdapter } from "./bedrock.ts";
import { ChatCompletionsAdapter } from "./chat.ts";
import { GoogleAdapter } from "./google.ts";
import { OpenAIResponsesAdapter } from "./openai.ts";

export { AnthropicAdapter, BedrockAnthropicAdapter, BedrockConverseAdapter, ChatCompletionsAdapter, GoogleAdapter, OpenAIResponsesAdapter };
export { streamWithRetry } from "./retry.ts";
export type { RetryOptions, RetryReason } from "./retry.ts";
export { closeOpenAIWs } from "./openai-ws.ts";

/**
 * One adapter per provider (spec 4.6.1). A `bedrock` block on an anthropic or openai model selects the Bedrock
 * variants (Anthropic Messages through InvokeModelWithResponseStream; Responses with Bedrock auth, spec 4.6.10).
 * None of the Bedrock adapters retry: the harness does (spec 4.6.9).
 */
export function createAdapter(model: ModelConfig): ModelAdapter {
  switch (model.provider) {
    case "anthropic": return model.bedrock ? new BedrockAnthropicAdapter() : new AnthropicAdapter();
    case "openai": return new OpenAIResponsesAdapter();
    case "generic-chat-completion-api": return new ChatCompletionsAdapter();
    case "google": return new GoogleAdapter();
    case "bedrock-converse": return new BedrockConverseAdapter();
    default: throw new Error(`Unsupported provider: ${(model as { provider: string }).provider}`);
  }
}

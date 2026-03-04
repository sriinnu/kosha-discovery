export { AnthropicDiscoverer } from "./anthropic.js";
export { OpenAIDiscoverer } from "./openai.js";
export { GoogleDiscoverer } from "./google.js";
export { OllamaDiscoverer } from "./ollama.js";
export { OpenRouterDiscoverer } from "./openrouter.js";
export { BedrockDiscoverer, inferOriginFromBedrockId } from "./bedrock.js";
export { VertexDiscoverer } from "./vertex.js";
export { NvidiaDiscoverer } from "./nvidia.js";
export { TogetherDiscoverer } from "./together.js";
export { FireworksDiscoverer } from "./fireworks.js";
export { GroqDiscoverer } from "./groq.js";
export { MistralDiscoverer } from "./mistral.js";
export { DeepInfraDiscoverer } from "./deepinfra.js";
export { CohereDiscoverer } from "./cohere.js";
export { CerebrasDiscoverer } from "./cerebras.js";
export { PerplexityDiscoverer } from "./perplexity.js";
export { OpenAICompatibleDiscoverer } from "./openai-compatible.js";
export { BaseDiscoverer } from "./base.js";

import type { ProviderDiscoverer } from "../types.js";
import { AnthropicDiscoverer } from "./anthropic.js";
import { BedrockDiscoverer } from "./bedrock.js";
import { CerebrasDiscoverer } from "./cerebras.js";
import { CohereDiscoverer } from "./cohere.js";
import { DeepInfraDiscoverer } from "./deepinfra.js";
import { FireworksDiscoverer } from "./fireworks.js";
import { GoogleDiscoverer } from "./google.js";
import { GroqDiscoverer } from "./groq.js";
import { MistralDiscoverer } from "./mistral.js";
import { NvidiaDiscoverer } from "./nvidia.js";
import { OllamaDiscoverer } from "./ollama.js";
import { OpenAIDiscoverer } from "./openai.js";
import { OpenRouterDiscoverer } from "./openrouter.js";
import { PerplexityDiscoverer } from "./perplexity.js";
import { TogetherDiscoverer } from "./together.js";
import { VertexDiscoverer } from "./vertex.js";

/**
 * Returns all built-in provider discoverers.
 *
 * Includes direct-API providers (Anthropic, OpenAI, Google, Ollama, OpenRouter)
 * as well as managed-service proxies (AWS Bedrock, Google Vertex AI).
 */
export function getAllDiscoverers(options?: { ollamaBaseUrl?: string }): ProviderDiscoverer[] {
	return [
		new AnthropicDiscoverer(),
		new OpenAIDiscoverer(),
		new GoogleDiscoverer(),
		new OllamaDiscoverer(options?.ollamaBaseUrl),
		new OpenRouterDiscoverer(),
		new BedrockDiscoverer(),
		new VertexDiscoverer(),
		new NvidiaDiscoverer(),
		new TogetherDiscoverer(),
		new FireworksDiscoverer(),
		new GroqDiscoverer(),
		new MistralDiscoverer(),
		new DeepInfraDiscoverer(),
		new CohereDiscoverer(),
		new CerebrasDiscoverer(),
		new PerplexityDiscoverer(),
	];
}

/**
 * Returns a single discoverer by provider ID, or undefined if not found.
 *
 * Supported IDs: `"anthropic"`, `"openai"`, `"google"`, `"ollama"`,
 * `"openrouter"`, `"bedrock"`, `"vertex"`.
 */
export function getDiscoverer(providerId: string, options?: { baseUrl?: string }): ProviderDiscoverer | undefined {
	const map: Record<string, () => ProviderDiscoverer> = {
		anthropic: () => new AnthropicDiscoverer(),
		openai: () => new OpenAIDiscoverer(),
		google: () => new GoogleDiscoverer(),
		ollama: () => new OllamaDiscoverer(options?.baseUrl),
		openrouter: () => new OpenRouterDiscoverer(),
		bedrock: () => new BedrockDiscoverer(),
		vertex: () => new VertexDiscoverer(),
		nvidia: () => new NvidiaDiscoverer(),
		together: () => new TogetherDiscoverer(),
		fireworks: () => new FireworksDiscoverer(),
		groq: () => new GroqDiscoverer(),
		mistral: () => new MistralDiscoverer(),
		deepinfra: () => new DeepInfraDiscoverer(),
		cohere: () => new CohereDiscoverer(),
		cerebras: () => new CerebrasDiscoverer(),
		perplexity: () => new PerplexityDiscoverer(),
	};
	return map[providerId]?.();
}

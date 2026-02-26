export { AnthropicDiscoverer } from "./anthropic.js";
export { OpenAIDiscoverer } from "./openai.js";
export { GoogleDiscoverer } from "./google.js";
export { OllamaDiscoverer } from "./ollama.js";
export { OpenRouterDiscoverer } from "./openrouter.js";
export { BedrockDiscoverer, inferOriginFromBedrockId } from "./bedrock.js";
export { VertexDiscoverer } from "./vertex.js";
export { BaseDiscoverer } from "./base.js";

import type { ProviderDiscoverer } from "../types.js";
import { AnthropicDiscoverer } from "./anthropic.js";
import { BedrockDiscoverer } from "./bedrock.js";
import { GoogleDiscoverer } from "./google.js";
import { OllamaDiscoverer } from "./ollama.js";
import { OpenAIDiscoverer } from "./openai.js";
import { OpenRouterDiscoverer } from "./openrouter.js";
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
	};
	return map[providerId]?.();
}

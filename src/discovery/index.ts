export { AnthropicDiscoverer } from "./anthropic.js";
export { OpenAIDiscoverer } from "./openai.js";
export { GoogleDiscoverer } from "./google.js";
export { OllamaDiscoverer } from "./ollama.js";
export { OpenRouterDiscoverer } from "./openrouter.js";
export { BaseDiscoverer } from "./base.js";

import type { ProviderDiscoverer } from "../types.js";
import { AnthropicDiscoverer } from "./anthropic.js";
import { GoogleDiscoverer } from "./google.js";
import { OllamaDiscoverer } from "./ollama.js";
import { OpenAIDiscoverer } from "./openai.js";
import { OpenRouterDiscoverer } from "./openrouter.js";

/**
 * Returns all built-in provider discoverers.
 */
export function getAllDiscoverers(options?: { ollamaBaseUrl?: string }): ProviderDiscoverer[] {
	return [
		new AnthropicDiscoverer(),
		new OpenAIDiscoverer(),
		new GoogleDiscoverer(),
		new OllamaDiscoverer(options?.ollamaBaseUrl),
		new OpenRouterDiscoverer(),
	];
}

/**
 * Returns a single discoverer by provider ID, or undefined if not found.
 */
export function getDiscoverer(providerId: string, options?: { baseUrl?: string }): ProviderDiscoverer | undefined {
	const map: Record<string, () => ProviderDiscoverer> = {
		anthropic: () => new AnthropicDiscoverer(),
		openai: () => new OpenAIDiscoverer(),
		google: () => new GoogleDiscoverer(),
		ollama: () => new OllamaDiscoverer(options?.baseUrl),
		openrouter: () => new OpenRouterDiscoverer(),
	};
	return map[providerId]?.();
}

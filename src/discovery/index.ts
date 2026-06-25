export { AnthropicDiscoverer } from "./anthropic.js";
export { OpenAIDiscoverer } from "./openai.js";
export { GoogleDiscoverer } from "./google.js";
export { OllamaDiscoverer } from "./ollama.js";
export { LlamaCppDiscoverer } from "./llama-cpp.js";
export { LmStudioDiscoverer } from "./lmstudio.js";
export { VllmDiscoverer } from "./vllm.js";
export { OpenRouterDiscoverer } from "./openrouter.js";
export { VercelAIGatewayDiscoverer } from "./vercel.js";
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
export { DeepSeekDiscoverer } from "./deepseek.js";
export { MoonshotDiscoverer } from "./moonshot.js";
export { GLMDiscoverer } from "./glm.js";
export { ZAIDiscoverer } from "./zai.js";
export { MiniMaxDiscoverer } from "./minimax.js";
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
import { LlamaCppDiscoverer } from "./llama-cpp.js";
import { LmStudioDiscoverer } from "./lmstudio.js";
import { OllamaDiscoverer } from "./ollama.js";
import { VllmDiscoverer } from "./vllm.js";
import { OpenAIDiscoverer } from "./openai.js";
import { OpenRouterDiscoverer } from "./openrouter.js";
import { VercelAIGatewayDiscoverer } from "./vercel.js";
import { PerplexityDiscoverer } from "./perplexity.js";
import { TogetherDiscoverer } from "./together.js";
import { VertexDiscoverer } from "./vertex.js";
import { DeepSeekDiscoverer } from "./deepseek.js";
import { MoonshotDiscoverer } from "./moonshot.js";
import { GLMDiscoverer } from "./glm.js";
import { ZAIDiscoverer } from "./zai.js";
import { MiniMaxDiscoverer } from "./minimax.js";
import { normalizeProviderId } from "../provider-catalog.js";

/**
 * Single registry of all known provider discoverers.
 *
 * Adding a new provider only touches this map (plus the import + re-export
 * at the top of the file). Both {@link getAllDiscoverers} and
 * {@link getDiscoverer} derive from this single source of truth.
 */
type DiscovererFactory = (baseUrl?: string) => ProviderDiscoverer;

const DISCOVERER_REGISTRY: Record<string, DiscovererFactory> = {
	anthropic: () => new AnthropicDiscoverer(),
	openai: () => new OpenAIDiscoverer(),
	google: () => new GoogleDiscoverer(),
	ollama: (baseUrl) => new OllamaDiscoverer(baseUrl),
	"llama.cpp": (baseUrl) => new LlamaCppDiscoverer(baseUrl),
	lmstudio: (baseUrl) => new LmStudioDiscoverer(baseUrl),
	vllm: (baseUrl) => new VllmDiscoverer(baseUrl),
	openrouter: () => new OpenRouterDiscoverer(),
	vercel: () => new VercelAIGatewayDiscoverer(),
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
	deepseek: () => new DeepSeekDiscoverer(),
	moonshot: () => new MoonshotDiscoverer(),
	glm: () => new GLMDiscoverer(),
	zai: () => new ZAIDiscoverer(),
	minimax: () => new MiniMaxDiscoverer(),
};

/**
 * Returns all built-in provider discoverers.
 *
 * Includes direct-API providers (Anthropic, OpenAI, Google, Ollama, OpenRouter)
 * as well as managed-service proxies (AWS Bedrock, Google Vertex AI).
 */
export function getAllDiscoverers(options?: { ollamaBaseUrl?: string; llamaCppBaseUrl?: string }): ProviderDiscoverer[] {
	return Object.entries(DISCOVERER_REGISTRY).map(([id, factory]) => {
		if (id === "ollama") return factory(options?.ollamaBaseUrl);
		if (id === "llama.cpp") return factory(options?.llamaCppBaseUrl);
		return factory();
	});
}

/**
 * Returns a single discoverer by canonical provider ID, or undefined if not found.
 *
 * Supported IDs are the keys of {@link DISCOVERER_REGISTRY} — every provider
 * in the canonical catalog.
 */
export function getDiscoverer(providerId: string, options?: { baseUrl?: string }): ProviderDiscoverer | undefined {
	const id = normalizeProviderId(providerId) ?? providerId;
	return DISCOVERER_REGISTRY[id]?.(options?.baseUrl);
}

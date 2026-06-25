/**
 * LM Studio and vLLM discoverers — both speak OpenAI-compatible /v1/models.
 * Tests confirm normal-path discovery, graceful empty-result on missing
 * server, and provider catalog registration.
 */

import { afterEach, describe, expect, it } from "vitest";
import { LmStudioDiscoverer } from "../../src/discovery/lmstudio.js";
import { VllmDiscoverer } from "../../src/discovery/vllm.js";
import { getProviderDescriptor } from "../../src/provider-catalog.js";
import { mockFetch, mockFetchError, restoreFetch } from "./mock-server.js";

afterEach(() => restoreFetch());

describe("LmStudioDiscoverer", () => {
	it("normalizes the model id and tags the runtime family", async () => {
		mockFetch({
			"http://127.0.0.1:1234/v1/models": {
				status: 200,
				body: { object: "list", data: [{ id: "lmstudio-community/Llama-3.1-8B-Instruct-GGUF", object: "model" }] },
			},
		});
		const out = await new LmStudioDiscoverer().discover({ source: "none" }, { timeout: 500 });
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe("Llama-3.1-8B-Instruct-GGUF"); // path-style prefix stripped
		expect(out[0].localRuntime?.runtimeFamily).toBe("lmstudio");
		expect(out[0].localRuntime?.transport).toBe("openai-compatible-http");
	});

	it("returns [] when the server is unreachable", async () => {
		mockFetchError(new Error("ECONNREFUSED"));
		const out = await new LmStudioDiscoverer().discover({ source: "none" }, { timeout: 500 });
		expect(out).toEqual([]);
	});
});

describe("VllmDiscoverer", () => {
	it("captures max_model_len as the context window", async () => {
		mockFetch({
			"http://127.0.0.1:8000/v1/models": {
				status: 200,
				body: { object: "list", data: [{ id: "meta-llama/Llama-3-70b-Instruct", object: "model", max_model_len: 8192 }] },
			},
		});
		const out = await new VllmDiscoverer().discover({ source: "none" }, { timeout: 500 });
		expect(out).toHaveLength(1);
		expect(out[0].contextWindow).toBe(8192);
		expect(out[0].localRuntime?.runtimeFamily).toBe("vllm");
	});

	it("returns [] when the server is unreachable", async () => {
		mockFetchError(new Error("fetch failed"));
		const out = await new VllmDiscoverer().discover({ source: "none" }, { timeout: 500 });
		expect(out).toEqual([]);
	});
});

describe("provider-catalog: local runtimes", () => {
	it("lists lmstudio and vllm with loopback default base urls", () => {
		const lm = getProviderDescriptor("lmstudio");
		const vllm = getProviderDescriptor("vllm");
		expect(lm?.isLocal).toBe(true);
		expect(lm?.transport).toBe("openai-compatible-http");
		expect(new URL(lm!.defaultBaseUrl).hostname).toBe("127.0.0.1");
		expect(vllm?.isLocal).toBe(true);
		expect(new URL(vllm!.defaultBaseUrl).hostname).toBe("127.0.0.1");
	});
});

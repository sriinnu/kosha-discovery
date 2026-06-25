/**
 * Translator unit tests (pure functions) + proxy integration covering the
 * Anthropic wire format.
 */

import { describe, expect, it, vi } from "vitest";
import { translateAnthropicToOpenAI, translateOpenAIToAnthropic } from "../src/wire-anthropic.js";
import { createServer } from "../src/server.js";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

describe("translateOpenAIToAnthropic", () => {
	it("lifts system prompts to the top-level system field", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "You are kosha." },
				{ role: "user", content: "Hi" },
			],
		});
		expect(out.system).toBe("You are kosha.");
		expect(out.messages).toEqual([{ role: "user", content: "Hi" }]);
	});

	it("joins multiple system messages with a blank line", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [
				{ role: "system", content: "A" },
				{ role: "system", content: "B" },
				{ role: "user", content: "go" },
			],
		});
		expect(out.system).toBe("A\n\nB");
	});

	it("supplies a default max_tokens when the caller omits it", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(out.max_tokens).toBe(4096);
	});

	it("preserves sampling params and stop sequences", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 100,
			temperature: 0.3,
			top_p: 0.95,
			stop: ["END", "STOP"],
		});
		expect(out.max_tokens).toBe(100);
		expect(out.temperature).toBe(0.3);
		expect(out.top_p).toBe(0.95);
		expect(out.stop_sequences).toEqual(["END", "STOP"]);
	});

	it("flattens structured content blocks into a single string", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [{ role: "user", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] }],
		});
		expect(out.messages[0]).toEqual({ role: "user", content: "Hello world" });
	});

	it("inserts a placeholder user turn when the conversation doesn't start with one", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [{ role: "assistant", content: "I was first." }],
		});
		expect(out.messages[0].role).toBe("user");
		expect(out.messages[1].role).toBe("assistant");
	});
});

describe("translateAnthropicToOpenAI", () => {
	it("joins text content blocks and reflects token usage", () => {
		const out = translateAnthropicToOpenAI(
			{
				id: "msg_x",
				model: "claude-sonnet-4-6",
				role: "assistant",
				content: [
					{ type: "text", text: "Hello " },
					{ type: "text", text: "world." },
				],
				stop_reason: "end_turn",
				usage: { input_tokens: 12, output_tokens: 8 },
			},
			"claude-sonnet-4-6",
		);
		expect(out.choices[0].message.content).toBe("Hello world.");
		expect(out.choices[0].finish_reason).toBe("stop");
		expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 });
	});

	it("maps Anthropic stop reasons onto the OpenAI vocabulary", () => {
		const cases: Array<[string | null, string]> = [
			["end_turn", "stop"],
			["stop_sequence", "stop"],
			["max_tokens", "length"],
			["tool_use", "tool_calls"],
			["weird_unknown", "stop"],
			[null, "stop"],
		];
		for (const [reason, expected] of cases) {
			const out = translateAnthropicToOpenAI(
				{ id: "x", model: "y", role: "assistant", content: [{ type: "text", text: "" }], stop_reason: reason },
				"z",
			);
			expect(out.choices[0].finish_reason).toBe(expected);
		}
	});
});

describe("proxy: Anthropic translation end-to-end", () => {
	function anthropicRegistry() {
		const model: ModelCard = {
			id: "claude-sonnet-4-6",
			name: "claude-sonnet-4-6",
			provider: "anthropic",
			mode: "chat",
			capabilities: ["chat"],
			contextWindow: 200_000,
			maxOutputTokens: 8_192,
			aliases: [],
			discoveredAt: Date.now(),
			source: "manual",
			pricing: { inputPerMillion: 3, outputPerMillion: 15 },
		};
		const provider: ProviderInfo = {
			id: "anthropic",
			name: "Anthropic",
			baseUrl: "https://api.anthropic.com",
			authenticated: true,
			credentialSource: "env",
			models: [model],
			lastRefreshed: Date.now(),
		};
		return ModelRegistry.fromJSON({ providers: [provider], aliases: {}, discoveredAt: Date.now() });
	}

	it("forwards via /v1/messages with x-api-key and translates the JSON back", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					id: "msg_test",
					model: "claude-sonnet-4-6",
					role: "assistant",
					content: [{ type: "text", text: "Hi, kosha." }],
					stop_reason: "end_turn",
					usage: { input_tokens: 4, output_tokens: 5 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const app = createServer(anthropicRegistry());
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				messages: [
					{ role: "system", content: "You are kosha." },
					{ role: "user", content: "Say hi." },
				],
			}),
		});

		expect(res.status).toBe(200);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(String(url)).toContain("/v1/messages");
		const sentHeaders = new Headers(init?.headers);
		expect(sentHeaders.get("x-api-key")).toBe("sk-ant-test");
		expect(sentHeaders.get("anthropic-version")).toBe("2023-06-01");
		const sentBody = JSON.parse(String(init?.body));
		expect(sentBody.system).toBe("You are kosha.");
		expect(sentBody.messages).toEqual([{ role: "user", content: "Say hi." }]);

		const json = await res.json();
		expect(json.object).toBe("chat.completion");
		expect(json.choices[0].message.content).toBe("Hi, kosha.");
		expect(json.usage).toEqual({ prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 });
	});

	it("refuses streaming through the Anthropic translator with a 422", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const app = createServer(anthropicRegistry());
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			}),
		});
		expect(res.status).toBe(422);
		const json = await res.json();
		expect(json.error).toMatch(/streaming/);
	});
});

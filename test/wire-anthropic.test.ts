/**
 * Translator unit tests (pure functions) + proxy integration covering the
 * Anthropic wire format: request mapping, per-generation sampling / effort
 * rules, tools in both directions, images, structured output, SSE streaming.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	claudeSamplingSupport,
	claudeSupportsForcedToolChoice,
	claudeSupportsNativeJsonSchema,
	coerceOpenAIChatRequest,
	toOpenAIUsage,
	translateAnthropicStreamToOpenAI,
	translateAnthropicToOpenAI,
	translateOpenAIToAnthropic,
	translateOpenAIToAnthropicWithNotes,
	UnsupportedWireContentError,
} from "../src/wire-anthropic.js";
import { createServer } from "../src/server.js";
import { ModelRegistry } from "../src/registry.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

const originalFetch = globalThis.fetch;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Request translation — basics
// ---------------------------------------------------------------------------

describe("translateOpenAIToAnthropic", () => {
	it("lifts system (and developer) prompts to the top-level system field", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "system", content: "You are kosha." },
				{ role: "developer", content: "Be terse." },
				{ role: "user", content: "Hi" },
			],
		});
		expect(out.system).toBe("You are kosha.\n\nBe terse.");
		expect(out.messages).toEqual([{ role: "user", content: "Hi" }]);
	});

	it("supplies a default max_tokens and prefers max_completion_tokens when given", () => {
		expect(translateOpenAIToAnthropic({ model: "x", messages: [{ role: "user", content: "hi" }] }).max_tokens).toBe(4096);
		expect(
			translateOpenAIToAnthropic({
				model: "x",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 100,
				max_completion_tokens: 250,
			}).max_tokens,
		).toBe(250);
	});

	it("preserves sampling params and stop sequences on models that accept them", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-3-5-sonnet-20241022",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 100,
			temperature: 0.3,
			top_p: 0.95,
			stop: ["END", "STOP"],
		});
		expect(out.temperature).toBe(0.3);
		expect(out.top_p).toBe(0.95);
		expect(out.stop_sequences).toEqual(["END", "STOP"]);
	});

	it("flattens structured text blocks into a single string", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [{ role: "user", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] }],
		});
		expect(out.messages[0]).toEqual({ role: "user", content: "Hello world" });
	});

	it("inserts a NON-EMPTY placeholder user turn when the conversation doesn't start with one", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [{ role: "assistant", content: "I was first." }],
		});
		expect(out.messages[0].role).toBe("user");
		expect(typeof out.messages[0].content).toBe("string");
		expect((out.messages[0].content as string).length).toBeGreaterThan(0);
		expect(out.messages[1].role).toBe("assistant");

		const systemOnly = translateOpenAIToAnthropic({ model: "x", messages: [{ role: "system", content: "sys" }] });
		expect(systemOnly.messages).toHaveLength(1);
		expect((systemOnly.messages[0].content as string).length).toBeGreaterThan(0);
	});

	it("merges consecutive same-role messages (Anthropic forbids them)", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [
				{ role: "user", content: "alpha" },
				{ role: "user", content: "beta" },
				{ role: "assistant", content: "one" },
				{ role: "assistant", content: "two" },
				{ role: "user", content: "gamma" },
			],
		});
		expect(out.messages).toEqual([
			{ role: "user", content: "alpha\n\nbeta" },
			{ role: "assistant", content: "one\n\ntwo" },
			{ role: "user", content: "gamma" },
		]);
	});

	it("trims trailing whitespace from a final assistant turn (Anthropic rejects it)", () => {
		const out = translateOpenAIToAnthropic({
			model: "x",
			messages: [
				{ role: "user", content: "q" },
				{ role: "assistant", content: "The answer is:   \n" },
			],
		});
		expect(out.messages[1].content).toBe("The answer is:");
	});

	it("treats response_format text as a no-op", () => {
		expect(() =>
			translateOpenAIToAnthropic({
				model: "x",
				messages: [{ role: "user", content: "hi" }],
				response_format: { type: "text" },
			}),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Per-generation rules
// ---------------------------------------------------------------------------

describe("per-generation Claude behaviour", () => {
	it("classifies sampling support by generation", () => {
		expect(claudeSamplingSupport("claude-3-5-sonnet-20241022")).toBe("both");
		// Every Claude 4.x accepts at most one of temperature / top_p.
		expect(claudeSamplingSupport("claude-sonnet-4-20250514")).toBe("one");
		expect(claudeSamplingSupport("claude-opus-4-1")).toBe("one");
		expect(claudeSamplingSupport("claude-sonnet-4-5")).toBe("one");
		expect(claudeSamplingSupport("claude-haiku-4-5-20251001")).toBe("one");
		expect(claudeSamplingSupport("anthropic.claude-opus-4-8-v1:0")).toBe("none");
		expect(claudeSamplingSupport("claude-opus-4-6")).toBe("one");
		expect(claudeSamplingSupport("claude-sonnet-4.6")).toBe("one");
		expect(claudeSamplingSupport("claude-opus-4-7")).toBe("none");
		expect(claudeSamplingSupport("claude-opus-4-8")).toBe("none");
		expect(claudeSamplingSupport("claude-sonnet-5")).toBe("none");
		expect(claudeSamplingSupport("claude-opus-5")).toBe("none");
		expect(claudeSamplingSupport("claude-fable-5-1")).toBe("none");
		expect(claudeSamplingSupport("anthropic/claude-mythos-5-1")).toBe("none");
		expect(claudeSamplingSupport("not-a-claude")).toBe("both");
	});

	it("drops temperature / top_p on Opus 4.7+ and the Claude 5 family (they 400 otherwise)", () => {
		for (const model of ["claude-opus-4-8", "claude-sonnet-5", "claude-opus-5", "claude-fable-5-1"]) {
			const { request, notes } = translateOpenAIToAnthropicWithNotes({
				model,
				messages: [{ role: "user", content: "hi" }],
				temperature: 0.7,
				top_p: 0.9,
			});
			expect(request, model).not.toHaveProperty("temperature");
			expect(request, model).not.toHaveProperty("top_p");
			expect(notes.join(" ")).toMatch(/dropped temperature and top_p/);
		}
	});

	it("keeps only temperature on Opus / Sonnet 4.6 when both are sent", () => {
		const { request, notes } = translateOpenAIToAnthropicWithNotes({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "hi" }],
			temperature: 0.2,
			top_p: 0.9,
		});
		expect(request.temperature).toBe(0.2);
		expect(request).not.toHaveProperty("top_p");
		expect(notes.join(" ")).toMatch(/dropped top_p/);

		const onlyTopP = translateOpenAIToAnthropic({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "hi" }],
			top_p: 0.9,
		});
		expect(onlyTopP.top_p).toBe(0.9);
	});

	it("maps reasoning_effort onto output_config.effort and clamps to the generation's ladder", () => {
		const sonnet5 = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "hi" }],
			reasoning_effort: "xhigh",
		});
		expect(sonnet5.output_config).toEqual({ effort: "xhigh" });

		const minimal = translateOpenAIToAnthropic({
			model: "claude-opus-5",
			messages: [{ role: "user", content: "hi" }],
			reasoning_effort: "minimal",
		});
		expect(minimal.output_config).toEqual({ effort: "low" });

		const opus46 = translateOpenAIToAnthropicWithNotes({
			model: "claude-opus-4-6",
			messages: [{ role: "user", content: "hi" }],
			reasoning_effort: "xhigh",
		});
		expect(opus46.request.output_config).toEqual({ effort: "high" });
		expect(opus46.notes.join(" ")).toMatch(/clamped/);

		const legacy = translateOpenAIToAnthropicWithNotes({
			model: "claude-3-5-sonnet-20241022",
			messages: [{ role: "user", content: "hi" }],
			reasoning_effort: "high",
		});
		expect(legacy.request).not.toHaveProperty("output_config");
		expect(legacy.notes.join(" ")).toMatch(/does not support output_config.effort/);
	});

	it("only Opus 4.5 in the 4.5 generation accepts effort; Sonnet / Haiku 4.5 drop it", () => {
		for (const model of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
			const { request, notes } = translateOpenAIToAnthropicWithNotes({
				model,
				messages: [{ role: "user", content: "hi" }],
				reasoning_effort: "high",
			});
			expect(request, model).not.toHaveProperty("output_config");
			expect(notes.join(" ")).toMatch(/does not support output_config.effort/);
		}
		expect(
			translateOpenAIToAnthropic({ model: "claude-opus-4-5", messages: [{ role: "user", content: "hi" }], reasoning_effort: "xhigh" })
				.output_config,
		).toEqual({ effort: "high" });
	});

	it("clamps temperature into Anthropic's 0..1 range", () => {
		const { request, notes } = translateOpenAIToAnthropicWithNotes({
			model: "claude-sonnet-4-6",
			messages: [{ role: "user", content: "hi" }],
			temperature: 1.7,
		});
		expect(request.temperature).toBe(1);
		expect(notes.join(" ")).toMatch(/clamped temperature 1.7 to 1/);
	});

	it("appends a user turn instead of shipping a prefill to 4.6+ / after trailing tool_calls; drops an empty final assistant", () => {
		const prefill = translateOpenAIToAnthropicWithNotes({
			model: "claude-sonnet-4-6",
			messages: [
				{ role: "user", content: "q" },
				{ role: "assistant", content: "The answer is:" },
			],
		});
		expect(prefill.request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(prefill.notes.join(" ")).toMatch(/does not accept a trailing assistant/);

		// Prefill still allowed on older generations.
		const legacy = translateOpenAIToAnthropic({
			model: "claude-3-5-sonnet-20241022",
			messages: [
				{ role: "user", content: "q" },
				{ role: "assistant", content: "The answer is:  " },
			],
		});
		expect(legacy.messages[legacy.messages.length - 1]).toEqual({ role: "assistant", content: "The answer is:" });

		const trailingTool = translateOpenAIToAnthropicWithNotes({
			model: "claude-3-5-sonnet-20241022",
			messages: [
				{ role: "user", content: "q" },
				{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
			],
		});
		expect(trailingTool.request.messages[trailingTool.request.messages.length - 1].role).toBe("user");
		expect(trailingTool.notes.join(" ")).toMatch(/ended on tool_calls/);

		const empty = translateOpenAIToAnthropic({
			model: "x",
			messages: [
				{ role: "user", content: "q" },
				{ role: "assistant", content: "   \n" },
			],
		});
		expect(empty.messages).toEqual([{ role: "user", content: "q" }]);
	});

	it("drops empty stop sequences, strict on pre-structured-output generations, and reports unsupported fields", () => {
		const { request, notes } = translateOpenAIToAnthropicWithNotes({
			model: "claude-sonnet-4-20250514",
			messages: [{ role: "user", content: "hi" }],
			stop: ["", "  ", "END"],
			tools: [{ type: "function", function: { name: "f", strict: true, parameters: { type: "object", properties: {}, additionalProperties: false } } }],
			unsupportedFields: ["n", "seed"],
			user: "user-42",
		});
		expect(request.stop_sequences).toEqual(["END"]);
		expect(request.tools?.[0]).not.toHaveProperty("strict");
		expect(request.metadata).toEqual({ user_id: "user-42" });
		expect(notes.join(" ")).toMatch(/dropped strict on 1 tool/);
		expect(notes.join(" ")).toMatch(/dropped n, seed/);

		const kept = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "f", strict: true } }],
		});
		expect(kept.tools?.[0].strict).toBe(true);
	});

	it("keeps notes header-safe when caller strings are non-ASCII", () => {
		const { notes } = translateOpenAIToAnthropicWithNotes({
			model: "claude-fable-5-1",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "获取天气" } }],
			tool_choice: { type: "function", function: { name: "获取天气" } },
			reasoning_effort: "高",
		});
		for (const note of notes) expect(note, note).toMatch(/^[\x20-\x7e]*$/);
	});

	it("knows which generations have native JSON schema and forced tool choice", () => {
		expect(claudeSupportsNativeJsonSchema("claude-sonnet-5")).toBe(true);
		expect(claudeSupportsNativeJsonSchema("claude-haiku-4-5-20251001")).toBe(true);
		expect(claudeSupportsNativeJsonSchema("claude-opus-4-1")).toBe(true);
		expect(claudeSupportsNativeJsonSchema("claude-sonnet-4-20250514")).toBe(false);
		expect(claudeSupportsNativeJsonSchema("claude-3-5-sonnet-20241022")).toBe(false);
		expect(claudeSupportsForcedToolChoice("claude-opus-5")).toBe(true);
		expect(claudeSupportsForcedToolChoice("claude-fable-5")).toBe(true);
		expect(claudeSupportsForcedToolChoice("claude-fable-5-1")).toBe(false);
		expect(claudeSupportsForcedToolChoice("claude-mythos-5-1")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const weatherTool = {
	type: "function",
	function: {
		name: "get_weather",
		description: "Look up the weather",
		parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
	},
};

describe("translateOpenAIToAnthropic — tools", () => {
	it("translates function tools into Anthropic tool definitions", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "weather in Hyderabad?" }],
			tools: [weatherTool, { type: "function", function: { name: "noop" } }],
		});
		expect(out.tools).toEqual([
			{
				name: "get_weather",
				description: "Look up the weather",
				input_schema: weatherTool.function.parameters,
			},
			{ name: "noop", input_schema: { type: "object", properties: {} } },
		]);
		expect(out).not.toHaveProperty("tool_choice"); // auto is Anthropic's default
	});

	it("maps tool_choice: auto / none / required / named function", () => {
		const base = { model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }], tools: [weatherTool] };
		expect(translateOpenAIToAnthropic({ ...base, tool_choice: "auto" })).not.toHaveProperty("tool_choice");
		expect(translateOpenAIToAnthropic({ ...base, tool_choice: "none" }).tool_choice).toEqual({ type: "none" });
		expect(translateOpenAIToAnthropic({ ...base, tool_choice: "required" }).tool_choice).toEqual({ type: "any" });
		expect(
			translateOpenAIToAnthropic({ ...base, tool_choice: { type: "function", function: { name: "get_weather" } } }).tool_choice,
		).toEqual({ type: "tool", name: "get_weather" });
	});

	it("degrades forced tool_choice to auto + instruction on Fable / Mythos 5.1", () => {
		const { request, notes } = translateOpenAIToAnthropicWithNotes({
			model: "claude-fable-5-1",
			messages: [{ role: "user", content: "hi" }],
			tools: [weatherTool],
			tool_choice: { type: "function", function: { name: "get_weather" } },
		});
		expect(request.tool_choice).toEqual({ type: "auto" });
		expect(request.system).toMatch(/must respond by calling the tool `get_weather`/);
		expect(notes.join(" ")).toMatch(/rejects forced tool use/);
	});

	it("maps parallel_tool_calls: false onto disable_parallel_tool_use", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "hi" }],
			tools: [weatherTool],
			parallel_tool_calls: false,
		});
		expect(out.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
	});

	it("translates an assistant tool_calls turn and the following tool results", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [
				{ role: "user", content: "weather in two cities" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Hyderabad"}' } },
						{ id: "call_2", type: "function", function: { name: "get_weather", arguments: '{"city":"Chennai"}' } },
					],
				},
				{ role: "tool", tool_call_id: "call_1", content: "34C sunny" },
				{ role: "tool", tool_call_id: "call_2", content: "31C humid" },
			],
			tools: [weatherTool],
		});
		expect(out.messages).toEqual([
			{ role: "user", content: "weather in two cities" },
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Hyderabad" } },
					{ type: "tool_use", id: "call_2", name: "get_weather", input: { city: "Chennai" } },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "34C sunny" },
					{ type: "tool_result", tool_use_id: "call_2", content: "31C humid" },
				],
			},
		]);
	});

	it("keeps assistant text alongside tool_use blocks", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: "Checking.",
					tool_calls: [{ id: "c", type: "function", function: { name: "get_weather", arguments: "" } }],
				},
				{ role: "tool", tool_call_id: "c", content: "ok" },
			],
		});
		expect(out.messages[1].content).toEqual([
			{ type: "text", text: "Checking." },
			{ type: "tool_use", id: "c", name: "get_weather", input: {} },
		]);
	});

	it("throws for non-function tool types and malformed tool_calls", () => {
		expect(() =>
			translateOpenAIToAnthropic({
				model: "x",
				messages: [{ role: "user", content: "hi" }],
				tools: [{ type: "web_search_preview" }],
			}),
		).toThrow(/tools\[0\]/);
		expect(() =>
			translateOpenAIToAnthropic({
				model: "x",
				messages: [
					{ role: "user", content: "hi" },
					{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{not json" } }] },
				],
			}),
		).toThrow(UnsupportedWireContentError);
		expect(() =>
			translateOpenAIToAnthropic({
				model: "x",
				messages: [{ role: "tool", content: "orphan" }],
			}),
		).toThrow(/tool_call_id/);
	});
});

// ---------------------------------------------------------------------------
// Images + structured output
// ---------------------------------------------------------------------------

describe("translateOpenAIToAnthropic — images and response_format", () => {
	it("maps image_url parts to Anthropic image blocks (URL and base64 data URL)", () => {
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image_url", image_url: { url: "https://example.com/cat.png" } },
						{ type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
					],
				},
			],
		});
		expect(out.messages[0].content).toEqual([
			{ type: "text", text: "what is this?" },
			{ type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
			{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
		]);
	});

	it("still throws for audio parts and unsupported image media types, naming the block", () => {
		try {
			translateOpenAIToAnthropic({
				model: "x",
				messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "b64", format: "wav" } }] }],
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(UnsupportedWireContentError);
			expect((err as Error).message).toMatch(/input_audio/);
		}
		expect(() =>
			translateOpenAIToAnthropic({
				model: "x",
				messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/tiff;base64,AAAA" } }] }],
			}),
		).toThrow(/image\/tiff/);
	});

	it("maps response_format json_schema onto output_config.format on Claude 4.5+", () => {
		const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
		const out = translateOpenAIToAnthropic({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "hi" }],
			response_format: { type: "json_schema", json_schema: { name: "person", schema } },
		});
		expect(out.output_config).toEqual({ format: { type: "json_schema", schema } });
	});

	it("throws for json_schema on generations without native structured outputs", () => {
		expect(() =>
			translateOpenAIToAnthropic({
				model: "claude-3-5-sonnet-20241022",
				messages: [{ role: "user", content: "hi" }],
				response_format: { type: "json_schema", json_schema: { name: "thing", schema: {} } },
			}),
		).toThrow(UnsupportedWireContentError);
	});

	it("maps json_object onto a system instruction APPENDED after the caller's prompt", () => {
		const { request, notes } = translateOpenAIToAnthropicWithNotes({
			model: "claude-sonnet-5",
			messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
			response_format: { type: "json_object" },
		});
		expect(request.system?.startsWith("sys")).toBe(true);
		expect(request.system).toMatch(/single valid JSON object/);
		expect(notes.join(" ")).toMatch(/json_object/);
	});

	it("degrades forced tool_choice to auto when combined with json_schema output", () => {
		const { request, notes } = translateOpenAIToAnthropicWithNotes({
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "f" } }],
			tool_choice: "required",
			response_format: { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } },
		});
		expect(request.tool_choice).toEqual({ type: "auto" });
		expect(request.output_config?.format).toBeDefined();
		expect(notes.join(" ")).toMatch(/cannot be combined with response_format/);
	});
});

describe("coerceOpenAIChatRequest", () => {
	it("carries the new fields through the untyped boundary", () => {
		const req = coerceOpenAIChatRequest({
			model: "m",
			messages: [
				{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: "c", content: "r" },
			],
			max_completion_tokens: 50,
			stream: true,
			stream_options: { include_usage: true },
			parallel_tool_calls: false,
			reasoning_effort: "high",
		});
		expect(req.messages[0].tool_calls).toBeDefined();
		expect(req.messages[0].content).toBeNull();
		expect(req.messages[1].tool_call_id).toBe("c");
		expect(req.max_completion_tokens).toBe(50);
		expect(req.stream_options).toEqual({ include_usage: true });
		expect(req.parallel_tool_calls).toBe(false);
		expect(req.reasoning_effort).toBe("high");
	});

	it("records fields with no Anthropic equivalent instead of silently dropping them", () => {
		const req = coerceOpenAIChatRequest({ model: "m", messages: [], n: 3, seed: 7, logit_bias: { "1": 1 }, user: "u" });
		expect(req.unsupportedFields).toEqual(["n", "seed", "logit_bias"]);
		expect(req.user).toBe("u");
		expect(coerceOpenAIChatRequest({ model: "m", messages: [], n: 1 }).unsupportedFields).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

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
			["tool_use", "stop"], // no tool_use blocks in content → never dangle tool_calls
			["refusal", "content_filter"],
			["weird_unknown", "stop"],
			[null, "stop"],
		];
		for (const [reason, expected] of cases) {
			const out = translateAnthropicToOpenAI(
				{ id: "x", model: "y", role: "assistant", content: [{ type: "text", text: "" }], stop_reason: reason },
				"z",
			);
			expect(out.choices[0].finish_reason, String(reason)).toBe(expected);
		}
	});

	it("translates tool_use blocks into OpenAI tool_calls with finish_reason tool_calls", () => {
		const out = translateAnthropicToOpenAI(
			{
				id: "msg_t",
				model: "claude-sonnet-5",
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Hyderabad" } },
				],
				stop_reason: "tool_use",
				usage: { input_tokens: 3, output_tokens: 4 },
			},
			"claude-sonnet-5",
		);
		expect(out.choices[0].finish_reason).toBe("tool_calls");
		expect(out.choices[0].message.content).toBe("Let me check.");
		expect(out.choices[0].message.tool_calls).toEqual([
			{ id: "toolu_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Hyderabad"}' } },
		]);
	});

	it("uses content: null (not empty string) for a tool-calls-only turn", () => {
		const out = translateAnthropicToOpenAI(
			{
				id: "m",
				model: "y",
				role: "assistant",
				content: [{ type: "tool_use", id: "t", name: "f", input: {} }],
				stop_reason: "tool_use",
			},
			"y",
		);
		expect(out.choices[0].message.content).toBeNull();
		expect(out.choices[0].message.tool_calls).toHaveLength(1);
	});

	it("folds cache reads / writes into prompt_tokens and exposes cached_tokens", () => {
		expect(
			toOpenAIUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }),
		).toEqual({
			prompt_tokens: 1050,
			completion_tokens: 20,
			total_tokens: 1070,
			prompt_tokens_details: { cached_tokens: 900 },
		});
	});
});

// ---------------------------------------------------------------------------
// Streaming translation
// ---------------------------------------------------------------------------

function sse(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
	const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
	// Split into odd-sized chunks so the parser has to reassemble events.
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < text.length; i += 37) chunks.push(encoder.encode(text.slice(i, i + 37)));
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(c);
			controller.close();
		},
	});
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

function parseChunks(body: string): Array<Record<string, unknown> | "[DONE]"> {
	return body
		.split("\n\n")
		.filter((l) => l.startsWith("data:"))
		.map((l) => l.slice(5).trim())
		.map((d) => (d === "[DONE]" ? "[DONE]" : (JSON.parse(d) as Record<string, unknown>)));
}

describe("translateAnthropicStreamToOpenAI", () => {
	it("turns a text stream into chat.completion.chunk events ending in [DONE]", async () => {
		const upstream = sse([
			{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "ping" },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		]);
		const { stream, usage } = translateAnthropicStreamToOpenAI(upstream, "claude-sonnet-5", { includeUsage: true });
		const chunks = parseChunks(await readAll(stream));
		expect(chunks[chunks.length - 1]).toBe("[DONE]");
		const objs = chunks.filter((c): c is Record<string, unknown> => c !== "[DONE]");
		expect(objs.every((c) => c.object === "chat.completion.chunk" && c.id === "msg_1" && c.model === "claude-sonnet-5")).toBe(true);
		const deltas = objs.map((c) => (c.choices as Array<{ delta: Record<string, unknown>; finish_reason: string | null }>)[0]);
		expect(deltas[0].delta).toEqual({ role: "assistant", content: "" });
		expect(deltas.slice(1, 3).map((d) => d.delta.content).join("")).toBe("Hello");
		const finish = deltas.find((d) => d && d.finish_reason);
		expect(finish?.finish_reason).toBe("stop");
		const usageChunk = objs.find((c) => Array.isArray(c.choices) && (c.choices as unknown[]).length === 0);
		expect(usageChunk?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
		await expect(usage).resolves.toEqual({ input_tokens: 10, output_tokens: 5 });
	});

	it("streams tool_use blocks as incremental tool_calls with stable indexes", async () => {
		const upstream = sse([
			{ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 4 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "get_weather", input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Hyderabad"}' } },
			{ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_b", name: "get_weather", input: {} } },
			{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"city":"Chennai"}' } },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
			{ type: "message_stop" },
		]);
		const { stream } = translateAnthropicStreamToOpenAI(upstream, "m");
		const objs = parseChunks(await readAll(stream)).filter((c): c is Record<string, unknown> => c !== "[DONE]");
		const deltas = objs.map((c) => (c.choices as Array<{ delta: Record<string, unknown>; finish_reason: string | null }>)[0]);
		const toolDeltas = deltas.flatMap((d) => (d.delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []);
		// Announcement chunks carry id + name; argument chunks carry only the index + arguments.
		expect(toolDeltas[0]).toEqual({ index: 0, id: "toolu_a", type: "function", function: { name: "get_weather", arguments: "" } });
		const argsFor = (i: number) =>
			toolDeltas
				.filter((t) => t.index === i)
				.map((t) => (t.function as { arguments: string }).arguments)
				.join("");
		expect(JSON.parse(argsFor(0))).toEqual({ city: "Hyderabad" });
		expect(JSON.parse(argsFor(1))).toEqual({ city: "Chennai" });
		expect(deltas.find((d) => d.finish_reason)?.finish_reason).toBe("tool_calls");
	});

	it("closes a no-argument tool call with \"{}\" so SDKs can JSON.parse the arguments", async () => {
		const upstream = sse([
			{ type: "message_start", message: { id: "msg_e", usage: { input_tokens: 2 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_e", name: "get_time", input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		]);
		const { stream } = translateAnthropicStreamToOpenAI(upstream, "m");
		const objs = parseChunks(await readAll(stream)).filter((c): c is Record<string, unknown> => c !== "[DONE]");
		const args = objs
			.flatMap((c) => ((c.choices as Array<{ delta: { tool_calls?: Array<{ function: { arguments: string } }> } }>)[0]?.delta.tool_calls ?? []))
			.map((t) => t.function.arguments)
			.join("");
		expect(JSON.parse(args)).toEqual({});
	});

	it("ignores thinking / signature deltas and leaves text intact", async () => {
		const upstream = sse([
			{ type: "message_start", message: { id: "msg_t", usage: { input_tokens: 2 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "visible" } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } },
			{ type: "message_stop" },
		]);
		const { stream } = translateAnthropicStreamToOpenAI(upstream, "m");
		const body = await readAll(stream);
		expect(body).toContain('"content":"visible"');
		expect(body).not.toContain("hmm");
	});

	it("settles the usage promise (null) when the client cancels mid-stream", async () => {
		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":5}}}\n\n'),
				);
				// never closes — simulates a long-running upstream
			},
		});
		const { stream, usage } = translateAnthropicStreamToOpenAI(upstream, "m");
		const reader = stream.getReader();
		await reader.read();
		await reader.cancel();
		await expect(usage).resolves.toBeNull();
	});

	it("emits an error event then [DONE] when Anthropic streams an error", async () => {
		const upstream = sse([
			{ type: "message_start", message: { id: "msg_3", usage: { input_tokens: 1 } } },
			{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
		]);
		const { stream, usage } = translateAnthropicStreamToOpenAI(upstream, "m");
		const chunks = parseChunks(await readAll(stream));
		const errChunk = chunks.find((c) => c !== "[DONE]" && "error" in c) as Record<string, unknown>;
		expect(errChunk.error).toEqual({ message: "Overloaded", type: "overloaded_error" });
		expect(chunks[chunks.length - 1]).toBe("[DONE]");
		// The message never reached message_delta, so output tokens are unknown:
		// usage resolves null and the proxy keeps its pre-flight estimate.
		await expect(usage).resolves.toBeNull();
	});

	it("still closes cleanly with a finish chunk and [DONE] if the upstream ends early", async () => {
		const upstream = sse([
			{ type: "message_start", message: { id: "msg_4" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
		]);
		const { stream, usage } = translateAnthropicStreamToOpenAI(upstream, "m");
		const chunks = parseChunks(await readAll(stream));
		expect(chunks[chunks.length - 1]).toBe("[DONE]");
		const objs = chunks.filter((c): c is Record<string, unknown> => c !== "[DONE]");
		const finishes = objs.filter((c) => (c.choices as Array<{ finish_reason: string | null }>)[0]?.finish_reason);
		expect(finishes).toHaveLength(1);
		await expect(usage).resolves.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Proxy integration
// ---------------------------------------------------------------------------

describe("proxy: Anthropic translation end-to-end", () => {
	function anthropicRegistry(modelId = "claude-sonnet-4-6") {
		const model: ModelCard = {
			id: modelId,
			name: modelId,
			provider: "anthropic",
			mode: "chat",
			capabilities: ["chat"],
			contextWindow: 200_000,
			maxOutputTokens: 8_192,
			aliases: [],
			discoveredAt: Date.now(),
			source: "manual",
			pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 },
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

	it("forwards via /v1/messages with x-api-key and translates the JSON back, reconciling cost", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					id: "msg_test",
					model: "claude-sonnet-4-6",
					role: "assistant",
					content: [{ type: "text", text: "Hi, kosha." }],
					stop_reason: "end_turn",
					usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10000 },
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
		expect(json.usage).toEqual({
			prompt_tokens: 11000,
			completion_tokens: 100,
			total_tokens: 11100,
			prompt_tokens_details: { cached_tokens: 10000 },
		});
		// 1000 in × $3 + 100 out × $15 + 10000 cached × $0.3, per MTok.
		expect(Number(res.headers.get("x-kosha-actual-cost-usd"))).toBeCloseTo(0.003 + 0.0015 + 0.003, 9);
		expect(res.headers.get("x-kosha-usage-source")).toBe("upstream");
	});

	it("streams through the translator as OpenAI SSE and reflects wire notes", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const upstreamSse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_s","usage":{"input_tokens":5}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");
		const fetchMock = vi.fn(
			async () => new Response(upstreamSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const app = createServer(anthropicRegistry("claude-sonnet-5"));
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-5",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
				temperature: 0.7,
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
		expect(res.headers.get("x-kosha-wire-notes")).toMatch(/dropped temperature/);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const sent = JSON.parse(String(init?.body));
		expect(sent.stream).toBe(true);
		expect(sent).not.toHaveProperty("temperature");

		const body = await res.text();
		expect(body).toContain('"object":"chat.completion.chunk"');
		expect(body).toContain('"content":"Hi"');
		expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	it("re-shapes an Anthropic error body into the OpenAI error envelope", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;
		const app = createServer(anthropicRegistry());
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
		});
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: { message: "bad", type: "invalid_request_error", code: "400" } });
	});

	it("422s with the translator's reason when content can't be carried and no other route exists", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const app = createServer(anthropicRegistry());
		const res = await app.request("/proxy/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "x", format: "wav" } }] }],
			}),
		});
		expect(res.status).toBe(422);
		const json = await res.json();
		expect(json.error).toMatch(/input_audio/);
		expect(json.attemptChain).toContain("anthropic:unsupported-wire-content");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

/**
 * kosha-discovery — OpenAI ↔ Anthropic wire-format translator.
 *
 * The proxy accepts an OpenAI chat/completions request; Anthropic speaks
 * `/v1/messages`. This module bridges the two in both directions:
 *
 *   - **request**  system → top-level `system`; `tools` / `tool_choice` →
 *     Anthropic tools; assistant `tool_calls` → `tool_use` blocks; `tool`
 *     role → `tool_result` blocks; `image_url` parts → `image` blocks;
 *     `response_format: json_schema` → `output_config.format`;
 *     `reasoning_effort` → `output_config.effort`; sampling parameters are
 *     dropped on Claude generations that reject them.
 *   - **response** text + `tool_use` blocks → `message.content` +
 *     `tool_calls`; Anthropic usage (cache fields included) → OpenAI usage.
 *   - **stream**   Anthropic SSE events → OpenAI `chat.completion.chunk` SSE,
 *     with the final usage exposed to the caller for ledger reconciliation.
 *
 * Still unsupported — these throw {@link UnsupportedWireContentError} so the
 * proxy fails over to a native OpenAI-compatible route instead of shipping a
 * silently-mangled request: audio / file input parts, non-`function` tool
 * types, and `response_format: json_schema` on Claude generations without
 * native structured outputs.
 *
 * Pure functions; no I/O.
 * @module
 */

// ---------------------------------------------------------------------------
// OpenAI wire shapes (subset we understand)
// ---------------------------------------------------------------------------

/** One OpenAI tool call as it appears on an assistant message. */
export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

/** One OpenAI chat message. `content` may be null on tool-calling assistant turns. */
export interface OpenAIChatMessage {
	role: "system" | "developer" | "user" | "assistant" | "tool" | string;
	content: string | Array<unknown> | null;
	tool_calls?: unknown;
	tool_call_id?: string;
	name?: string;
}

/** Subset of the OpenAI chat-completions request body we know how to map. */
export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIChatMessage[];
	max_tokens?: number;
	/** Newer OpenAI spelling of `max_tokens`; wins when both are present. */
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	stream?: boolean;
	stream_options?: { include_usage?: boolean };
	tools?: unknown;
	tool_choice?: unknown;
	parallel_tool_calls?: boolean;
	response_format?: unknown;
	/** OpenAI reasoning effort: minimal | low | medium | high (| xhigh). */
	reasoning_effort?: string;
}

/** OpenAI usage block, including the cached-token detail OpenAI SDKs understand. */
export interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens: number };
}

/** OpenAI chat-completions response shape returned to the caller. */
export interface OpenAIChatResponse {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: Array<{
		index: 0;
		message: { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] };
		finish_reason: string;
	}>;
	usage?: OpenAIUsage;
}

// ---------------------------------------------------------------------------
// Anthropic wire shapes
// ---------------------------------------------------------------------------

export type AnthropicContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| { type: "tool_result"; tool_use_id: string; content?: string; is_error?: boolean };

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema: unknown;
	strict?: boolean;
}

export type AnthropicToolChoice =
	| { type: "auto" | "any" | "none"; disable_parallel_tool_use?: boolean }
	| { type: "tool"; name: string; disable_parallel_tool_use?: boolean };

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Anthropic /v1/messages request body. */
export interface AnthropicMessagesRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?: string;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	stream?: boolean;
	tools?: AnthropicTool[];
	tool_choice?: AnthropicToolChoice;
	output_config?: {
		effort?: AnthropicEffort;
		format?: { type: "json_schema"; schema: unknown };
	};
}

/** Anthropic usage block. `message_delta` events report `output_tokens` cumulatively. */
export interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

/** Subset of the Anthropic /v1/messages response we map back to OpenAI. */
export interface AnthropicMessagesResponse {
	id: string;
	model: string;
	role: "assistant";
	content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
	stop_reason: string | null;
	usage?: AnthropicUsage;
}

/** Result of translating a request: the Anthropic body plus human-readable notes about lossy mappings. */
export interface WireTranslation {
	request: AnthropicMessagesRequest;
	/** Each note describes one field kosha changed or dropped to satisfy the target model. */
	notes: string[];
}

/** Anthropic requires max_tokens; we cap at this when the caller didn't supply one. */
const DEFAULT_MAX_TOKENS = 4_096;

/**
 * Anthropic rejects empty message content, so when the conversation has no
 * user turn to open with (system-only request, assistant-first history) we
 * synthesize a minimal one.
 */
const PLACEHOLDER_USER_TEXT = "Continue.";

/** Image media types Anthropic accepts as base64 / URL image blocks. */
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Raised when an OpenAI chat-completions body carries wire features the
 * Anthropic translator cannot faithfully carry. The proxy catches this by
 * class and falls back to a native route rather than shipping a
 * silently-mangled request. Throwing beats silent data loss on the path
 * kosha:cheapest[…] resolves through here.
 */
export class UnsupportedWireContentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedWireContentError";
	}
}

// ---------------------------------------------------------------------------
// Per-generation Claude behaviour
// ---------------------------------------------------------------------------

interface ClaudeGeneration {
	family: string;
	major: number;
	minor: number;
}

/**
 * Parse the generation out of a family-first Claude ID (`claude-opus-4-8`,
 * `claude-sonnet-5`, `claude-fable-5-1`, dated `claude-haiku-4-5-20251001`,
 * dotted OpenRouter-style `claude-sonnet-4.6`). Legacy version-first IDs and
 * non-Claude IDs return `undefined` and are treated as "accepts everything".
 */
function parseClaudeGeneration(modelId: string): ClaudeGeneration | undefined {
	const id = modelId.toLowerCase().replace(/^.*\//, "").replace(/\./g, "-");
	// Minor is 1-2 digits so an 8-digit date suffix is never read as a minor.
	const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
	if (!m) return undefined;
	return { family: m[1], major: Number(m[2]), minor: m[3] !== undefined ? Number(m[3]) : 0 };
}

function atLeast(gen: ClaudeGeneration, major: number, minor: number): boolean {
	return gen.major > major || (gen.major === major && gen.minor >= minor);
}

/** How a Claude model treats `temperature` / `top_p`. */
export type SamplingSupport = "both" | "one" | "none";

/**
 * Sampling parameters were removed on Opus 4.7 and every later model (Opus
 * 4.8, Opus 5, Sonnet 5, Fable, Mythos): sending them returns a 400. Opus 4.6
 * and Sonnet 4.6 accept at most one of `temperature` / `top_p`. Older models
 * accept both.
 */
export function claudeSamplingSupport(modelId: string): SamplingSupport {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return "both";
	if (atLeast(gen, 4, 7)) return "none";
	if (atLeast(gen, 4, 6)) return "one";
	return "both";
}

/** Effort levels a generation accepts under `output_config.effort`; empty when effort is unsupported. */
function claudeEffortLadder(modelId: string): readonly AnthropicEffort[] {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return [];
	if (atLeast(gen, 4, 7)) return ["low", "medium", "high", "xhigh", "max"];
	if (atLeast(gen, 4, 6)) return ["low", "medium", "high", "max"];
	if (atLeast(gen, 4, 5)) return ["low", "medium", "high"];
	return [];
}

/**
 * Native JSON-schema structured outputs (`output_config.format`) shipped with
 * the 4.5 generation (Sonnet 4.5, Haiku 4.5, Opus 4.1) and every model since.
 */
export function claudeSupportsNativeJsonSchema(modelId: string): boolean {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return false;
	if (atLeast(gen, 4, 5)) return true;
	return gen.family === "opus" && gen.major === 4 && gen.minor === 1;
}

/**
 * Claude Fable 5.1 and Claude Mythos 5.1 return a 400 for forced tool use
 * (`tool_choice` `any` / `tool`); everything else still honours it.
 */
export function claudeSupportsForcedToolChoice(modelId: string): boolean {
	const gen = parseClaudeGeneration(modelId);
	if (!gen) return true;
	if (gen.family !== "fable" && gen.family !== "mythos") return true;
	return !atLeast(gen, 5, 1);
}

/** OpenAI `reasoning_effort` vocabulary → Anthropic effort levels. */
const EFFORT_MAP: Readonly<Record<string, AnthropicEffort>> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

// ---------------------------------------------------------------------------
// Request coercion (untyped JSON → OpenAIChatRequest)
// ---------------------------------------------------------------------------

/**
 * Narrow a parsed OpenAI chat-completions body (`Record<string, unknown>`) into
 * a typed {@link OpenAIChatRequest} via runtime guards. This is the single
 * untyped-JSON → typed boundary for the translator.
 */
export function coerceOpenAIChatRequest(body: Record<string, unknown>): OpenAIChatRequest {
	const messages: OpenAIChatMessage[] = [];
	const rawMessages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
	for (const entry of rawMessages) {
		if (!entry || typeof entry !== "object") continue;
		const msg = entry as Record<string, unknown>;
		const role = typeof msg.role === "string" ? msg.role : "user";
		const content: string | Array<unknown> | null = Array.isArray(msg.content)
			? msg.content
			: typeof msg.content === "string"
				? msg.content
				: null;
		const out: OpenAIChatMessage = { role, content };
		if (msg.tool_calls !== undefined) out.tool_calls = msg.tool_calls;
		if (typeof msg.tool_call_id === "string") out.tool_call_id = msg.tool_call_id;
		if (typeof msg.name === "string") out.name = msg.name;
		messages.push(out);
	}
	const req: OpenAIChatRequest = {
		model: typeof body.model === "string" ? body.model : "",
		messages,
	};
	if (typeof body.max_tokens === "number") req.max_tokens = body.max_tokens;
	if (typeof body.max_completion_tokens === "number") req.max_completion_tokens = body.max_completion_tokens;
	if (typeof body.temperature === "number") req.temperature = body.temperature;
	if (typeof body.top_p === "number") req.top_p = body.top_p;
	if (typeof body.stop === "string") req.stop = body.stop;
	else if (Array.isArray(body.stop)) req.stop = body.stop.filter((s): s is string => typeof s === "string");
	if (body.stream === true) req.stream = true;
	if (body.stream_options && typeof body.stream_options === "object") {
		req.stream_options = { include_usage: (body.stream_options as { include_usage?: unknown }).include_usage === true };
	}
	if (body.tools !== undefined) req.tools = body.tools;
	if (body.tool_choice !== undefined) req.tool_choice = body.tool_choice;
	if (typeof body.parallel_tool_calls === "boolean") req.parallel_tool_calls = body.parallel_tool_calls;
	if (body.response_format !== undefined) req.response_format = body.response_format;
	if (typeof body.reasoning_effort === "string") req.reasoning_effort = body.reasoning_effort;
	return req;
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

/** Translate an OpenAI chat-completions request body into an Anthropic /v1/messages body. */
export function translateOpenAIToAnthropic(req: OpenAIChatRequest): AnthropicMessagesRequest {
	return translateOpenAIToAnthropicWithNotes(req).request;
}

/**
 * Translate an OpenAI chat-completions request and report every lossy
 * mapping made along the way (dropped sampling params, degraded forced tool
 * choice, …). The proxy reflects the notes to the caller in a response
 * header so nothing kosha changed is invisible.
 */
export function translateOpenAIToAnthropicWithNotes(req: OpenAIChatRequest): WireTranslation {
	const notes: string[] = [];
	const systemParts: string[] = [];

	// Tools first: response_format / tool_choice handling below depends on them.
	const tools = req.tools !== undefined && req.tools !== null ? translateTools(req.tools) : undefined;
	let toolChoice = translateToolChoice(req.tool_choice, req.model, tools !== undefined, notes, systemParts);
	if (req.parallel_tool_calls === false && tools && tools.length > 0) {
		if (!toolChoice) toolChoice = { type: "auto" };
		if (toolChoice.type !== "none") toolChoice = { ...toolChoice, disable_parallel_tool_use: true };
	}

	const outputConfig: NonNullable<AnthropicMessagesRequest["output_config"]> = {};
	applyResponseFormat(req.response_format, req.model, outputConfig, systemParts, notes);
	applyEffort(req.reasoning_effort, req.model, outputConfig, notes);

	const messages: AnthropicMessage[] = [];
	for (const msg of req.messages ?? []) {
		switch (msg.role) {
			case "system":
			case "developer": {
				const text = flattenText(msg.content);
				if (text) systemParts.push(text);
				break;
			}
			case "tool": {
				if (!msg.tool_call_id) {
					throw new UnsupportedWireContentError("tool message is missing tool_call_id");
				}
				const text = flattenText(msg.content);
				const block: AnthropicContentBlock = { type: "tool_result", tool_use_id: msg.tool_call_id };
				if (text) block.content = text;
				messages.push({ role: "user", content: [block] });
				break;
			}
			case "assistant": {
				const blocks = assistantBlocks(msg);
				if (blocks.length === 0) break;
				messages.push({ role: "assistant", content: collapseTextOnly(blocks) });
				break;
			}
			default: {
				const blocks = userBlocks(msg.content);
				if (blocks.length === 0) break;
				messages.push({ role: "user", content: collapseTextOnly(blocks) });
			}
		}
	}

	// Anthropic's /v1/messages requires the conversation to start with a user
	// message — if the caller only sent a system prompt we synthesize one.
	if (messages.length === 0) {
		messages.push({ role: "user", content: PLACEHOLDER_USER_TEXT });
	} else if (messages[0].role !== "user") {
		messages.unshift({ role: "user", content: PLACEHOLDER_USER_TEXT });
	}

	// Anthropic forbids two messages with the same role in a row. The OpenAI
	// side allows it (e.g. multiple tool-result messages), so consecutive
	// same-role messages collapse into one.
	const collapsed = trimFinalAssistant(mergeConsecutiveRoles(messages));

	const maxTokens = req.max_completion_tokens ?? req.max_tokens;
	const out: AnthropicMessagesRequest = {
		model: req.model,
		max_tokens: maxTokens && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS,
		messages: collapsed,
	};
	if (systemParts.length > 0) out.system = systemParts.join("\n\n");
	applySampling(req, out, notes);
	if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
	if (req.stream) out.stream = true;
	if (tools && tools.length > 0) out.tools = tools;
	if (toolChoice) out.tool_choice = toolChoice;
	if (Object.keys(outputConfig).length > 0) out.output_config = outputConfig;
	return { request: out, notes };
}

/** Copy `temperature` / `top_p` subject to the target model's sampling rules. */
function applySampling(req: OpenAIChatRequest, out: AnthropicMessagesRequest, notes: string[]): void {
	const hasTemp = typeof req.temperature === "number";
	const hasTopP = typeof req.top_p === "number";
	if (!hasTemp && !hasTopP) return;
	const support = claudeSamplingSupport(req.model);
	if (support === "none") {
		const dropped = [hasTemp ? "temperature" : null, hasTopP ? "top_p" : null].filter(Boolean).join(" and ");
		notes.push(`dropped ${dropped}: ${req.model} does not accept sampling parameters`);
		return;
	}
	if (support === "one" && hasTemp && hasTopP) {
		out.temperature = req.temperature;
		notes.push(`dropped top_p: ${req.model} accepts only one of temperature / top_p; kept temperature`);
		return;
	}
	if (hasTemp) out.temperature = req.temperature;
	if (hasTopP) out.top_p = req.top_p;
}

/** Map OpenAI `reasoning_effort` onto `output_config.effort`, clamped to the model's ladder. */
function applyEffort(
	effort: string | undefined,
	modelId: string,
	outputConfig: NonNullable<AnthropicMessagesRequest["output_config"]>,
	notes: string[],
): void {
	if (!effort) return;
	const mapped = EFFORT_MAP[effort.toLowerCase()];
	if (!mapped) {
		notes.push(`dropped reasoning_effort '${effort}': unknown value`);
		return;
	}
	const ladder = claudeEffortLadder(modelId);
	if (ladder.length === 0) {
		notes.push(`dropped reasoning_effort: ${modelId} does not support output_config.effort`);
		return;
	}
	if (ladder.includes(mapped)) {
		outputConfig.effort = mapped;
		return;
	}
	// xhigh / max requested on a generation without that rung → nearest lower.
	const fallback: AnthropicEffort = mapped === "max" && ladder.includes("max") ? "max" : "high";
	outputConfig.effort = fallback;
	notes.push(`clamped reasoning_effort '${effort}' to '${fallback}': not available on ${modelId}`);
}

/** Translate `response_format`: json_schema → output_config.format; json_object → system instruction. */
function applyResponseFormat(
	fmt: unknown,
	modelId: string,
	outputConfig: NonNullable<AnthropicMessagesRequest["output_config"]>,
	systemParts: string[],
	notes: string[],
): void {
	if (!fmt || typeof fmt !== "object") return;
	const ftype = (fmt as { type?: unknown }).type;
	if (ftype === "json_schema") {
		if (!claudeSupportsNativeJsonSchema(modelId)) {
			throw new UnsupportedWireContentError(
				`response_format 'json_schema' is not supported on ${modelId} (no native structured outputs)`,
			);
		}
		const schema = (fmt as { json_schema?: { schema?: unknown } }).json_schema?.schema;
		if (!schema || typeof schema !== "object") {
			throw new UnsupportedWireContentError("response_format json_schema is missing json_schema.schema");
		}
		outputConfig.format = { type: "json_schema", schema };
		return;
	}
	if (ftype === "json_object") {
		// No native equivalent of OpenAI's schema-less JSON mode; the closest
		// faithful mapping is an explicit instruction, which is how OpenAI's
		// own docs recommend using json_object anyway.
		systemParts.push("Respond with a single valid JSON object and nothing else — no prose, no code fences.");
		notes.push("response_format json_object mapped to a system instruction (no native equivalent)");
	}
}

/** Translate OpenAI `tools` into Anthropic tool definitions. Only `function` tools are supported. */
function translateTools(tools: unknown): AnthropicTool[] {
	if (!Array.isArray(tools)) {
		throw new UnsupportedWireContentError("tools must be an array");
	}
	return tools.map((raw, index) => {
		const tool = raw as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown; strict?: unknown } };
		if (!tool || tool.type !== "function" || !tool.function || typeof tool.function.name !== "string") {
			throw new UnsupportedWireContentError(
				`tools[${index}]: only type "function" tools are supported by the Anthropic wire translator`,
			);
		}
		const out: AnthropicTool = {
			name: tool.function.name,
			input_schema:
				tool.function.parameters && typeof tool.function.parameters === "object"
					? tool.function.parameters
					: { type: "object", properties: {} },
		};
		if (typeof tool.function.description === "string") out.description = tool.function.description;
		if (tool.function.strict === true) out.strict = true;
		return out;
	});
}

/**
 * Translate OpenAI `tool_choice`. Forced modes (`required`, a named function)
 * degrade to `auto` plus a system instruction on models that reject forced
 * tool use, and the degradation is recorded in `notes`.
 */
function translateToolChoice(
	choice: unknown,
	modelId: string,
	hasTools: boolean,
	notes: string[],
	systemParts: string[],
): AnthropicToolChoice | undefined {
	if (choice === undefined || choice === null || choice === "auto") return undefined;
	if (!hasTools) return undefined; // OpenAI rejects this combination upstream anyway
	if (choice === "none") return { type: "none" };
	const forcedOk = claudeSupportsForcedToolChoice(modelId);
	if (choice === "required") {
		if (forcedOk) return { type: "any" };
		systemParts.push("You must respond by calling one of the provided tools.");
		notes.push(`tool_choice 'required' degraded to auto + instruction: ${modelId} rejects forced tool use`);
		return { type: "auto" };
	}
	if (typeof choice === "object") {
		const named = (choice as { type?: unknown; function?: { name?: unknown } }).function?.name;
		if ((choice as { type?: unknown }).type === "function" && typeof named === "string") {
			if (forcedOk) return { type: "tool", name: named };
			systemParts.push(`You must respond by calling the tool \`${named}\`.`);
			notes.push(`tool_choice '${named}' degraded to auto + instruction: ${modelId} rejects forced tool use`);
			return { type: "auto" };
		}
	}
	throw new UnsupportedWireContentError(`unsupported tool_choice value '${JSON.stringify(choice)}'`);
}

/** Assistant message → text + tool_use blocks. */
function assistantBlocks(msg: OpenAIChatMessage): AnthropicContentBlock[] {
	const blocks: AnthropicContentBlock[] = [];
	const text = flattenText(msg.content);
	if (text) blocks.push({ type: "text", text });
	if (msg.tool_calls !== undefined && msg.tool_calls !== null) {
		if (!Array.isArray(msg.tool_calls)) {
			throw new UnsupportedWireContentError("assistant.tool_calls must be an array");
		}
		msg.tool_calls.forEach((raw, index) => {
			const call = raw as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
			if (!call || typeof call.id !== "string" || !call.function || typeof call.function.name !== "string") {
				throw new UnsupportedWireContentError(`tool_calls[${index}] is missing id or function.name`);
			}
			blocks.push({
				type: "tool_use",
				id: call.id,
				name: call.function.name,
				input: parseToolArguments(call.function.arguments, index),
			});
		});
	}
	return blocks;
}

/** OpenAI carries tool arguments as a JSON string; Anthropic wants the object. */
function parseToolArguments(raw: unknown, index: number): unknown {
	if (raw === undefined || raw === null || raw === "") return {};
	if (typeof raw === "object") return raw;
	if (typeof raw !== "string") {
		throw new UnsupportedWireContentError(`tool_calls[${index}].function.arguments must be a JSON string`);
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		throw new UnsupportedWireContentError(`tool_calls[${index}].function.arguments is not valid JSON`);
	}
}

/** User message content → text / image blocks. Adjacent text parts are merged. */
function userBlocks(content: OpenAIChatMessage["content"]): AnthropicContentBlock[] {
	if (content === null || content === undefined) return [];
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	const blocks: AnthropicContentBlock[] = [];
	for (const part of content) {
		if (isTextPart(part)) {
			const text = typeof part === "string" ? part : (part as { text: string }).text;
			if (!text) continue;
			const tail = blocks[blocks.length - 1];
			if (tail && tail.type === "text") tail.text += text;
			else blocks.push({ type: "text", text });
			continue;
		}
		if (part && typeof part === "object" && (part as { type?: unknown }).type === "image_url") {
			blocks.push(imageBlock(part as { image_url?: unknown }));
			continue;
		}
		throw new UnsupportedWireContentError(
			`unsupported message content block '${describePartType(part)}' — text and image_url are carried across the Anthropic wire translator`,
		);
	}
	return blocks;
}

/** OpenAI `image_url` part → Anthropic `image` block (data: URLs become base64 sources). */
function imageBlock(part: { image_url?: unknown }): AnthropicContentBlock {
	const url =
		typeof part.image_url === "string"
			? part.image_url
			: part.image_url && typeof part.image_url === "object"
				? (part.image_url as { url?: unknown }).url
				: undefined;
	if (typeof url !== "string" || url.length === 0) {
		throw new UnsupportedWireContentError("image_url part is missing a url");
	}
	const dataUrl = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,(.+)$/is.exec(url);
	if (dataUrl) {
		const mediaType = dataUrl[1].toLowerCase();
		if (!IMAGE_MEDIA_TYPES.has(mediaType)) {
			throw new UnsupportedWireContentError(`image media type '${mediaType}' is not accepted by Anthropic`);
		}
		return { type: "image", source: { type: "base64", media_type: mediaType, data: dataUrl[2] } };
	}
	if (!/^https?:\/\//i.test(url)) {
		throw new UnsupportedWireContentError("image_url must be an http(s) URL or a base64 data: URL");
	}
	return { type: "image", source: { type: "url", url } };
}

/** A block list that is a single text block collapses to a plain string (keeps request bodies small and readable). */
function collapseTextOnly(blocks: AnthropicContentBlock[]): string | AnthropicContentBlock[] {
	if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
	return blocks;
}

/**
 * Collapse runs of consecutive same-role messages into one message per role
 * boundary. Plain strings join with a blank line so the boundary survives in
 * the rendered prompt; anything involving blocks becomes a block list.
 */
function mergeConsecutiveRoles(messages: AnthropicMessage[]): AnthropicMessage[] {
	const out: AnthropicMessage[] = [];
	for (const msg of messages) {
		const tail = out[out.length - 1];
		if (tail && tail.role === msg.role) {
			tail.content = concatContent(tail.content, msg.content);
		} else {
			out.push({ role: msg.role, content: msg.content });
		}
	}
	return out;
}

function concatContent(a: AnthropicMessage["content"], b: AnthropicMessage["content"]): AnthropicMessage["content"] {
	if (typeof a === "string" && typeof b === "string") {
		if (!a) return b;
		if (!b) return a;
		return `${a}\n\n${b}`;
	}
	return [...toBlocks(a), ...toBlocks(b)];
}

function toBlocks(content: AnthropicMessage["content"]): AnthropicContentBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return content;
}

/** Anthropic rejects trailing whitespace on a final assistant turn (prefill rules). */
function trimFinalAssistant(messages: AnthropicMessage[]): AnthropicMessage[] {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return messages;
	if (typeof last.content === "string") {
		last.content = last.content.trimEnd();
		return messages;
	}
	const tail = last.content[last.content.length - 1];
	if (tail && tail.type === "text") tail.text = tail.text.trimEnd();
	return messages;
}

/**
 * Coerce content into a flat string. Only plain-text parts survive: a
 * string, an explicit `{type:"text",text}` block, or an untyped `{text}`
 * block. Used for system / tool / assistant text where images make no sense.
 */
function flattenText(content: OpenAIChatMessage["content"]): string {
	if (content === null || content === undefined) return "";
	if (typeof content === "string") return content;
	const out: string[] = [];
	for (const part of content) {
		if (isTextPart(part)) {
			out.push(typeof part === "string" ? part : (part as { text: string }).text);
			continue;
		}
		throw new UnsupportedWireContentError(
			`unsupported message content block '${describePartType(part)}' — only plain text is allowed in this position`,
		);
	}
	return out.join("");
}

/** True for plain-text content parts: a string, {type:"text",text}, or untyped {text}. */
function isTextPart(part: unknown): boolean {
	if (typeof part === "string") return true;
	if (!part || typeof part !== "object") return false;
	const p = part as { type?: unknown; text?: unknown };
	if (p.type !== undefined && p.type !== "text") return false;
	return typeof p.text === "string";
}

/** Human-readable label for a content block, used in error messages. */
function describePartType(part: unknown): string {
	if (part && typeof part === "object" && "type" in part) {
		return String((part as { type?: unknown }).type ?? "unknown");
	}
	return typeof part;
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

/** Translate an Anthropic /v1/messages response back into OpenAI chat-completions shape. */
export function translateAnthropicToOpenAI(res: AnthropicMessagesResponse, originalModel: string): OpenAIChatResponse {
	const blocks = res.content ?? [];
	const text = blocks
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
	const toolCalls: OpenAIToolCall[] = blocks
		.filter((block) => block && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string")
		.map((block) => ({
			id: block.id as string,
			type: "function" as const,
			function: { name: block.name as string, arguments: JSON.stringify(block.input ?? {}) },
		}));

	const message: OpenAIChatResponse["choices"][number]["message"] = {
		role: "assistant",
		// OpenAI SDKs expect null (not "") when the turn is tool calls only.
		content: text.length > 0 ? text : toolCalls.length > 0 ? null : "",
	};
	if (toolCalls.length > 0) message.tool_calls = toolCalls;

	return {
		id: res.id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: originalModel,
		choices: [{ index: 0, message, finish_reason: mapStopReason(res.stop_reason, toolCalls.length > 0) }],
		usage: toOpenAIUsage(res.usage),
	};
}

/**
 * Anthropic usage → OpenAI usage. OpenAI's `prompt_tokens` counts every
 * input token including cached ones, so cache reads/writes fold into it;
 * the cached portion is echoed under `prompt_tokens_details.cached_tokens`
 * (only when non-zero, so responses without caching stay byte-compatible).
 */
export function toOpenAIUsage(usage: AnthropicUsage | undefined): OpenAIUsage {
	const input = usage?.input_tokens ?? 0;
	const output = usage?.output_tokens ?? 0;
	const cacheRead = usage?.cache_read_input_tokens ?? 0;
	const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
	const prompt = input + cacheRead + cacheWrite;
	const out: OpenAIUsage = { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output };
	if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
	return out;
}

/**
 * Map Anthropic stop reasons onto the OpenAI vocabulary. `tool_use` becomes
 * `tool_calls` only when a populated tool_calls array actually went out —
 * a dangling `tool_calls` signal makes agent SDKs loop. `refusal` (safety
 * classifier) maps to OpenAI's `content_filter`.
 */
function mapStopReason(reason: string | null, hasToolCalls = false): string {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return hasToolCalls ? "tool_calls" : "stop";
		case "refusal":
			return "content_filter";
		default:
			return "stop";
	}
}

// ---------------------------------------------------------------------------
// Streaming translation
// ---------------------------------------------------------------------------

/** A translated OpenAI SSE stream plus the upstream usage, resolved when the stream ends. */
export interface AnthropicStreamTranslation {
	stream: ReadableStream<Uint8Array>;
	/** Resolves once the stream finishes; `null` when Anthropic never reported usage. */
	usage: Promise<AnthropicUsage | null>;
}

/**
 * Translate an Anthropic `/v1/messages` SSE stream into OpenAI
 * `chat.completion.chunk` SSE.
 *
 * Event mapping:
 *   - `message_start`         → first chunk with `delta.role = "assistant"`; captures id + input usage
 *   - `content_block_start`   → for `tool_use` blocks, a chunk announcing `tool_calls[i].id/name`
 *   - `content_block_delta`   → `text_delta` → `delta.content`; `input_json_delta` → `tool_calls[i].function.arguments`
 *   - `message_delta`         → chunk with `finish_reason`; captures output usage
 *   - `message_stop`          → optional usage chunk (when `include_usage`), then `data: [DONE]`
 *   - `error`                 → `data: {"error": …}` then `[DONE]`
 *   - `ping`, `content_block_stop`, thinking deltas → ignored
 *
 * The stream is fault-tolerant: if the upstream closes without
 * `message_stop`, the finish chunk and `[DONE]` are still emitted so the
 * caller's SDK doesn't hang.
 */
export function translateAnthropicStreamToOpenAI(
	upstream: ReadableStream<Uint8Array>,
	originalModel: string,
	options: { includeUsage?: boolean } = {},
): AnthropicStreamTranslation {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let buffer = "";
	let id = `chatcmpl-${Date.now().toString(36)}`;
	const created = Math.floor(Date.now() / 1000);
	const usage: AnthropicUsage = {};
	let sawUsage = false;
	let stopReason: string | null = null;
	let roleSent = false;
	let finishSent = false;
	let done = false;
	const toolIndexByBlock = new Map<number, number>();
	let toolCount = 0;

	let resolveUsage!: (value: AnthropicUsage | null) => void;
	const usagePromise = new Promise<AnthropicUsage | null>((resolve) => {
		resolveUsage = resolve;
	});

	const encodeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): Uint8Array =>
		encoder.encode(
			`data: ${JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created,
				model: originalModel,
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})}\n\n`,
		);

	const mergeUsage = (src: unknown): void => {
		if (!src || typeof src !== "object") return;
		const u = src as Record<string, unknown>;
		for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
			if (typeof u[key] === "number") {
				usage[key] = u[key] as number;
				sawUsage = true;
			}
		}
	};

	const emitFinish = (controller: TransformStreamDefaultController<Uint8Array>): void => {
		if (finishSent) return;
		finishSent = true;
		if (!roleSent) {
			controller.enqueue(encodeChunk({ role: "assistant", content: "" }));
			roleSent = true;
		}
		controller.enqueue(encodeChunk({}, mapStopReason(stopReason, toolCount > 0)));
	};

	const emitDone = (controller: TransformStreamDefaultController<Uint8Array>): void => {
		if (done) return;
		done = true;
		emitFinish(controller);
		if (options.includeUsage) {
			controller.enqueue(
				encoder.encode(
					`data: ${JSON.stringify({
						id,
						object: "chat.completion.chunk",
						created,
						model: originalModel,
						choices: [],
						usage: toOpenAIUsage(usage),
					})}\n\n`,
				),
			);
		}
		controller.enqueue(encoder.encode("data: [DONE]\n\n"));
		resolveUsage(sawUsage ? { ...usage } : null);
	};

	const handleEvent = (evt: Record<string, unknown>, controller: TransformStreamDefaultController<Uint8Array>): void => {
		switch (evt.type) {
			case "message_start": {
				const message = evt.message as { id?: unknown; usage?: unknown } | undefined;
				if (message && typeof message.id === "string") id = message.id;
				mergeUsage(message?.usage);
				if (!roleSent) {
					controller.enqueue(encodeChunk({ role: "assistant", content: "" }));
					roleSent = true;
				}
				break;
			}
			case "content_block_start": {
				const block = evt.content_block as { type?: unknown; id?: unknown; name?: unknown } | undefined;
				if (block?.type === "tool_use" && typeof evt.index === "number") {
					const toolIndex = toolCount++;
					toolIndexByBlock.set(evt.index, toolIndex);
					controller.enqueue(
						encodeChunk({
							tool_calls: [
								{
									index: toolIndex,
									id: typeof block.id === "string" ? block.id : `call_${toolIndex}`,
									type: "function",
									function: { name: typeof block.name === "string" ? block.name : "", arguments: "" },
								},
							],
						}),
					);
				}
				break;
			}
			case "content_block_delta": {
				const delta = evt.delta as { type?: unknown; text?: unknown; partial_json?: unknown } | undefined;
				if (delta?.type === "text_delta" && typeof delta.text === "string") {
					controller.enqueue(encodeChunk({ content: delta.text }));
				} else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
					const toolIndex = typeof evt.index === "number" ? toolIndexByBlock.get(evt.index) : undefined;
					if (toolIndex !== undefined) {
						controller.enqueue(encodeChunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }));
					}
				}
				break;
			}
			case "message_delta": {
				const delta = evt.delta as { stop_reason?: unknown } | undefined;
				if (delta && typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
				mergeUsage(evt.usage);
				emitFinish(controller);
				break;
			}
			case "message_stop":
				emitDone(controller);
				break;
			case "error": {
				const err = evt.error as { message?: unknown; type?: unknown } | undefined;
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							error: {
								message: typeof err?.message === "string" ? err.message : "anthropic stream error",
								type: typeof err?.type === "string" ? err.type : "upstream_error",
							},
						})}\n\n`,
					),
				);
				emitDone(controller);
				break;
			}
			default:
				break; // ping, content_block_stop, thinking / signature deltas
		}
	};

	const drain = (controller: TransformStreamDefaultController<Uint8Array>, flushAll: boolean): void => {
		const parts = buffer.split(/\r?\n\r?\n/);
		buffer = flushAll ? "" : (parts.pop() ?? "");
		for (const part of parts) {
			const data = part
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data) continue;
			let evt: unknown;
			try {
				evt = JSON.parse(data);
			} catch {
				continue; // partial or malformed event — skip, never crash the stream
			}
			if (evt && typeof evt === "object" && !done) handleEvent(evt as Record<string, unknown>, controller);
		}
	};

	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform(bytes, controller) {
			buffer += decoder.decode(bytes, { stream: true });
			drain(controller, false);
		},
		flush(controller) {
			buffer += decoder.decode();
			drain(controller, true);
			emitDone(controller);
		},
	});

	return { stream: upstream.pipeThrough(transform), usage: usagePromise };
}

/**
 * kosha-discovery — OpenAI ↔ Anthropic wire-format translator.
 *
 * The proxy accepts an OpenAI chat/completions request and forwards it
 * verbatim, but Anthropic speaks a different wire format (`/v1/messages`).
 * This module bridges the two for the non-streaming chat path: system
 * messages move to a top-level field, every other role becomes an
 * Anthropic content block, and the response shape is translated back.
 *
 * Streaming and tool calls are not yet covered — callers can fall back to
 * a native OpenAI-compatible provider for those flows. The translator is a
 * pure function; no I/O.
 * @module
 */

/** Subset of the OpenAI chat-completions request body we know how to map. */
export interface OpenAIChatRequest {
	model: string;
	messages: Array<{ role: "system" | "user" | "assistant" | string; content: string | Array<unknown> }>;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	stream?: boolean;
	/** OpenAI tools spec — unsupported on the Anthropic text path (throws). */
	tools?: unknown;
	/** OpenAI tool_choice — unsupported on the Anthropic text path (throws). */
	tool_choice?: unknown;
	/** OpenAI response_format — json_object/json_schema throw; text is a no-op. */
	response_format?: unknown;
}

/** Anthropic /v1/messages request body. */
export interface AnthropicMessagesRequest {
	model: string;
	max_tokens: number;
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	system?: string;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	stream?: boolean;
}

/** Subset of the Anthropic /v1/messages response we map back to OpenAI. */
export interface AnthropicMessagesResponse {
	id: string;
	model: string;
	role: "assistant";
	content: Array<{ type: string; text?: string }>;
	stop_reason: string | null;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** OpenAI chat-completions response shape returned to the caller. */
export interface OpenAIChatResponse {
	id: string;
	object: "chat.completion";
	created: number;
	model: string;
	choices: Array<{
		index: 0;
		message: { role: "assistant"; content: string };
		finish_reason: string;
	}>;
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Anthropic requires max_tokens; we cap at this when the caller didn't supply one. */
const DEFAULT_MAX_TOKENS = 4_096;

/**
 * Raised when an OpenAI chat-completions body carries wire features the
 * Anthropic translator cannot faithfully carry — tools, tool_choice,
 * structured response_format (json_object/json_schema), or multimodal
 * message content (image_url, input_audio, …). The proxy catches this by
 * class name and falls back to a native route rather than shipping a
 * silently-mangled request. Throwing beats silent data loss on the path
 * kosha:cheapest[tool_use]/[vision] resolves through here.
 */
export class UnsupportedWireContentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedWireContentError";
	}
}

/**
 * Narrow a parsed OpenAI chat-completions body (`Record<string, unknown>`) into
 * a typed {@link OpenAIChatRequest} via runtime guards. This is the single
 * untyped-JSON → typed boundary for the translator — callers pass a parsed
 * request body straight through instead of an `as unknown as` escape hatch.
 * Multimodal content is carried as `Array<unknown>`; the translator then
 * throws {@link UnsupportedWireContentError} on it.
 */
export function coerceOpenAIChatRequest(body: Record<string, unknown>): OpenAIChatRequest {
	const messages: OpenAIChatRequest["messages"] = [];
	const rawMessages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
	for (const entry of rawMessages) {
		if (!entry || typeof entry !== "object") continue;
		const msg = entry as Record<string, unknown>;
		const role = typeof msg.role === "string" ? msg.role : "user";
		const content: string | Array<unknown> = Array.isArray(msg.content)
			? msg.content
			: typeof msg.content === "string"
				? msg.content
				: "";
		messages.push({ role, content });
	}
	const req: OpenAIChatRequest = {
		model: typeof body.model === "string" ? body.model : "",
		messages,
	};
	if (typeof body.max_tokens === "number") req.max_tokens = body.max_tokens;
	if (typeof body.temperature === "number") req.temperature = body.temperature;
	if (typeof body.top_p === "number") req.top_p = body.top_p;
	if (typeof body.stop === "string") req.stop = body.stop;
	else if (Array.isArray(body.stop)) req.stop = body.stop.filter((s): s is string => typeof s === "string");
	if (body.stream === true) req.stream = true;
	if (body.tools !== undefined) req.tools = body.tools;
	if (body.tool_choice !== undefined) req.tool_choice = body.tool_choice;
	if (body.response_format !== undefined) req.response_format = body.response_format;
	return req;
}

/** Translate an OpenAI chat-completions request body into an Anthropic /v1/messages body. */
export function translateOpenAIToAnthropic(req: OpenAIChatRequest): AnthropicMessagesRequest {
	// Fail safe, not silent: tools, tool_choice, and structured
	// response_format have no faithful Anthropic translation on this
	// non-streaming text path. Throw UnsupportedWireContentError (the proxy
	// catches it by class name) instead of dropping them and shipping a
	// request the caller never asked for. Partial translation would be a
	// lie, so we abort before touching the messages.
	if (req.tools !== undefined && req.tools !== null) {
		throw new UnsupportedWireContentError("tools are not supported by the Anthropic wire translator");
	}
	if (req.tool_choice !== undefined && req.tool_choice !== null) {
		throw new UnsupportedWireContentError("tool_choice is not supported by the Anthropic wire translator");
	}
	const fmt = req.response_format;
	if (fmt && typeof fmt === "object") {
		const ftype = (fmt as { type?: unknown }).type;
		if (ftype === "json_object" || ftype === "json_schema") {
			throw new UnsupportedWireContentError(
				`response_format '${ftype}' is not supported by the Anthropic wire translator`,
			);
		}
	}

	const systemParts: string[] = [];
	const messages: AnthropicMessagesRequest["messages"] = [];

	for (const msg of req.messages ?? []) {
		const content = flattenContent(msg.content);
		if (!content) continue;
		if (msg.role === "system") {
			systemParts.push(content);
			continue;
		}
		const role = msg.role === "assistant" ? "assistant" : "user";
		messages.push({ role, content });
	}

	// Anthropic's /v1/messages requires the conversation to start with a user
	// message — if the caller only sent a system prompt we synthesize one.
	if (messages.length === 0) {
		messages.push({ role: "user", content: "" });
	} else if (messages[0].role !== "user") {
		messages.unshift({ role: "user", content: "" });
	}

	// Anthropic also forbids two messages with the same role in a row. The
	// OpenAI side allows it (e.g. multiple tool-result messages), so we
	// collapse consecutive same-role messages into a single message whose
	// content is the parts joined with a blank line.
	const collapsed = mergeConsecutiveRoles(messages);

	const out: AnthropicMessagesRequest = {
		model: req.model,
		max_tokens: req.max_tokens && req.max_tokens > 0 ? req.max_tokens : DEFAULT_MAX_TOKENS,
		messages: collapsed,
	};
	if (systemParts.length > 0) out.system = systemParts.join("\n\n");
	if (typeof req.temperature === "number") out.temperature = req.temperature;
	if (typeof req.top_p === "number") out.top_p = req.top_p;
	if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
	if (req.stream) out.stream = true;
	return out;
}

/** Translate an Anthropic /v1/messages response back into OpenAI chat-completions shape. */
export function translateAnthropicToOpenAI(res: AnthropicMessagesResponse, originalModel: string): OpenAIChatResponse {
	const text = (res.content ?? [])
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");

	// Anthropic tool_use blocks are NOT translated into OpenAI tool_calls
	// here today. Surface that honestly: never emit finish_reason:"tool_calls"
	// without a populated tool_calls array — agent SDKs loop/throw on that
	// dangling signal. When real tool_calls translation lands, flip this to
	// whether any tool_use block was actually carried across.
	const hasToolCalls = false;

	const inputTokens = res.usage?.input_tokens ?? 0;
	const outputTokens = res.usage?.output_tokens ?? 0;

	return {
		id: res.id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: originalModel,
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: text },
				finish_reason: mapStopReason(res.stop_reason, hasToolCalls),
			},
		],
		usage: {
			prompt_tokens: inputTokens,
			completion_tokens: outputTokens,
			total_tokens: inputTokens + outputTokens,
		},
	};
}

/**
 * Collapse runs of consecutive same-role messages into one message per role
 * boundary. Content is joined with a blank line so the boundary survives in
 * the rendered prompt. Anthropic rejects same-role-in-a-row, so this is a
 * correctness fix for things like OpenAI tool-result runs.
 */
function mergeConsecutiveRoles(
	messages: AnthropicMessagesRequest["messages"],
): AnthropicMessagesRequest["messages"] {
	const out: AnthropicMessagesRequest["messages"] = [];
	for (const msg of messages) {
		const tail = out[out.length - 1];
		if (tail && tail.role === msg.role) {
			tail.content = tail.content ? `${tail.content}\n\n${msg.content}` : msg.content;
		} else {
			out.push({ ...msg });
		}
	}
	return out;
}

/**
 * Coerce structured content blocks into a flat string for Anthropic's
 * content field. Only plain-text parts survive: a string, an explicit
 * `{type:"text",text}` block, or an untyped `{text}` block. Multimodal
 * parts (image_url, input_audio, …) have no Anthropic text equivalent —
 * throwing here is intentional, so the proxy can fall back instead of
 * shipping a prompt with the picture silently stripped.
 */
function flattenContent(content: OpenAIChatRequest["messages"][number]["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const part of content) {
		if (isTextPart(part)) {
			out.push(typeof part === "string" ? part : (part as { text: string }).text);
			continue;
		}
		throw new UnsupportedWireContentError(
			`unsupported message content block '${describePartType(part)}' — only plain text is carried across the Anthropic wire translator`,
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

/**
 * Map Anthropic stop reasons onto the OpenAI vocabulary. Anything unknown is
 * "stop". A tool_use stop reason only becomes "tool_calls" when the caller
 * actually emitted a populated tool_calls array — otherwise we collapse it to
 * "stop" rather than dangle a tool_calls signal that makes agent SDKs loop.
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
		default:
			return "stop";
	}
}

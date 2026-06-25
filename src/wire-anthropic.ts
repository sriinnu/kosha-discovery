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

/** Translate an OpenAI chat-completions request body into an Anthropic /v1/messages body. */
export function translateOpenAIToAnthropic(req: OpenAIChatRequest): AnthropicMessagesRequest {
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
				finish_reason: mapStopReason(res.stop_reason),
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

/** Coerce structured content blocks into a flat string for Anthropic's content field. */
function flattenContent(content: OpenAIChatRequest["messages"][number]["content"]): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const part of content) {
		if (typeof part === "string") out.push(part);
		else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
			out.push((part as { text: string }).text);
		}
	}
	return out.join("");
}

/** Map Anthropic stop reasons onto the OpenAI vocabulary. Anything unknown is "stop". */
function mapStopReason(reason: string | null): string {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "tool_calls";
		default:
			return "stop";
	}
}

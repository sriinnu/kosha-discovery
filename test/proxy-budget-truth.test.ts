/**
 * The budget counts what was really spent and fails closed: streamed requests
 * report real usage, a budget kosha can't parse refuses instead of vanishing,
 * a $0 budget still lets free routes run, and leaving off the tenant tag
 * doesn't skip a tenant cap.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateRequestCost, isRequestRow, type LedgerEntry } from "../src/cost.js";
import { ModelRegistry } from "../src/registry.js";
import { createServer } from "../src/server.js";
import type { ModelCard, ProviderInfo } from "../src/types.js";

function model(id: string, provider: string, pricing = { inputPerMillion: 1, outputPerMillion: 2 }): ModelCard {
	return {
		id,
		name: id,
		provider,
		mode: "chat",
		capabilities: ["chat"],
		contextWindow: 128_000,
		maxOutputTokens: 8_192,
		aliases: [],
		discoveredAt: Date.now(),
		source: "manual",
		pricing,
	};
}

function provider(id: string, models: ModelCard[], baseUrl: string): ProviderInfo {
	return { id, name: id, baseUrl, authenticated: true, credentialSource: "env", models, lastRefreshed: Date.now() };
}

function groqApp() {
	process.env.GROQ_API_KEY = "g-test";
	return createServer(
		ModelRegistry.fromJSON({
			providers: [provider("groq", [model("llama-cheap", "groq")], "https://api.groq.com/openai/v1")],
			aliases: {},
			discoveredAt: Date.now(),
		}),
	);
}

function post(
	app: ReturnType<typeof createServer>,
	body: Record<string, unknown>,
	headers: Record<string, string> = {},
) {
	return app.request("/proxy/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

let ledgerDir: string;
const ENV = ["GROQ_API_KEY", "KOSHA_MONTHLY_BUDGET_USD", "KOSHA_TENANT_BUDGET_USD", "KOSHA_LEDGER_PATH"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

beforeEach(() => {
	ledgerDir = mkdtempSync(join(tmpdir(), "kosha-budget-truth-"));
	process.env.KOSHA_LEDGER_PATH = join(ledgerDir, "ledger.jsonl");
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
	for (const k of ENV) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(ledgerDir, { recursive: true, force: true });
});

async function ledgerRows(): Promise<LedgerEntry[]> {
	const d = new Date();
	const file = join(ledgerDir, `ledger-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`);
	const raw = await readFile(file, "utf-8").catch(() => "");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as LedgerEntry);
}

const SSE_WITH_USAGE =
	'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
	'data: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":30}}\n\n' +
	"data: [DONE]\n\n";

describe("streamed requests report real usage", () => {
	it("asks upstream for usage, reconciles the ledger, and hides the usage chunk from a caller who didn't ask", async () => {
		const fetchMock = vi.fn(
			async () => new Response(SSE_WITH_USAGE, { status: 200, headers: { "content-type": "text/event-stream" } }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const res = await post(groqApp(), {
			model: "llama-cheap",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('"content":"hi"');
		expect(text).toContain("[DONE]");
		expect(text).not.toContain("prompt_tokens");

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const sent = JSON.parse(String(init.body));
		expect(sent.stream_options).toEqual({ include_usage: true });

		await vi.waitFor(async () => {
			const rows = await ledgerRows();
			expect(rows.find((r) => !isRequestRow(r))).toMatchObject({ actualInputTokens: 300, actualOutputTokens: 30 });
		});
	});

	it("passes the usage chunk through when the caller asked for it", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(SSE_WITH_USAGE, { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as unknown as typeof fetch;
		const res = await post(groqApp(), {
			model: "llama-cheap",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(await res.text()).toBe(SSE_WITH_USAGE);
	});

	it("retries once without stream_options when the provider refuses it with a 400", async () => {
		const bodies: Record<string, unknown>[] = [];
		globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
			const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
			bodies.push(sent);
			if (sent.stream_options) return new Response('{"error":"unknown field stream_options"}', { status: 400 });
			return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;
		const res = await post(groqApp(), {
			model: "llama-cheap",
			messages: [{ role: "user", content: "hi" }],
			stream: true,
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('"content":"ok"');
		expect(bodies).toHaveLength(2);
		expect(bodies[1].stream_options).toBeUndefined();
	});
});

describe("the estimate counts what agent traffic sends", () => {
	it("charges for tool definitions, earlier tool-call arguments and images", () => {
		const m = model("x", "groq", { inputPerMillion: 1_000_000, outputPerMillion: 0 });
		const plain = estimateRequestCost(m, { messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
		const agent = estimateRequestCost(m, {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "hi" },
						{ type: "image_url", image_url: { url: "data:," } },
					],
				},
				{ role: "assistant", tool_calls: [{ function: { name: "f", arguments: "x".repeat(3500) } }] },
			],
			tools: [{ type: "function", function: { name: "f", description: "y".repeat(3500) } }],
			max_tokens: 1,
		});
		expect(plain?.inputTokens).toBe(1);
		// 1 + 1000 (args) + ~1000 (tools) + 800 (image)
		expect(agent?.inputTokens).toBeGreaterThan(2_700);
	});
});

describe("budget env vars fail closed", () => {
	it("refuses with 503 and forwards nothing when the budget doesn't parse", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "$50";
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const res = await post(groqApp(), { model: "llama-cheap", messages: [{ role: "user", content: "hi" }] });
		expect(res.status).toBe(503);
		expect(JSON.stringify(await res.json())).toContain("not a dollar amount");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("treats a $0 budget as 'nothing paid', and still runs a local model", async () => {
		process.env.KOSHA_MONTHLY_BUDGET_USD = "0";
		process.env.GROQ_API_KEY = "g-test";
		const app = createServer(
			ModelRegistry.fromJSON({
				providers: [
					provider("groq", [model("llama-cheap", "groq")], "https://api.groq.com/openai/v1"),
					provider(
						"ollama",
						[model("llama3", "ollama", { inputPerMillion: 0, outputPerMillion: 0 })],
						"http://127.0.0.1:11434",
					),
				],
				aliases: {},
				discoveredAt: Date.now(),
			}),
		);
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ id: "x", choices: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const paid = await post(app, { model: "llama-cheap", messages: [{ role: "user", content: "hi" }] });
		expect(paid.status).toBe(429);
		expect(fetchMock).not.toHaveBeenCalled();

		const local = await post(app, { model: "llama3", messages: [{ role: "user", content: "hi" }] });
		expect(local.status).toBe(200);
		expect(new URL(String((fetchMock.mock.calls[0] as unknown[])[0])).hostname).toBe("127.0.0.1");
	});

	it("applies a tenant cap to requests that carry no tenant tag", async () => {
		process.env.KOSHA_TENANT_BUDGET_USD = "0.000001";
		globalThis.fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		) as unknown as typeof fetch;
		const res = await post(groqApp(), { model: "llama-cheap", messages: [{ role: "user", content: "hi" }] });
		expect(res.status).toBe(429);
	});
});

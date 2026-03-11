/**
 * kosha-discovery — Additive v1 discovery HTTP routes.
 *
 * I keep the daemon-oriented routes separate from the legacy REST surface so
 * the old API can stay stable while Chitragupta moves to the new contract.
 * @module
 */

import type { Hono } from "hono";
import type { ModelRegistry } from "./registry.js";

/**
 * Register additive discovery-plane routes on the existing Hono app.
 */
export function registerDiscoveryRoutes(app: Hono, registry: ModelRegistry): void {
	app.get("/api/discovery", (ctx) => {
		return ctx.json(registry.discoverySnapshot());
	});

	app.get("/api/discovery/delta", (ctx) => {
		const sinceCursor = ctx.req.query("sinceCursor") ?? ctx.req.query("changedSince") ?? null;
		return ctx.json(registry.discoveryDelta({ sinceCursor }));
	});

	app.get("/api/discovery/cheapest", (ctx) => {
		return ctx.json(readBindingQuery(registry, ctx.req.query.bind(ctx.req)));
	});

	app.get("/api/discovery/binding", (ctx) => {
		return ctx.json(registry.executionBindingHints(readBindingQueryInput(ctx.req.query.bind(ctx.req))));
	});

	app.get("/api/discovery/watch", (ctx) => {
		const sinceCursor = ctx.req.query("sinceCursor") ?? ctx.req.query("changedSince") ?? null;
		const stream = streamDiscoveryEvents(registry, sinceCursor, ctx.req.raw.signal);
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
			},
		});
	});
}

function readBindingQuery(
	registry: ModelRegistry,
	query: (key: string) => string | undefined,
): ReturnType<ModelRegistry["cheapestCandidates"]> {
	return registry.cheapestCandidates(readBindingQueryInput(query));
}

function readBindingQueryInput(query: (key: string) => string | undefined) {
	return {
		role: query("role") ?? undefined,
		capability: query("capability") ?? undefined,
		provider: query("provider") ?? undefined,
		originProvider: query("originProvider") ?? undefined,
		mode: query("mode") ?? undefined,
		limit: parseNumber(query("limit")),
		priceMetric: query("priceMetric") ?? undefined,
		preferLocalProviders: parseBoolean(query("preferLocalProviders")),
		allowCrossProvider: parseBoolean(query("allowCrossProvider")),
	};
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function streamDiscoveryEvents(
	registry: ModelRegistry,
	sinceCursor: string | null,
	signal: AbortSignal,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = registry.watchDiscovery({ sinceCursor });

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const abort = async () => {
				await iterator.return?.();
				controller.close();
			};

			signal.addEventListener("abort", abort, { once: true });
			try {
				for await (const delta of iterator) {
					const payload = `event: delta\ndata: ${JSON.stringify(delta)}\n\n`;
					controller.enqueue(encoder.encode(payload));
				}
			} catch (error) {
				const payload = `event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`;
				controller.enqueue(encoder.encode(payload));
				controller.close();
			} finally {
				signal.removeEventListener("abort", abort);
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

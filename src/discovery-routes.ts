/**
 * kosha-discovery — Additive v1 discovery HTTP routes.
 *
 * I keep the daemon-oriented routes separate from the legacy REST surface so
 * the old API can stay stable while Chitragupta moves to the new contract.
 * @module
 */

import type { Hono } from "hono";
import type { DiscoveryBindingQuery } from "./discovery-contract.js";
import type { ModelRegistry } from "./registry.js";

/**
 * Allowed values for the {@link DiscoveryBindingQuery.mode} query parameter.
 *
 * Duplicated locally rather than imported from `server.ts` so the discovery
 * plane stays self-contained; the canonical `ModelMode` union lives in
 * `types.ts` and these strings must stay in sync with it.
 */
const DISCOVERY_MODEL_MODES = ["chat", "embedding", "image", "video", "audio", "moderation", "rerank"] as const;

/** Allowed values for the {@link DiscoveryBindingQuery.priceMetric} query parameter. */
const DISCOVERY_PRICE_METRICS = ["input", "output", "blended"] as const;

/** Allowed values for boolean query parameters. */
const DISCOVERY_BOOLEAN_VALUES = ["true", "false"] as const;

/**
 * Structured 400 payload for a query parameter that was present but could not
 * be parsed. `allowedValues` is populated for enum-typed parameters so callers
 * can self-correct without reading the docs.
 */
export interface DiscoveryQueryError {
	param: string;
	allowedValues?: readonly string[];
}

/** Discriminated result of parsing a discovery binding query off the URL. */
type BindingQueryParseResult = { ok: true; input: DiscoveryBindingQuery } | { ok: false; error: DiscoveryQueryError };

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
		const parsed = parseBindingQuery(ctx.req.query.bind(ctx.req));
		if (!parsed.ok) return invalidQueryResponse(ctx, parsed.error);
		return ctx.json(registry.cheapestCandidates(parsed.input));
	});

	app.get("/api/discovery/binding", (ctx) => {
		const parsed = parseBindingQuery(ctx.req.query.bind(ctx.req));
		if (!parsed.ok) return invalidQueryResponse(ctx, parsed.error);
		return ctx.json(registry.executionBindingHints(parsed.input));
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

/**
 * Render a {@link DiscoveryQueryError} as a 400 JSON response.
 *
 * The body shape is `{ error, param, allowedValues? }` — the param name is
 * always echoed so the caller can pin down which input was rejected.
 */
function invalidQueryResponse(
	ctx: { json: (body: unknown, status: number) => Response },
	error: DiscoveryQueryError,
): Response {
	const body: { error: string; param: string; allowedValues?: readonly string[] } = {
		error: `Invalid query parameter '${error.param}'.`,
		param: error.param,
	};
	if (error.allowedValues) body.allowedValues = error.allowedValues;
	return ctx.json(body, 400);
}

/**
 * Read a {@link DiscoveryBindingQuery} off the raw query accessor.
 *
 * ABSENT params (key not in the URL) collapse to `undefined` and apply no
 * filter — identical to the historical behavior. PRESENT-BUT-INVALID params
 * (e.g. `?limit=abc`, `?preferLocalProviders=maybe`, `?mode=hologram`) short
 * circuit to a 400 instead of silently defaulting, because for a discovery
 * tool a wrong-but-200 answer is the worst failure mode. Free-text params
 * (`role`, `capability`, `provider`, `originProvider`) are passed through
 * untouched; an unknown provider slug legitimately means "no matches".
 */
function parseBindingQuery(query: (key: string) => string | undefined): BindingQueryParseResult {
	let error: DiscoveryQueryError | null = null;

	// Number: limit
	const limitRaw = query("limit");
	const limit = limitRaw === undefined ? undefined : parseNumber(limitRaw);
	if (limitRaw !== undefined && limit === undefined) {
		error = { param: "limit" };
	}

	// Booleans
	const preferLocalRaw = query("preferLocalProviders");
	const preferLocalProviders = preferLocalRaw === undefined ? undefined : parseBoolean(preferLocalRaw);
	if (error === null && preferLocalRaw !== undefined && preferLocalProviders === undefined) {
		error = { param: "preferLocalProviders", allowedValues: DISCOVERY_BOOLEAN_VALUES };
	}

	const allowCrossRaw = query("allowCrossProvider");
	const allowCrossProvider = allowCrossRaw === undefined ? undefined : parseBoolean(allowCrossRaw);
	if (error === null && allowCrossRaw !== undefined && allowCrossProvider === undefined) {
		error = { param: "allowCrossProvider", allowedValues: DISCOVERY_BOOLEAN_VALUES };
	}

	// Enums
	const modeRaw = query("mode");
	const mode = modeRaw === undefined ? undefined : parseEnum(modeRaw, DISCOVERY_MODEL_MODES);
	if (error === null && modeRaw !== undefined && mode === undefined) {
		error = { param: "mode", allowedValues: DISCOVERY_MODEL_MODES };
	}

	const priceMetricRaw = query("priceMetric");
	const priceMetric = priceMetricRaw === undefined ? undefined : parseEnum(priceMetricRaw, DISCOVERY_PRICE_METRICS);
	if (error === null && priceMetricRaw !== undefined && priceMetric === undefined) {
		error = { param: "priceMetric", allowedValues: DISCOVERY_PRICE_METRICS };
	}

	if (error) return { ok: false, error };

	return {
		ok: true,
		input: {
			role: query("role") ?? undefined,
			capability: query("capability") ?? undefined,
			provider: query("provider") ?? undefined,
			originProvider: query("originProvider") ?? undefined,
			mode,
			limit,
			priceMetric,
			preferLocalProviders,
			allowCrossProvider,
		},
	};
}

/**
 * Parse a strict boolean. Only the literal strings `"true"` / `"false"` are
 * accepted; anything else (including empty string and `"1"` / `"0"`) is
 * invalid so the caller can surface a 400.
 */
function parseBoolean(value: string): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

/**
 * Parse a finite number. Empty / whitespace-only strings are treated as
 * invalid (the param was present but carries no value) rather than coercing
 * to `0`.
 */
function parseNumber(value: string): number | undefined {
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse a value against a fixed set of allowed string literals. */
function parseEnum<T extends string>(value: string, allowed: readonly T[]): T | undefined {
	return (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
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

/**
 * kosha-discovery — HTTP API server (Hono-based).
 *
 * Exposes the model registry over a lightweight REST API so that
 * editor extensions, scripts, and other tools can query discovered
 * models without importing the library directly.
 *
 * Routes:
 *   GET  /api/models                     — List models (query: ?provider, ?originProvider, ?mode, ?capability)
 *   GET  /api/models/cheapest            — Cheapest eligible models for a role/capability
 *   GET  /api/models/:idOrAlias/routes   — All provider routes with preferred/direct metadata
 *   GET  /api/models/:idOrAlias          — Get a single model by ID or alias (+ baseUrl/version)
 *   GET  /api/roles                      — Provider->model->roles matrix
 *   GET  /api/providers                  — List all providers (summary)
 *   GET  /api/providers/:id              — Get a single provider with its models
 *   POST /api/refresh                    — Trigger re-discovery (body: { provider?: string })
 *   GET  /api/resolve/:alias             — Resolve an alias to its canonical model ID
 *   GET  /api/discovery-errors            — Errors from last discovery pass
 *   GET  /health                         — Health check
 *   GET  /proxy/v1/models                — OpenAI-compatible model list (forwardable models)
 *   POST /proxy/v1/chat/completions      — OpenAI-compatible proxy with model routing
 * @module
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { CheapestModelOptions, ModelMode, RoleQueryOptions } from "./types.js";
import { readMonthlyBudgetUsd, readSpendForMonth } from "./cost.js";
import { registerDiscoveryRoutes } from "./discovery-routes.js";
import { registerProxyRoutes, snapshotProxyMetrics } from "./proxy.js";
import { ModelRegistry } from "./registry.js";
import { extractModelVersion, normalizeModelId } from "./normalize.js";

const MODEL_MODES: readonly ModelMode[] = ["chat", "embedding", "image", "video", "audio", "moderation", "rerank"];
const PRICE_METRICS: readonly NonNullable<CheapestModelOptions["priceMetric"]>[] = ["input", "output", "blended"];

/**
 * Set to true when the boot-time discovery pass threw and the server bound on
 * cached/partial state instead. Surfaced via /health and the
 * `kosha_discovery_degraded` /metrics gauge so an operator knows the catalog
 * is stale and a /api/refresh is needed.
 */
let registryBootDegraded = false;

function parseMode(value: string | undefined): ModelMode | undefined {
	if (!value) return undefined;
	if ((MODEL_MODES as readonly string[]).includes(value)) {
		return value as ModelMode;
	}
	return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n)) return undefined;
	return n;
}

function parsePriceMetric(value: string | undefined): CheapestModelOptions["priceMetric"] | undefined {
	if (!value) return undefined;
	if ((PRICE_METRICS as readonly string[]).includes(value)) {
		return value as CheapestModelOptions["priceMetric"];
	}
	return undefined;
}

// ---------------------------------------------------------------------------
//  Server factory
// ---------------------------------------------------------------------------

/**
 * Create a Hono application wired to the given {@link ModelRegistry}.
 *
 * The returned app is not yet listening — call `serve()` or mount it
 * inside another Hono app to start accepting requests.
 *
 * @param registry - A pre-populated (or lazy) ModelRegistry instance.
 * @returns A configured Hono app with all kosha REST routes.
 */
export function createServer(registry: ModelRegistry, shutdownSignal?: AbortSignal): Hono {
	const app = new Hono();
	registerDiscoveryRoutes(app, registry);
	registerProxyRoutes(app, registry, shutdownSignal);

	// ── Model listing & lookup routes ────────────────────────────────
	//
	// GET /api/models supports four optional query parameters:
	//   ?provider=anthropic        — filter by serving-layer provider slug
	//   ?originProvider=anthropic  — filter by original model creator
	//   ?mode=chat                 — filter by ModelMode
	//   ?capability=vision         — filter by capability flag
	app.get("/api/models", (ctx) => {
		const provider = ctx.req.query("provider") ?? undefined;
		const originProvider = ctx.req.query("originProvider") ?? undefined;
		// Distinguish "absent" (no filter) from "present-but-invalid" (400):
		// a typo'd ?mode=chat2 used to silently return the unfiltered catalog,
		// which is the worst failure mode for a discovery tool.
		const modeRaw = ctx.req.query("mode");
		const mode = parseMode(modeRaw);
		if (modeRaw !== undefined && mode === undefined) {
			return ctx.json(
				{ error: "invalid query parameter", param: "mode", received: modeRaw, allowedValues: MODEL_MODES },
				400,
			);
		}
		const capability = ctx.req.query("capability") ?? undefined;

		const models = registry.models({ provider, originProvider, mode, capability });

		return ctx.json({
			models,
			count: models.length,
		});
	});

	// Ranked cheapest model lookup for routing decisions. Route must be
	// registered before dynamic /api/models/:idOrAlias.
	app.get("/api/models/cheapest", (ctx) => {
		// Validate each typed query param up front: present-but-invalid → 400
		// with the allowed values, so a typo can't silently select the wrong
		// (or unfiltered) result set. Absent params stay no-ops as before.
		const modeRaw = ctx.req.query("mode");
		const mode = parseMode(modeRaw);
		if (modeRaw !== undefined && mode === undefined) {
			return ctx.json(
				{ error: "invalid query parameter", param: "mode", received: modeRaw, allowedValues: MODEL_MODES },
				400,
			);
		}
		const limitRaw = ctx.req.query("limit");
		const limit = parseNumber(limitRaw);
		if (limitRaw !== undefined && limit === undefined) {
			return ctx.json({ error: "invalid query parameter", param: "limit", received: limitRaw }, 400);
		}
		const priceMetricRaw = ctx.req.query("priceMetric");
		const priceMetric = parsePriceMetric(priceMetricRaw);
		if (priceMetricRaw !== undefined && priceMetric === undefined) {
			return ctx.json(
				{ error: "invalid query parameter", param: "priceMetric", received: priceMetricRaw, allowedValues: PRICE_METRICS },
				400,
			);
		}
		const inputWeightRaw = ctx.req.query("inputWeight");
		const inputWeight = parseNumber(inputWeightRaw);
		if (inputWeightRaw !== undefined && inputWeight === undefined) {
			return ctx.json({ error: "invalid query parameter", param: "inputWeight", received: inputWeightRaw }, 400);
		}
		const outputWeightRaw = ctx.req.query("outputWeight");
		const outputWeight = parseNumber(outputWeightRaw);
		if (outputWeightRaw !== undefined && outputWeight === undefined) {
			return ctx.json({ error: "invalid query parameter", param: "outputWeight", received: outputWeightRaw }, 400);
		}
		const includeUnpricedRaw = ctx.req.query("includeUnpriced");
		if (includeUnpricedRaw !== undefined && includeUnpricedRaw !== "true" && includeUnpricedRaw !== "false") {
			return ctx.json(
				{ error: "invalid query parameter", param: "includeUnpriced", received: includeUnpricedRaw, allowedValues: ["true", "false"] },
				400,
			);
		}

		const options: CheapestModelOptions = {
			role: ctx.req.query("role") ?? undefined,
			capability: ctx.req.query("capability") ?? undefined,
			provider: ctx.req.query("provider") ?? undefined,
			originProvider: ctx.req.query("originProvider") ?? undefined,
			mode,
			limit,
			priceMetric,
			inputWeight,
			outputWeight,
			includeUnpriced: includeUnpricedRaw === "true",
		};

		const result = registry.cheapestModels(options);
		const message = result.matches.length > 0
			? undefined
			: result.missingCredentials.length > 0
				? "No priced models found. Add credentials for one of the missing providers."
				: "No priced models found for the requested filters.";

		return ctx.json({
			...result,
			cheapest: result.matches[0] ?? null,
			message,
		});
	});

	// Provider/model role matrix for assistant planners and model routers.
	app.get("/api/roles", (ctx) => {
		const options: RoleQueryOptions = {
			role: ctx.req.query("role") ?? undefined,
			capability: ctx.req.query("capability") ?? undefined,
			provider: ctx.req.query("provider") ?? undefined,
			originProvider: ctx.req.query("originProvider") ?? undefined,
			mode: parseMode(ctx.req.query("mode")),
		};

		const providers = registry.providerRoles(options);
		const providerIds = options.provider
			? [options.provider]
			: registry.providers_list().map((provider) => provider.id);
		const modelCount = providers.reduce((sum, provider) => sum + provider.models.length, 0);

		return ctx.json({
			providers,
			count: providers.length,
			modelCount,
			missingCredentials: registry.missingCredentialPrompts(providerIds),
		});
	});

	// ── Capability aggregation route ─────────────────────────────────
	//
	// Returns a summary of all capabilities across the ecosystem.
	// Optional ?provider= filter to scope to one provider.
	app.get("/api/capabilities", (ctx) => {
		const provider = ctx.req.query("provider") ?? undefined;
		const caps = registry.capabilities({ provider });
		const providerIds = provider
			? [provider]
			: registry.providers_list().map((p) => p.id);

		return ctx.json({
			capabilities: caps,
			count: caps.length,
			missingCredentials: registry.missingCredentialPrompts(providerIds),
		});
	});

	// All provider routes for a single model — must be registered BEFORE the
	// generic /:idOrAlias route so that Hono matches "/routes" as a literal
	// segment rather than treating it as a dynamic parameter value.
	//
	// Returns the normalized base ID plus every serving-layer ModelCard that
	// resolves to the same underlying model (direct, openrouter, bedrock, etc.).
	app.get("/api/models/:idOrAlias/routes", (ctx) => {
		const idOrAlias = ctx.req.param("idOrAlias");
		const routes = registry.modelRouteInfo(idOrAlias);

		if (routes.length === 0) {
			return ctx.json({ error: "Model not found", id: idOrAlias }, 404);
		}

		return ctx.json({
			model: normalizeModelId(idOrAlias),
			preferredProvider: routes.find((route) => route.isPreferred)?.provider,
			routes,
		});
	});

	// Single model lookup — accepts a canonical ID or a short alias
	app.get("/api/models/:idOrAlias", (ctx) => {
		const idOrAlias = ctx.req.param("idOrAlias");
		const model = registry.model(idOrAlias);

		if (!model) {
			return ctx.json({ error: "Model not found", id: idOrAlias }, 404);
		}

		const provider = registry.provider(model.provider);
		return ctx.json({
			...model,
			baseUrl: provider?.baseUrl,
			version: extractModelVersion(model.id),
			resolvedOriginProvider: model.originProvider ?? model.provider,
			isDirectProvider: !model.originProvider || model.originProvider === model.provider,
		});
	});

	// ── Provider listing & lookup routes ─────────────────────────────
	//
	// The list endpoint returns a lightweight summary (no full model arrays)
	// to keep payloads small; use /api/providers/:id for the full detail.
	app.get("/api/providers", (ctx) => {
		const prompts = registry.missingCredentialPrompts();
		const promptByProvider = new Map(prompts.map((prompt) => [prompt.providerId, prompt]));
		const providers = registry.providers_list().map((p) => {
			const prompt = promptByProvider.get(p.id);
			return {
				id: p.id,
				name: p.name,
				baseUrl: p.baseUrl,
				authenticated: p.authenticated,
				credentialSource: p.credentialSource,
				modelCount: p.models.length,
				lastRefreshed: p.lastRefreshed,
				missingCredentialPrompt: prompt?.message,
				credentialEnvVars: prompt?.envVars ?? [],
			};
		});

		return ctx.json({
			providers,
			count: providers.length,
			missingCredentials: prompts,
		});
	});

	// Full provider detail including all of its models
	app.get("/api/providers/:id", (ctx) => {
		const id = ctx.req.param("id");
		const provider = registry.provider(id);

		if (!provider) {
			return ctx.json({ error: "Provider not found", id }, 404);
		}

		const prompt = registry.missingCredentialPrompts([provider.id])[0];
		return ctx.json({
			...provider,
			missingCredentialPrompt: prompt?.message,
			credentialEnvVars: prompt?.envVars ?? [],
		});
	});

	// ── Mutation routes ──────────────────────────────────────────────
	//
	// POST /api/refresh triggers a fresh discovery pass. Optionally
	// accepts { provider: "anthropic" } to refresh only one provider.
	app.post("/api/refresh", async (ctx) => {
		const body = await ctx.req.json().catch(() => ({})) as Record<string, string | undefined>;
		const providerId = body.provider;

		try {
			await registry.refresh(providerId);
			const providers = registry.providers_list();
			const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);

			return ctx.json({
				status: "ok",
				providers: providers.length,
				models: totalModels,
				refreshedAt: Date.now(),
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return ctx.json(
				{ error: "Refresh failed", message },
				500,
			);
		}
	});

	// ── Alias resolution route ───────────────────────────────────────
	app.get("/api/resolve/:alias", (ctx) => {
		const alias = ctx.req.param("alias");
		const resolved = registry.resolve(alias);

		return ctx.json({
			alias,
			resolved,
			isAlias: resolved !== alias,
		});
	});

	// ── Discovery error reporting ────────────────────────────────────
	//
	// Returns errors from the most recent discovery pass so operators
	// can diagnose which providers failed and why.
	app.get("/api/discovery-errors", (ctx) => {
		const errors = registry.discoveryErrors();
		return ctx.json({
			errors,
			count: errors.length,
			hasErrors: errors.length > 0,
		});
	});

	// ── Health check ─────────────────────────────────────────────────
	app.get("/health", (ctx) => {
		const providers = registry.providers_list();
		return ctx.json({
			// "degraded" when boot discovery threw and we bound on cached/partial
			// state — load-balancer liveness/readiness probes need to see this
			// so they stop routing to a node whose catalog went stale at boot.
			status: registryBootDegraded ? "degraded" : "ok",
			degraded: registryBootDegraded,
			models: registry.models().length,
			providers: providers.length,
			uptime: process.uptime(),
		});
	});

	// Provider ids come from a JSON-loaded registry; per the Prometheus
	// exposition spec, label values need '\\', '\"', and '\n' escaped — a
	// plain quote-strip is not sufficient and could let a crafted id break
	// the exposition format. https://prometheus.io/docs/instrumenting/exposition_formats/
	const escapePrometheusLabel = (value: string): string =>
		value
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"')
			.replace(/\n/g, "\\n")
			.replace(/\r/g, "");

	// ── Prometheus metrics ───────────────────────────────────────────
	// Plain-text exposition format. Operators can scrape this directly with
	// Prometheus / Grafana Agent / VictoriaMetrics; no extra dependency.
	app.get("/metrics", async (ctx) => {
		// Optional bearer-token gate. Unset → open (default, single-process dev);
		// set → required, so a shared/multi-tenant deployment doesn't leak
		// per-provider breaker state, reliability scores, and p95 latencies.
		const metricsToken = process.env.KOSHA_METRICS_TOKEN;
		if (metricsToken) {
			const auth = ctx.req.header("authorization") ?? "";
			const provided = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
			if (!provided || provided !== metricsToken) {
				return ctx.text("metrics endpoint requires a valid bearer token\n", 403);
			}
		}

		const lines: string[] = [];
		const providers = registry.providers_list();

		lines.push("# HELP kosha_models_total Total models known to the registry.");
		lines.push("# TYPE kosha_models_total gauge");
		lines.push(`kosha_models_total ${registry.models().length}`);

		lines.push("# HELP kosha_providers_total Total providers known to the registry.");
		lines.push("# TYPE kosha_providers_total gauge");
		lines.push(`kosha_providers_total ${providers.length}`);

		lines.push("# HELP kosha_discovery_degraded 1 when boot discovery failed and the server is serving cached/partial state.");
		lines.push("# TYPE kosha_discovery_degraded gauge");
		lines.push(`kosha_discovery_degraded ${registryBootDegraded ? 1 : 0}`);

		lines.push("# HELP kosha_provider_reliability Reliability score per provider in [0,1].");
		lines.push("# TYPE kosha_provider_reliability gauge");
		lines.push("# HELP kosha_provider_p95_latency_ms Observed p95 latency per provider in ms.");
		lines.push("# TYPE kosha_provider_p95_latency_ms gauge");
		lines.push("# HELP kosha_provider_breaker_open Whether the per-provider breaker is open (1) or available (0).");
		lines.push("# TYPE kosha_provider_breaker_open gauge");
		for (const provider of providers) {
			const health = registry.providerRouteHealth(provider.id);
			const safeId = escapePrometheusLabel(provider.id);
			lines.push(`kosha_provider_reliability{provider="${safeId}"} ${health.reliabilityScore}`);
			if (typeof health.p95LatencyMs === "number") {
				lines.push(`kosha_provider_p95_latency_ms{provider="${safeId}"} ${health.p95LatencyMs}`);
			}
			lines.push(`kosha_provider_breaker_open{provider="${safeId}"} ${health.available ? 0 : 1}`);
		}

		lines.push("# HELP kosha_discovery_errors_total Discovery errors captured during the most recent pass.");
		lines.push("# TYPE kosha_discovery_errors_total gauge");
		lines.push(`kosha_discovery_errors_total ${registry.discoveryErrors().length}`);

		// ── Proxy hot-path counters (real inference traffic) ────────────
		const proxy = snapshotProxyMetrics();
		lines.push("# HELP kosha_proxy_requests_total Total requests forwarded by the proxy.");
		lines.push("# TYPE kosha_proxy_requests_total counter");
		lines.push(`kosha_proxy_requests_total ${proxy.requestsTotal}`);
		lines.push("# HELP kosha_proxy_errors_total Total proxy requests that failed upstream.");
		lines.push("# TYPE kosha_proxy_errors_total counter");
		lines.push(`kosha_proxy_errors_total ${proxy.errorsTotal}`);
		lines.push("# HELP kosha_proxy_provider_requests Proxy requests per provider.");
		lines.push("# TYPE kosha_proxy_provider_requests counter");
		lines.push("# HELP kosha_proxy_provider_errors Proxy errors per provider.");
		lines.push("# TYPE kosha_proxy_provider_errors counter");
		lines.push("# HELP kosha_proxy_provider_avg_latency_ms Rolling average proxy latency per provider in ms.");
		lines.push("# TYPE kosha_proxy_provider_avg_latency_ms gauge");
		for (const [providerId, c] of Object.entries(proxy.byProvider)) {
			const safeId = escapePrometheusLabel(providerId);
			lines.push(`kosha_proxy_provider_requests{provider="${safeId}"} ${c.requests}`);
			lines.push(`kosha_proxy_provider_errors{provider="${safeId}"} ${c.errors}`);
			lines.push(`kosha_proxy_provider_avg_latency_ms{provider="${safeId}"} ${c.avgLatencyMs}`);
		}

		// ── Spend / budget ──────────────────────────────────────────────
		lines.push("# HELP kosha_spend_usd_month Estimated spend for the current month in USD.");
		lines.push("# TYPE kosha_spend_usd_month gauge");
		let monthSpend = 0;
		try {
			monthSpend = await readSpendForMonth(Date.now());
		} catch {
			// Unreadable ledger → omit the spend gauge rather than fail /metrics.
		}
		lines.push(`kosha_spend_usd_month ${monthSpend.toFixed(6)}`);
		const budget = readMonthlyBudgetUsd();
		if (budget !== null) {
			lines.push("# HELP kosha_budget_remaining_usd Remaining monthly budget in USD.");
			lines.push("# TYPE kosha_budget_remaining_usd gauge");
			lines.push(`kosha_budget_remaining_usd ${Math.max(0, budget - monthSpend).toFixed(6)}`);
			lines.push(`kosha_budget_usd ${budget.toFixed(2)}`);
		}

		// ── Pricing-provenance coverage ────────────────────────────────
		// Fraction of priced models whose price came from a live provider API
		// or LiteLLM (not a static seed / unknown). A drop signals that the
		// pricing source is unreachable/stale — the registry's headline value
		// (pricing) is silently degrading.
		const priced = registry.models().filter((m) => m.pricing);
		const livePriced = priced.filter((m) => m.pricingSource === "provider-live" || m.pricingSource === "litellm").length;
		const coverage = priced.length > 0 ? livePriced / priced.length : 0;
		lines.push("# HELP kosha_pricing_coverage Fraction of priced models with provider-live or litellm pricing.");
		lines.push("# TYPE kosha_pricing_coverage gauge");
		lines.push(`kosha_pricing_coverage ${coverage.toFixed(4)}`);

		return ctx.text(`${lines.join("\n")}\n`, 200, { "content-type": "text/plain; version=0.0.4" });
	});

	return app;
}

// ---------------------------------------------------------------------------
//  Standalone server entry point
// ---------------------------------------------------------------------------

/**
 * Boot a standalone kosha API server.
 *
 * Runs full discovery, then starts an HTTP listener on the given port.
 * @param port - TCP port to bind (default `3000`, overridable via `PORT` env var).
 */
export async function startServer(port = 3000): Promise<void> {
	const registry = new ModelRegistry();

	console.log("Discovering providers and models...");
	// Boot is fault-tolerant: if discovery throws (network outage on this host,
	// every provider erroring at once, a corrupt cache) we still bind on
	// whatever the registry cached and mark ourselves degraded. The worst time
	// for the service to be down is during the outage it exists to observe.
	let providers = registry.providers_list();
	try {
		await registry.discover();
		providers = registry.providers_list();
	} catch (err) {
		registryBootDegraded = true;
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`Warning: boot discovery failed (${message}); serving cached/partial state. POST /api/refresh to recover.`,
		);
		providers = registry.providers_list();
	}

	const totalModels = registry.models().length;
	console.log(`Found ${totalModels} models from ${providers.length} providers${registryBootDegraded ? " (degraded)" : ""}`);

	// Abort in-flight proxy fetches on shutdown so the server drains instead of
	// dropping streams mid-response; the proxy threads this signal into every
	// upstream fetch alongside its per-request timeout.
	const shutdownController = new AbortController();
	const app = createServer(registry, shutdownController.signal);

	console.log(`\nKosha API server listening on http://localhost:${port}`);
	console.log(`  GET  http://localhost:${port}/api/models`);
	console.log(`  GET  http://localhost:${port}/api/models/cheapest`);
	console.log(`  GET  http://localhost:${port}/api/models/:id/routes`);
	console.log(`  GET  http://localhost:${port}/api/capabilities`);
	console.log(`  GET  http://localhost:${port}/api/roles`);
	console.log(`  GET  http://localhost:${port}/api/providers`);
	console.log(`  GET  http://localhost:${port}/api/discovery`);
	console.log(`  GET  http://localhost:${port}/api/discovery/delta`);
	console.log(`  GET  http://localhost:${port}/api/discovery/watch`);
	console.log(`  GET  http://localhost:${port}/health`);
	console.log(`  GET  http://localhost:${port}/proxy/v1/models`);
	console.log(`  POST http://localhost:${port}/proxy/v1/chat/completions`);

	const server = serve({ fetch: app.fetch, port });

	// Graceful shutdown: stop accepting new connections, abort in-flight
	// upstream fetches (so SSE streams drain / bill correctly), then exit.
	// A hard timeout guards against a hung keep-alive stalling close().
	const shutdown = (signal: string): void => {
		console.log(`\n${signal} received — draining in-flight requests and shutting down.`);
		shutdownController.abort();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5_000).unref();
	};
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

// ---------------------------------------------------------------------------
//  Auto-start when executed directly (e.g. `node dist/server.js`)
// ---------------------------------------------------------------------------

const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
	const port = parseInt(process.env.PORT || "3000", 10);
	startServer(port);
}

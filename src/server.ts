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
 *   GET  /health                         — Health check
 * @module
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { CheapestModelOptions, ModelMode, RoleQueryOptions } from "./types.js";
import { ModelRegistry } from "./registry.js";
import { extractModelVersion, normalizeModelId } from "./normalize.js";

const MODEL_MODES: readonly ModelMode[] = ["chat", "embedding", "image", "audio", "moderation"];
const PRICE_METRICS: readonly NonNullable<CheapestModelOptions["priceMetric"]>[] = ["input", "output", "blended"];

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
export function createServer(registry: ModelRegistry): Hono {
	const app = new Hono();

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
		const mode = parseMode(ctx.req.query("mode"));
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
		const options: CheapestModelOptions = {
			role: ctx.req.query("role") ?? undefined,
			capability: ctx.req.query("capability") ?? undefined,
			provider: ctx.req.query("provider") ?? undefined,
			originProvider: ctx.req.query("originProvider") ?? undefined,
			mode: parseMode(ctx.req.query("mode")),
			limit: parseNumber(ctx.req.query("limit")),
			priceMetric: parsePriceMetric(ctx.req.query("priceMetric")),
			inputWeight: parseNumber(ctx.req.query("inputWeight")),
			outputWeight: parseNumber(ctx.req.query("outputWeight")),
			includeUnpriced: ctx.req.query("includeUnpriced") === "true",
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

	// ── Health check ─────────────────────────────────────────────────
	app.get("/health", (ctx) => {
		const providers = registry.providers_list();
		return ctx.json({
			status: "ok",
			models: registry.models().length,
			providers: providers.length,
			uptime: process.uptime(),
		});
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
	await registry.discover();

	const providers = registry.providers_list();
	const totalModels = registry.models().length;
	console.log(`Found ${totalModels} models from ${providers.length} providers`);

	const app = createServer(registry);

	console.log(`\nKosha API server listening on http://localhost:${port}`);
	console.log(`  GET  http://localhost:${port}/api/models`);
	console.log(`  GET  http://localhost:${port}/api/models/cheapest`);
	console.log(`  GET  http://localhost:${port}/api/models/:id/routes`);
	console.log(`  GET  http://localhost:${port}/api/capabilities`);
	console.log(`  GET  http://localhost:${port}/api/roles`);
	console.log(`  GET  http://localhost:${port}/api/providers`);
	console.log(`  GET  http://localhost:${port}/health`);

	serve({ fetch: app.fetch, port });
}

// ---------------------------------------------------------------------------
//  Auto-start when executed directly (e.g. `node dist/server.js`)
// ---------------------------------------------------------------------------

const isEntryPoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
	const port = parseInt(process.env.PORT || "3000", 10);
	startServer(port);
}

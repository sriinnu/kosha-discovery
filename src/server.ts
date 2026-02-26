/**
 * kosha-discovery — HTTP API server (Hono-based).
 *
 * Exposes the model registry over a lightweight REST API so that
 * editor extensions, scripts, and other tools can query discovered
 * models without importing the library directly.
 *
 * Routes:
 *   GET  /api/models              — List models (query params: ?provider, ?mode, ?capability)
 *   GET  /api/models/:idOrAlias   — Get a single model by ID or alias
 *   GET  /api/providers           — List all providers (summary)
 *   GET  /api/providers/:id       — Get a single provider with its models
 *   POST /api/refresh             — Trigger re-discovery (body: { provider?: string })
 *   GET  /api/resolve/:alias      — Resolve an alias to its canonical model ID
 *   GET  /health                  — Health check
 * @module
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ModelMode } from "./types.js";
import { ModelRegistry } from "./registry.js";

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
	// GET /api/models supports three optional query parameters:
	//   ?provider=anthropic   — filter by provider slug
	//   ?mode=chat            — filter by ModelMode
	//   ?capability=vision    — filter by capability flag
	app.get("/api/models", (ctx) => {
		const provider = ctx.req.query("provider") ?? undefined;
		const mode = (ctx.req.query("mode") as ModelMode | undefined) ?? undefined;
		const capability = ctx.req.query("capability") ?? undefined;

		const models = registry.models({ provider, mode, capability });

		return ctx.json({
			models,
			count: models.length,
		});
	});

	// Single model lookup — accepts a canonical ID or a short alias
	app.get("/api/models/:idOrAlias", (ctx) => {
		const idOrAlias = ctx.req.param("idOrAlias");
		const model = registry.model(idOrAlias);

		if (!model) {
			return ctx.json({ error: "Model not found", id: idOrAlias }, 404);
		}

		return ctx.json(model);
	});

	// ── Provider listing & lookup routes ─────────────────────────────
	//
	// The list endpoint returns a lightweight summary (no full model arrays)
	// to keep payloads small; use /api/providers/:id for the full detail.
	app.get("/api/providers", (ctx) => {
		const providers = registry.providers_list().map((p) => ({
			id: p.id,
			name: p.name,
			baseUrl: p.baseUrl,
			authenticated: p.authenticated,
			credentialSource: p.credentialSource,
			modelCount: p.models.length,
			lastRefreshed: p.lastRefreshed,
		}));

		return ctx.json({
			providers,
			count: providers.length,
		});
	});

	// Full provider detail including all of its models
	app.get("/api/providers/:id", (ctx) => {
		const id = ctx.req.param("id");
		const provider = registry.provider(id);

		if (!provider) {
			return ctx.json({ error: "Provider not found", id }, 404);
		}

		return ctx.json(provider);
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

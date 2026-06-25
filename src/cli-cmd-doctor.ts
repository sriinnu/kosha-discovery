/**
 * `kosha doctor` — surface deprecation warnings and provider health at a
 * glance. Pure projection over the registry: it reports what kosha already
 * knows (deprecationDate, replacedBy, breaker state, routing reliability)
 * without making any extra network calls.
 *
 * Pair with `kosha refresh` if you want the freshest deprecation metadata
 * from each provider.
 * @module
 */

import { c, CYAN, DIM, GREEN, RED, YELLOW } from "./cli-format.js";
import type { ModelRegistry } from "./registry.js";
import type { ModelCard } from "./types.js";

interface DoctorFlags {
	json?: string | boolean;
}

/** A model whose lifecycle metadata signals it needs operator attention. */
interface DeprecationFinding {
	modelId: string;
	provider: string;
	status: string | null;
	deprecationDate: string | null;
	daysUntilSunset: number | null;
	replacedBy: string | null;
}

/** Provider health entry surfaced to the operator. */
interface HealthFinding {
	providerId: string;
	breakerState: string;
	available: boolean;
	reliabilityScore: number;
	p95LatencyMs: number | null;
	timeoutRate: number;
}

export async function cmdDoctor(registry: ModelRegistry, flags: Record<string, string | boolean>): Promise<void> {
	const f: DoctorFlags = flags;

	// Hydrate from the disk cache without refetching from provider APIs:
	// `doctor` is observational, never a write.
	try {
		await registry.discover();
	} catch {
		// Even if discovery fails, we can still report on whatever the cached
		// registry holds — that's the point of `doctor`.
	}

	const models = registry.models();
	const deprecations = collectDeprecations(models);
	const providers = uniqueProviderIds(models);
	const healthFindings = providers
		.map((providerId) => projectHealth(registry, providerId))
		.filter((row): row is HealthFinding => row !== null);

	if (f.json) {
		process.stdout.write(`${JSON.stringify({ deprecations, health: healthFindings }, null, 2)}\n`);
		return;
	}

	renderDeprecations(deprecations);
	renderHealth(healthFindings);
}

function collectDeprecations(models: ModelCard[]): DeprecationFinding[] {
	const today = todayMs();
	const findings: DeprecationFinding[] = [];
	for (const model of models) {
		const status = model.status ?? null;
		const deprecationDate = model.deprecationDate ?? null;
		const replacedBy = model.replacedBy ?? null;

		if (!status && !deprecationDate && !replacedBy) continue;
		if (status !== "deprecated" && status !== "retired" && !deprecationDate) continue;

		findings.push({
			modelId: model.id,
			provider: model.provider,
			status,
			deprecationDate,
			daysUntilSunset: deprecationDate ? daysBetween(today, deprecationDate) : null,
			replacedBy,
		});
	}
	findings.sort((a, b) => {
		// Soonest sunset first; retired models bubble to the top.
		const aKey = a.daysUntilSunset ?? Number.POSITIVE_INFINITY;
		const bKey = b.daysUntilSunset ?? Number.POSITIVE_INFINITY;
		if (aKey !== bKey) return aKey - bKey;
		return a.modelId.localeCompare(b.modelId);
	});
	return findings;
}

function uniqueProviderIds(models: ModelCard[]): string[] {
	return Array.from(new Set(models.map((m) => m.provider))).sort();
}

function projectHealth(registry: ModelRegistry, providerId: string): HealthFinding | null {
	try {
		const h = registry.providerRouteHealth(providerId);
		return {
			providerId: h.providerId,
			breakerState: h.breakerState,
			available: h.available,
			reliabilityScore: h.reliabilityScore,
			p95LatencyMs: h.p95LatencyMs,
			timeoutRate: h.timeoutRate,
		};
	} catch {
		return null;
	}
}

function renderDeprecations(findings: DeprecationFinding[]): void {
	process.stdout.write(`${c(CYAN, "Model lifecycle")}\n`);
	if (findings.length === 0) {
		process.stdout.write(c(DIM, "  No deprecation signals from any provider catalogue.\n\n"));
		return;
	}
	for (const f of findings) {
		const days = f.daysUntilSunset;
		let tag: string;
		if (f.status === "retired") tag = c(RED, "retired");
		else if (days !== null && days <= 14) tag = c(RED, `sunsets in ${days}d`);
		else if (days !== null && days <= 60) tag = c(YELLOW, `sunsets in ${days}d`);
		else if (f.status === "deprecated") tag = c(YELLOW, "deprecated");
		else if (days !== null) tag = c(DIM, `sunsets in ${days}d`);
		else tag = c(DIM, f.status ?? "unknown");

		const replacement = f.replacedBy ? c(DIM, ` -> ${f.replacedBy}`) : "";
		process.stdout.write(`  ${tag}  ${f.provider}/${f.modelId}${replacement}\n`);
	}
	process.stdout.write("\n");
}

function renderHealth(findings: HealthFinding[]): void {
	process.stdout.write(`${c(CYAN, "Provider health")}\n`);
	if (findings.length === 0) {
		process.stdout.write(c(DIM, "  No providers in the registry yet — run `kosha discover`.\n"));
		return;
	}
	for (const h of findings) {
		const tag = h.available
			? h.reliabilityScore >= 0.95
				? c(GREEN, "ok")
				: c(YELLOW, "degraded")
			: c(RED, "open");
		const p95 = h.p95LatencyMs !== null ? `${h.p95LatencyMs}ms` : "no samples";
		const reliability = (h.reliabilityScore * 100).toFixed(0);
		process.stdout.write(
			`  ${tag}  ${h.providerId.padEnd(14)} ${c(DIM, `reliability=${reliability}%`)}  ${c(DIM, `p95=${p95}`)}\n`,
		);
	}
}

function daysBetween(nowMs: number, isoDate: string): number | null {
	const date = Date.parse(isoDate);
	if (!Number.isFinite(date)) return null;
	return Math.floor((date - nowMs) / 86_400_000);
}

/**
 * Today's wall-clock midnight as ms. Wrapped so tests can swap it out;
 * a deprecation finding rendering is otherwise time-dependent and racy.
 */
function todayMs(): number {
	const now = new Date();
	now.setHours(0, 0, 0, 0);
	return now.getTime();
}

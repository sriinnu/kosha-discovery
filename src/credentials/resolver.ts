/**
 * kosha-discovery — Multi-source credential resolver.
 *
 * Implements a layered search strategy to locate API keys and
 * access tokens for each supported provider.  The search hierarchy is:
 *
 *   1. **Explicit config** — key passed directly via `KoshaConfig.providers`
 *   2. **Environment variables** — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
 *   3. **CLI tool credential files** — Claude CLI, Copilot, Codex, Gemini CLI
 *   4. **Config / OAuth files** — `~/.config/*`, gcloud ADC
 *
 * The resolver returns the **first** credential found and never throws.
 * If nothing is found, `{ source: "none" }` is returned.
 * @module
 */

import { readFile } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import type { CredentialResult } from "../types.js";

/**
 * Multi-source credential resolver for AI providers.
 *
 * Resolution priority per provider:
 *   1. Explicit config key (passed programmatically)
 *   2. Environment variables
 *   3. CLI tool credential files (Claude CLI, Copilot, Gemini CLI, etc.)
 *   4. Config / OAuth files (~/.config/*)
 *
 * Always returns a {@link CredentialResult}; never throws.
 */
export class CredentialResolver {
	private readonly home = homedir();
	private readonly isWindows = platform() === "win32";

	/**
	 * Resolve credentials for the given provider.
	 *
	 * @param providerId  - Provider slug (e.g. "anthropic", "openai").
	 * @param explicitKey - Optional API key passed from user config; takes
	 *                      highest precedence when provided.
	 * @returns The first credential found, or `{ source: "none" }`.
	 */
	async resolve(providerId: string, explicitKey?: string): Promise<CredentialResult> {
		switch (providerId) {
			case "anthropic":
				return this.resolveAnthropic(explicitKey);
			case "openai":
				return this.resolveOpenAI(explicitKey);
			case "google":
			case "gemini":
				return this.resolveGoogle(explicitKey);
			case "openrouter":
				return this.resolveOpenRouter(explicitKey);
			case "ollama":
				return this.resolveOllama();
			default:
				return { source: "none" };
		}
	}

	// ---------------------------------------------------------------------------
	// Anthropic
	// ---------------------------------------------------------------------------

	/**
	 * Search hierarchy for Anthropic credentials:
	 *   1. Explicit config key
	 *   2. `ANTHROPIC_API_KEY` env var
	 *   3. `~/.claude.json` (Claude CLI)
	 *   4. `~/.config/claude/settings.json` (Claude CLI settings)
	 *   5. `~/.claude/credentials.json` (Claude CLI OAuth)
	 *   6. `~/.codex/auth.json` (Codex CLI — stores Anthropic keys)
	 */
	private async resolveAnthropic(explicitKey?: string): Promise<CredentialResult> {
		// 1. Explicit config key
		if (explicitKey) {
			return { apiKey: explicitKey, source: "config" };
		}

		// 2. Environment variable
		const envKey = process.env.ANTHROPIC_API_KEY;
		if (envKey) {
			return { apiKey: envKey, source: "env" };
		}

		// 3. Claude CLI config — ~/.claude.json
		const claudeJson = await this.readJson<{ apiKey?: string }>(join(this.home, ".claude.json"));
		if (claudeJson?.apiKey) {
			return { apiKey: claudeJson.apiKey, source: "cli", path: join(this.home, ".claude.json") };
		}

		// 4. Claude CLI settings — ~/.config/claude/settings.json
		const claudeSettings = await this.readJson<{ apiKey?: string }>(
			join(this.home, ".config", "claude", "settings.json"),
		);
		if (claudeSettings?.apiKey) {
			return {
				apiKey: claudeSettings.apiKey,
				source: "cli",
				path: join(this.home, ".config", "claude", "settings.json"),
			};
		}

		// 5. Claude CLI OAuth — ~/.claude/credentials.json
		const claudeOAuth = await this.readJson<{ accessToken?: string }>(
			join(this.home, ".claude", "credentials.json"),
		);
		if (claudeOAuth?.accessToken) {
			return {
				accessToken: claudeOAuth.accessToken,
				source: "oauth",
				path: join(this.home, ".claude", "credentials.json"),
			};
		}

		// 6. Codex CLI — ~/.codex/auth.json
		const codexAuth = await this.readJson<{ anthropic?: string }>(join(this.home, ".codex", "auth.json"));
		if (codexAuth?.anthropic) {
			return { apiKey: codexAuth.anthropic, source: "cli", path: join(this.home, ".codex", "auth.json") };
		}

		return { source: "none" };
	}

	// ---------------------------------------------------------------------------
	// OpenAI
	// ---------------------------------------------------------------------------

	/**
	 * Search hierarchy for OpenAI credentials:
	 *   1. Explicit config key
	 *   2. `OPENAI_API_KEY` env var
	 *   3. GitHub Copilot `hosts.json` (contains an OAuth token usable with OpenAI-compatible APIs)
	 *   4. GitHub Copilot `apps.json` (alternative credential location)
	 */
	private async resolveOpenAI(explicitKey?: string): Promise<CredentialResult> {
		// 1. Explicit config key
		if (explicitKey) {
			return { apiKey: explicitKey, source: "config" };
		}

		// 2. Environment variable
		const envKey = process.env.OPENAI_API_KEY;
		if (envKey) {
			return { apiKey: envKey, source: "env" };
		}

		// 3. GitHub Copilot hosts.json
		const copilotPaths = this.getCopilotPaths("hosts.json");
		for (const p of copilotPaths) {
			const hosts = await this.readJson<Record<string, { oauth_token?: string }>>(p);
			if (hosts) {
				const token = this.extractCopilotToken(hosts);
				if (token) {
					return { accessToken: token, source: "cli", path: p };
				}
			}
		}

		// 4. GitHub Copilot apps.json
		const appsPaths = this.getCopilotPaths("apps.json");
		for (const p of appsPaths) {
			const apps = await this.readJson<Record<string, { oauth_token?: string }>>(p);
			if (apps) {
				const token = this.extractCopilotToken(apps);
				if (token) {
					return { accessToken: token, source: "cli", path: p };
				}
			}
		}

		return { source: "none" };
	}

	// ---------------------------------------------------------------------------
	// Google / Gemini
	// ---------------------------------------------------------------------------

	/**
	 * Search hierarchy for Google / Gemini credentials:
	 *   1. Explicit config key
	 *   2. `GOOGLE_API_KEY` or `GEMINI_API_KEY` env var
	 *   3. Gemini CLI `~/.gemini/credentials.json`
	 *   4. gcloud Application Default Credentials (ADC)
	 */
	private async resolveGoogle(explicitKey?: string): Promise<CredentialResult> {
		// 1. Explicit config key
		if (explicitKey) {
			return { apiKey: explicitKey, source: "config" };
		}

		// 2. Environment variables
		const envKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
		if (envKey) {
			return { apiKey: envKey, source: "env" };
		}

		// 3. Gemini CLI credentials
		const geminiCreds = await this.readJson<{ apiKey?: string; access_token?: string }>(
			join(this.home, ".gemini", "credentials.json"),
		);
		if (geminiCreds?.apiKey) {
			return {
				apiKey: geminiCreds.apiKey,
				source: "cli",
				path: join(this.home, ".gemini", "credentials.json"),
			};
		}
		if (geminiCreds?.access_token) {
			return {
				accessToken: geminiCreds.access_token,
				source: "cli",
				path: join(this.home, ".gemini", "credentials.json"),
			};
		}

		// 4. gcloud application default credentials
		const gcloudPaths = this.getGcloudPaths();
		for (const p of gcloudPaths) {
			const gcloud = await this.readJson<{ access_token?: string; refresh_token?: string }>(p);
			if (gcloud?.access_token) {
				return { accessToken: gcloud.access_token, source: "config", path: p };
			}
			if (gcloud?.refresh_token) {
				return { accessToken: gcloud.refresh_token, source: "config", path: p };
			}
		}

		return { source: "none" };
	}

	// ---------------------------------------------------------------------------
	// OpenRouter
	// ---------------------------------------------------------------------------

	/**
	 * Search hierarchy for OpenRouter credentials:
	 *   1. Explicit config key
	 *   2. `OPENROUTER_API_KEY` env var
	 *   (No known CLI tool stores OpenRouter keys on disk.)
	 */
	private async resolveOpenRouter(explicitKey?: string): Promise<CredentialResult> {
		// 1. Explicit config key
		if (explicitKey) {
			return { apiKey: explicitKey, source: "config" };
		}

		// 2. Environment variable
		const envKey = process.env.OPENROUTER_API_KEY;
		if (envKey) {
			return { apiKey: envKey, source: "env" };
		}

		// No known CLI tool credentials for OpenRouter
		return { source: "none" };
	}

	// ---------------------------------------------------------------------------
	// Ollama (no auth needed)
	// ---------------------------------------------------------------------------

	/**
	 * Ollama runs locally and never requires authentication.
	 *
	 * We always return `{ source: "none" }` regardless of reachability.
	 * The ping is only a connectivity check — it does not produce a credential.
	 */
	private async resolveOllama(): Promise<CredentialResult> {
		// Ollama never needs auth — the ping is just a reachability check
		const reachable = await this.pingOllama();
		if (reachable) {
			return { source: "none" };
		}
		return { source: "none" };
	}

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	/** Safely read and parse a JSON file; returns null on any error. */
	private async readJson<T>(filePath: string): Promise<T | null> {
		try {
			const raw = await readFile(filePath, "utf-8");
			return JSON.parse(raw) as T;
		} catch {
			return null;
		}
	}

	/** Return candidate paths for GitHub Copilot config files. */
	private getCopilotPaths(filename: string): string[] {
		const paths: string[] = [join(this.home, ".config", "github-copilot", filename)];

		if (this.isWindows) {
			const appData = process.env.APPDATA;
			if (appData) {
				paths.push(join(appData, "github-copilot", filename));
			}
			const localAppData = process.env.LOCALAPPDATA;
			if (localAppData) {
				paths.push(join(localAppData, "github-copilot", filename));
			}
		}

		return paths;
	}

	/** Return candidate paths for gcloud ADC. */
	private getGcloudPaths(): string[] {
		const paths: string[] = [
			join(this.home, ".config", "gcloud", "application_default_credentials.json"),
		];

		if (this.isWindows) {
			const appData = process.env.APPDATA;
			if (appData) {
				paths.push(join(appData, "gcloud", "application_default_credentials.json"));
			}
		}

		return paths;
	}

	/** Extract the first OAuth token from a Copilot hosts/apps JSON structure. */
	private extractCopilotToken(data: Record<string, { oauth_token?: string }>): string | undefined {
		for (const value of Object.values(data)) {
			if (value?.oauth_token) {
				return value.oauth_token;
			}
		}
		return undefined;
	}

	/** Ping the Ollama API to check if it's running. */
	private async pingOllama(): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2_000);
			const response = await fetch("http://localhost:11434/api/tags", {
				signal: controller.signal,
			});
			clearTimeout(timeout);
			return response.ok;
		} catch {
			return false;
		}
	}
}

/**
 * kosha-discovery — Multi-source credential resolver.
 *
 * Implements a layered search strategy to locate API keys and
 * access tokens for each supported provider.  The search hierarchy is:
 *
 *   1. **Explicit config** — key passed directly via `KoshaConfig.providers`
 *   2. **Environment variables** — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
 *   3. **CLI tool credential files** — Claude CLI, Copilot, Codex, Gemini CLI
 *   4. **Config / OAuth files** — `~/.config/*`, gcloud ADC, `~/.aws/*`
 *   5. **CLI subprocess** — `gcloud auth print-access-token` etc.
 *
 * The resolver returns the **first** credential found and never throws.
 * If nothing is found, `{ source: "none" }` is returned.
 * @module
 */

import { execSync } from "child_process";
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
			case "bedrock":
				return this.resolveBedrockCredential(explicitKey);
			case "vertex":
				return this.resolveVertexCredential(explicitKey);
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
	// AWS Bedrock
	// ---------------------------------------------------------------------------

	/**
	 * Search hierarchy for AWS Bedrock credentials:
	 *   1. Explicit config key (`config.providers.bedrock.apiKey` or `config.providers.aws.apiKey`)
	 *   2. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` env vars (both must be present)
	 *   3. `AWS_PROFILE` env var — signals a named profile in `~/.aws/credentials`
	 *   4. `~/.aws/credentials` — reads the `[default]` profile's `aws_access_key_id`
	 *   5. `~/.aws/config` — detects SSO or IAM role configuration (presence check only)
	 *
	 * The returned `metadata.region` is resolved from (in order):
	 *   `AWS_DEFAULT_REGION` → `AWS_REGION` → `region` in `~/.aws/config [default]` → `"us-east-1"`
	 *
	 * @param explicitKey - Optional AWS access key ID passed from user config.
	 * @returns Resolved credential with `key` (access key ID or sentinel) and `metadata.region`.
	 */
	private async resolveBedrockCredential(explicitKey?: string): Promise<CredentialResult> {
		// 1. Explicit config key
		if (explicitKey) {
			const region = await this.resolveAwsRegion();
			return { apiKey: explicitKey, source: "config", metadata: { region } };
		}

		// 2. Environment variables — both access key and secret must be present
		const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
		const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
		if (accessKeyId && secretAccessKey) {
			const region = await this.resolveAwsRegion();
			return { apiKey: accessKeyId, source: "env", metadata: { region } };
		}

		// 3. Named profile via AWS_PROFILE env var
		const awsProfile = process.env.AWS_PROFILE;
		if (awsProfile) {
			const region = await this.resolveAwsRegion();
			return { apiKey: "aws-profile", source: "cli", metadata: { region } };
		}

		// 4. ~/.aws/credentials — [default] profile
		const awsCredentialsPath = join(this.home, ".aws", "credentials");
		const awsCredentialsRaw = await this.readTextFile(awsCredentialsPath);
		if (awsCredentialsRaw !== null) {
			const defaultProfile = this.parseAwsIniSection(awsCredentialsRaw, "default");
			const keyId = defaultProfile["aws_access_key_id"];
			if (keyId) {
				const region = await this.resolveAwsRegion();
				return { apiKey: keyId, source: "cli", path: awsCredentialsPath, metadata: { region } };
			}
		}

		// 5. ~/.aws/config — detect SSO or role-based configuration (presence-only check)
		const awsConfigPath = join(this.home, ".aws", "config");
		const awsConfigRaw = await this.readTextFile(awsConfigPath);
		if (awsConfigRaw !== null) {
			const isSso = awsConfigRaw.includes("sso_start_url") || awsConfigRaw.includes("sso_session");
			const isRole = awsConfigRaw.includes("role_arn");
			if (isSso) {
				const region = await this.resolveAwsRegion(awsConfigRaw);
				return { apiKey: "aws-sso", source: "cli", path: awsConfigPath, metadata: { region } };
			}
			if (isRole) {
				const region = await this.resolveAwsRegion(awsConfigRaw);
				return { apiKey: "aws-iam", source: "cli", path: awsConfigPath, metadata: { region } };
			}
		}

		return { source: "none" };
	}

	/**
	 * Resolve the effective AWS region from environment variables or the
	 * parsed `~/.aws/config` content.
	 *
	 * Priority: `AWS_DEFAULT_REGION` → `AWS_REGION` → `region` in `[default]`
	 * profile of the provided config text → `"us-east-1"` fallback.
	 *
	 * @param awsConfigRaw - Optional raw text of `~/.aws/config` already read by the caller.
	 * @returns The resolved region string.
	 */
	private async resolveAwsRegion(awsConfigRaw?: string): Promise<string> {
		// Env vars take highest precedence
		const envRegion = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION;
		if (envRegion) {
			return envRegion;
		}

		// Parse from ~/.aws/config [default] or the pre-read content
		const configText = awsConfigRaw ?? (await this.readTextFile(join(this.home, ".aws", "config")));
		if (configText !== null) {
			// AWS config uses [profile default] for non-default profiles and [default] for the default
			const section =
				this.parseAwsIniSection(configText, "profile default")["region"] ??
				this.parseAwsIniSection(configText, "default")["region"];
			if (section) {
				return section;
			}
		}

		return "us-east-1";
	}

	/**
	 * Parse a single named section from an AWS INI-format file.
	 *
	 * AWS credential/config files use INI syntax with `[section]` headers and
	 * `key = value` pairs. This parser is intentionally minimal: it only extracts
	 * key-value pairs belonging to the requested section and ignores all others.
	 *
	 * @param text        - Raw file content.
	 * @param sectionName - Section header to extract (without brackets), e.g. `"default"`.
	 * @returns A map of key → value strings found within the section, or `{}` if not found.
	 */
	private parseAwsIniSection(text: string, sectionName: string): Record<string, string> {
		const result: Record<string, string> = {};
		const lines = text.split(/\r?\n/);
		let inSection = false;

		for (const line of lines) {
			const trimmed = line.trim();

			// Detect section headers
			if (trimmed.startsWith("[")) {
				const header = trimmed.slice(1, trimmed.indexOf("]")).trim();
				inSection = header === sectionName;
				continue;
			}

			if (!inSection || !trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
				continue;
			}

			const eqIdx = trimmed.indexOf("=");
			if (eqIdx === -1) continue;

			const key = trimmed.slice(0, eqIdx).trim();
			const value = trimmed.slice(eqIdx + 1).trim();
			result[key] = value;
		}

		return result;
	}

	// ---------------------------------------------------------------------------
	// GCP Vertex AI
	// ---------------------------------------------------------------------------

	/**
	 * Search hierarchy for GCP Vertex AI credentials:
	 *   1. Explicit config key (`config.providers.vertex.apiKey`)
	 *   2. `GOOGLE_APPLICATION_CREDENTIALS` env var — path to service account JSON
	 *   3. `~/.config/gcloud/application_default_credentials.json` (gcloud ADC)
	 *   4. `gcloud auth print-access-token` subprocess (5 s timeout)
	 *
	 * The returned `metadata` always contains `region` and optionally `projectId`
	 * resolved from (in order):
	 *   - `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` env vars
	 *   - `gcloud config get-value project` subprocess
	 *
	 * @param explicitKey - Optional explicit key or service-account path from user config.
	 * @returns Resolved credential with `key` and `metadata.{ projectId?, region }`.
	 */
	private async resolveVertexCredential(explicitKey?: string): Promise<CredentialResult> {
		// 1. Explicit config key
		if (explicitKey) {
			const metadata = await this.resolveVertexMetadata();
			return { apiKey: explicitKey, source: "config", metadata };
		}

		// 2. GOOGLE_APPLICATION_CREDENTIALS env var — path to a service account JSON file
		const gacEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
		if (gacEnv) {
			const metadata = await this.resolveVertexMetadata();
			return { apiKey: gacEnv, source: "env", metadata };
		}

		// 3. gcloud Application Default Credentials (ADC) file
		const adcPaths = this.getGcloudPaths();
		for (const adcPath of adcPaths) {
			const adc = await this.readJson<{
				access_token?: string;
				refresh_token?: string;
				client_id?: string;
				type?: string;
			}>(adcPath);
			if (adc) {
				const token = adc.access_token ?? adc.refresh_token;
				if (token) {
					const metadata = await this.resolveVertexMetadata();
					return { apiKey: token, source: "config", path: adcPath, metadata };
				}
			}
		}

		// 4. gcloud CLI — obtain a short-lived access token via subprocess
		const cliToken = this.execGcloudToken();
		if (cliToken) {
			const metadata = await this.resolveVertexMetadata();
			return { apiKey: cliToken, source: "cli", metadata };
		}

		return { source: "none" };
	}

	/**
	 * Resolve Vertex AI metadata: GCP project ID and region.
	 *
	 * Project ID priority: `GOOGLE_CLOUD_PROJECT` → `GCLOUD_PROJECT` → `gcloud config get-value project`
	 * Region priority:     `GOOGLE_CLOUD_REGION` → `"us-central1"`
	 *
	 * @returns Metadata object with `region` (always set) and optional `projectId`.
	 */
	private async resolveVertexMetadata(): Promise<Record<string, string>> {
		const region = process.env.GOOGLE_CLOUD_REGION ?? "us-central1";

		// Resolve project ID from environment first (cheapest)
		const envProject = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
		if (envProject) {
			return { projectId: envProject, region };
		}

		// Fall back to gcloud CLI subprocess
		const cliProject = this.execGcloudProject();
		if (cliProject) {
			return { projectId: cliProject, region };
		}

		return { region };
	}

	/**
	 * Run `gcloud auth print-access-token` and return the trimmed token.
	 * Returns `null` on any error (gcloud not installed, not authenticated, timeout, etc.).
	 */
	private execGcloudToken(): string | null {
		try {
			const output = execSync("gcloud auth print-access-token", {
				timeout: 5_000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const token = output.toString().trim();
			return token || null;
		} catch {
			return null;
		}
	}

	/**
	 * Run `gcloud config get-value project` and return the trimmed project ID.
	 * Returns `null` on any error.
	 */
	private execGcloudProject(): string | null {
		try {
			const output = execSync("gcloud config get-value project", {
				timeout: 5_000,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const project = output.toString().trim();
			// gcloud prints "(unset)" when no project is configured
			return project && project !== "(unset)" ? project : null;
		} catch {
			return null;
		}
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

	/** Safely read a text file as a string; returns null on any error. */
	private async readTextFile(filePath: string): Promise<string | null> {
		try {
			return await readFile(filePath, "utf-8");
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

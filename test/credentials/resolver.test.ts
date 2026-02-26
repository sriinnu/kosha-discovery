import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialResolver } from "../../src/credentials/resolver.js";

// ---------------------------------------------------------------------------
// Mock fs/promises — we replace readFile so no real files are touched
// ---------------------------------------------------------------------------
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
}));

import { readFile } from "fs/promises";

const mockedReadFile = vi.mocked(readFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience: make readFile resolve with JSON content for a specific path. */
function mockFile(path: string, content: unknown): void {
	mockedReadFile.mockImplementation(async (p: any) => {
		if (typeof p === "string" && p.includes(path)) {
			return JSON.stringify(content);
		}
		throw new Error("ENOENT");
	});
}

/** Make readFile always reject (no files found). */
function mockNoFiles(): void {
	mockedReadFile.mockRejectedValue(new Error("ENOENT"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CredentialResolver", () => {
	let resolver: CredentialResolver;
	const savedEnv = { ...process.env };

	beforeEach(() => {
		resolver = new CredentialResolver();
		mockNoFiles();
	});

	afterEach(() => {
		process.env = { ...savedEnv };
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------------------
	// Explicit key priority
	// -----------------------------------------------------------------------

	describe("explicit key takes priority", () => {
		it("returns explicit key for anthropic even when env var is set", async () => {
			process.env.ANTHROPIC_API_KEY = "env-key";
			const result = await resolver.resolve("anthropic", "explicit-key");

			expect(result.apiKey).toBe("explicit-key");
			expect(result.source).toBe("config");
		});

		it("returns explicit key for openai even when env var is set", async () => {
			process.env.OPENAI_API_KEY = "env-key";
			const result = await resolver.resolve("openai", "explicit-key");

			expect(result.apiKey).toBe("explicit-key");
			expect(result.source).toBe("config");
		});

		it("returns explicit key for google even when env var is set", async () => {
			process.env.GOOGLE_API_KEY = "env-key";
			const result = await resolver.resolve("google", "explicit-key");

			expect(result.apiKey).toBe("explicit-key");
			expect(result.source).toBe("config");
		});

		it("returns explicit key for openrouter even when env var is set", async () => {
			process.env.OPENROUTER_API_KEY = "env-key";
			const result = await resolver.resolve("openrouter", "explicit-key");

			expect(result.apiKey).toBe("explicit-key");
			expect(result.source).toBe("config");
		});
	});

	// -----------------------------------------------------------------------
	// Environment variable resolution
	// -----------------------------------------------------------------------

	describe("env var resolution", () => {
		it("resolves ANTHROPIC_API_KEY from env", async () => {
			process.env.ANTHROPIC_API_KEY = "sk-ant-test";
			const result = await resolver.resolve("anthropic");

			expect(result.apiKey).toBe("sk-ant-test");
			expect(result.source).toBe("env");
		});

		it("resolves OPENAI_API_KEY from env", async () => {
			process.env.OPENAI_API_KEY = "sk-openai-test";
			const result = await resolver.resolve("openai");

			expect(result.apiKey).toBe("sk-openai-test");
			expect(result.source).toBe("env");
		});

		it("resolves GOOGLE_API_KEY from env", async () => {
			process.env.GOOGLE_API_KEY = "AIza-test";
			const result = await resolver.resolve("google");

			expect(result.apiKey).toBe("AIza-test");
			expect(result.source).toBe("env");
		});

		it("resolves GEMINI_API_KEY from env when GOOGLE_API_KEY is not set", async () => {
			delete process.env.GOOGLE_API_KEY;
			process.env.GEMINI_API_KEY = "gemini-test";
			const result = await resolver.resolve("google");

			expect(result.apiKey).toBe("gemini-test");
			expect(result.source).toBe("env");
		});

		it("resolves OPENROUTER_API_KEY from env", async () => {
			process.env.OPENROUTER_API_KEY = "sk-or-test";
			const result = await resolver.resolve("openrouter");

			expect(result.apiKey).toBe("sk-or-test");
			expect(result.source).toBe("env");
		});
	});

	// -----------------------------------------------------------------------
	// File-based credential reading
	// -----------------------------------------------------------------------

	describe("file-based credential reading", () => {
		it("reads Anthropic key from ~/.claude.json", async () => {
			delete process.env.ANTHROPIC_API_KEY;
			mockFile(".claude.json", { apiKey: "file-anthropic-key" });

			const result = await resolver.resolve("anthropic");

			expect(result.apiKey).toBe("file-anthropic-key");
			expect(result.source).toBe("cli");
			expect(result.path).toContain(".claude.json");
		});

		it("reads Anthropic OAuth from ~/.claude/credentials.json", async () => {
			delete process.env.ANTHROPIC_API_KEY;

			mockedReadFile.mockImplementation(async (p: any) => {
				if (typeof p === "string" && p.includes("credentials.json") && p.includes(".claude")) {
					return JSON.stringify({ accessToken: "oauth-token-123" });
				}
				throw new Error("ENOENT");
			});

			const result = await resolver.resolve("anthropic");

			expect(result.accessToken).toBe("oauth-token-123");
			expect(result.source).toBe("oauth");
			expect(result.path).toContain("credentials.json");
		});

		it("reads Anthropic key from Codex CLI ~/.codex/auth.json", async () => {
			delete process.env.ANTHROPIC_API_KEY;

			mockedReadFile.mockImplementation(async (p: any) => {
				if (typeof p === "string" && p.includes("codex") && p.includes("auth.json")) {
					return JSON.stringify({ anthropic: "codex-anthropic-key" });
				}
				throw new Error("ENOENT");
			});

			const result = await resolver.resolve("anthropic");

			expect(result.apiKey).toBe("codex-anthropic-key");
			expect(result.source).toBe("cli");
			expect(result.path).toContain("auth.json");
		});

		it("reads OpenAI token from GitHub Copilot hosts.json", async () => {
			delete process.env.OPENAI_API_KEY;
			mockFile("hosts.json", {
				"github.com": { oauth_token: "gho_copilot_token" },
			});

			const result = await resolver.resolve("openai");

			expect(result.accessToken).toBe("gho_copilot_token");
			expect(result.source).toBe("cli");
			expect(result.path).toContain("hosts.json");
		});

		it("reads Google key from Gemini CLI ~/.gemini/credentials.json", async () => {
			delete process.env.GOOGLE_API_KEY;
			delete process.env.GEMINI_API_KEY;
			mockFile("credentials.json", { apiKey: "gemini-cli-key" });

			const result = await resolver.resolve("google");

			expect(result.apiKey).toBe("gemini-cli-key");
			expect(result.source).toBe("cli");
			expect(result.path).toContain("credentials.json");
		});

		it("reads Google token from gcloud ADC", async () => {
			delete process.env.GOOGLE_API_KEY;
			delete process.env.GEMINI_API_KEY;

			mockedReadFile.mockImplementation(async (p: any) => {
				if (typeof p === "string" && p.includes("application_default_credentials.json")) {
					return JSON.stringify({ access_token: "gcloud-access-token" });
				}
				throw new Error("ENOENT");
			});

			const result = await resolver.resolve("google");

			expect(result.accessToken).toBe("gcloud-access-token");
			expect(result.source).toBe("config");
			expect(result.path).toContain("application_default_credentials.json");
		});
	});

	// -----------------------------------------------------------------------
	// Ollama
	// -----------------------------------------------------------------------

	describe("ollama", () => {
		it("always returns source 'none' (no auth needed)", async () => {
			// Mock fetch to simulate Ollama not running
			vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

			const result = await resolver.resolve("ollama");

			expect(result.source).toBe("none");
			expect(result.apiKey).toBeUndefined();
			expect(result.accessToken).toBeUndefined();
		});

		it("returns source 'none' even when Ollama is running", async () => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ models: [] }), { status: 200 }),
			);

			const result = await resolver.resolve("ollama");

			expect(result.source).toBe("none");
		});
	});

	// -----------------------------------------------------------------------
	// Graceful failure
	// -----------------------------------------------------------------------

	describe("graceful failure", () => {
		it("returns source 'none' for unknown provider", async () => {
			const result = await resolver.resolve("unknown-provider");

			expect(result.source).toBe("none");
		});

		it("returns source 'none' when no credentials found for anthropic", async () => {
			delete process.env.ANTHROPIC_API_KEY;

			const result = await resolver.resolve("anthropic");

			expect(result.source).toBe("none");
			expect(result.apiKey).toBeUndefined();
			expect(result.accessToken).toBeUndefined();
		});

		it("returns source 'none' when no credentials found for openai", async () => {
			delete process.env.OPENAI_API_KEY;

			const result = await resolver.resolve("openai");

			expect(result.source).toBe("none");
		});

		it("returns source 'none' when no credentials found for google", async () => {
			delete process.env.GOOGLE_API_KEY;
			delete process.env.GEMINI_API_KEY;

			const result = await resolver.resolve("google");

			expect(result.source).toBe("none");
		});

		it("returns source 'none' when no credentials found for openrouter", async () => {
			delete process.env.OPENROUTER_API_KEY;

			const result = await resolver.resolve("openrouter");

			expect(result.source).toBe("none");
		});

		it("handles malformed JSON in credential files gracefully", async () => {
			delete process.env.ANTHROPIC_API_KEY;
			mockedReadFile.mockResolvedValue("not valid json {{{" as any);

			const result = await resolver.resolve("anthropic");

			expect(result.source).toBe("none");
		});
	});

	// -----------------------------------------------------------------------
	// Provider aliases
	// -----------------------------------------------------------------------

	describe("provider aliases", () => {
		it("accepts 'gemini' as alias for google", async () => {
			process.env.GOOGLE_API_KEY = "google-key-via-gemini-alias";
			const result = await resolver.resolve("gemini");

			expect(result.apiKey).toBe("google-key-via-gemini-alias");
			expect(result.source).toBe("env");
		});
	});
});

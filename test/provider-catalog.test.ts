import { describe, expect, it } from "vitest";
import { getProviderDescriptor, normalizeProviderId } from "../src/provider-catalog.js";

describe("provider-catalog", () => {
	it("normalizes llama.cpp aliases to the canonical provider ID", () => {
		expect(normalizeProviderId("llama-cpp")).toBe("llama.cpp");
		expect(normalizeProviderId("llamacpp")).toBe("llama.cpp");
		expect(getProviderDescriptor("llama.cpp")?.isLocal).toBe(true);
	});

	it("normalizes google aliases to the canonical provider ID", () => {
		expect(normalizeProviderId("gemini")).toBe("google");
		expect(getProviderDescriptor("google")?.transport).toBe("native-http");
	});

	it("normalizes new provider aliases", () => {
		expect(normalizeProviderId("kimi")).toBe("moonshot");
		expect(normalizeProviderId("zhipu")).toBe("glm");
		expect(normalizeProviderId("z.ai")).toBe("zai");
		expect(getProviderDescriptor("moonshot")?.credentialRequired).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { resolveModelSimpleStreamOptions } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

/** Minimal model fixture for reasoning-policy tests that do not need a provider implementation. */
function model(reasoning: boolean): Model<Api> {
	return {
		id: "model",
		name: "Model",
		api: "test-api",
		provider: "test-provider",
		baseUrl: "https://example.test",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("model-aware simple reasoning", () => {
	it("raises explicit and omitted off to GLM-5.3-Flash's lowest supported level", () => {
		const glm = getBuiltinModel("opencode-go", "glm-5.3-flash");

		// Both spellings mean the same thing at the Models boundary; truthful metadata prevents
		// the adapter from ever receiving a disabled-thinking request for this always-on model.
		expect(resolveModelSimpleStreamOptions(glm, { reasoning: "off" })).toEqual({ reasoning: "low" });
		expect(resolveModelSimpleStreamOptions(glm)).toEqual({ reasoning: "low" });
	});

	it("raises Mercury 2 off to its documented lowest effort", () => {
		const mercury = getBuiltinModel("openrouter", "inception/mercury-2");

		expect(resolveModelSimpleStreamOptions(mercury, { reasoning: "off" })).toEqual({ reasoning: "low" });
	});

	it("omits reasoning when the model supports switching thinking off", () => {
		const options = resolveModelSimpleStreamOptions(model(true), { reasoning: "off", maxTokens: 80 });

		expect(options).toEqual({ maxTokens: 80 });
		expect(options).not.toHaveProperty("reasoning");
	});

	it("drops a requested effort for a model without reasoning", () => {
		expect(resolveModelSimpleStreamOptions(model(false), { reasoning: "high" })).toEqual({});
	});
});

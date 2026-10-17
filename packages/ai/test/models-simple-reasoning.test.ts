import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
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

	it.each([undefined, "off"] as const)(
		"sends Kimi K3's lowest Chat Completions effort for %s reasoning",
		async (reasoning) => {
			let payload: unknown;

			// Capture the normalized wire request before any network call.
			await streamSimple(
				getBuiltinModel("kimi-coding", "k3"),
				{
					messages: [{ role: "user", content: "Hello", timestamp: 0 }],
				},
				{
					apiKey: "fake-key",
					reasoning,
					onPayload: (value) => {
						payload = value;
						throw new Error("payload captured");
					},
				},
			).result();

			expect(payload).toMatchObject({ model: "k3", reasoning_effort: "low" });
			expect(payload).not.toHaveProperty("thinking");
		},
	);

	it.each([undefined, "off"] as const)(
		"keeps Kimi Highspeed thinking enabled without effort for %s reasoning",
		async (reasoning) => {
			let payload: unknown;

			// Highspeed uses a thinking toggle, not K3's effort vocabulary.
			await streamSimple(
				getBuiltinModel("kimi-coding", "kimi-for-coding-highspeed"),
				{
					messages: [{ role: "user", content: "Hello", timestamp: 0 }],
				},
				{
					apiKey: "fake-key",
					reasoning,
					onPayload: (value) => {
						payload = value;
						throw new Error("payload captured");
					},
				},
			).result();

			expect(payload).toMatchObject({ thinking: { type: "enabled" } });
			expect(payload).not.toHaveProperty("reasoning_effort");
		},
	);

	it("omits reasoning when the model supports switching thinking off", () => {
		const options = resolveModelSimpleStreamOptions(model(true), { reasoning: "off", maxTokens: 80 });

		expect(options).toEqual({ maxTokens: 80 });
		expect(options).not.toHaveProperty("reasoning");
	});

	it("drops a requested effort for a model without reasoning", () => {
		expect(resolveModelSimpleStreamOptions(model(false), { reasoning: "high" })).toEqual({});
	});
});

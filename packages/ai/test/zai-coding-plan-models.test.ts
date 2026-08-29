import { expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { getBuiltinModel, getBuiltinModels } from "../src/providers/all.ts";

it("exposes GLM-4.6V on the China Coding Plan catalog", () => {
	const model = getBuiltinModel("zai-coding-cn", "glm-4.6v");

	expect(model).toMatchObject({
		id: "glm-4.6v",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			zaiToolStream: true,
		},
	});
});

it("uses API-equivalent reference costs for Coding Plan models", () => {
	expect(getBuiltinModel("zai", "glm-5.2").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	expect(getBuiltinModel("zai-coding-cn", "glm-5.1").cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	expect(getBuiltinModel("zai-coding-cn", "glm-5v-turbo").cost).toEqual({
		input: 1.2,
		output: 4,
		cacheRead: 0.24,
		cacheWrite: 0,
	});
	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.3").cost).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
		});
	}
});

it("keeps zero costs for Coding Plan models without a matching API price", () => {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(getBuiltinModel(provider, "glm-5.2-highspeed").cost).toEqual(zeroCost);
	}
});

it("marks GLM-5.3 models as always-thinking across providers", () => {
	for (const [provider, modelId, expectedLevels] of [
		["cloudflare-ai-gateway", "workers-ai/@cf/zai-org/glm-5.3", ["low", "medium", "high"]],
		["cloudflare-ai-gateway", "workers-ai/@cf/zai-org/glm-5.3-flash", ["low", "medium", "high"]],
		["cloudflare-workers-ai", "@cf/zai-org/glm-5.3", ["low", "medium", "high"]],
		["cloudflare-workers-ai", "@cf/zai-org/glm-5.3-flash", ["low", "medium", "high"]],
		["opencode-go", "glm-5.3", ["low", "high", "max"]],
		["opencode-go", "glm-5.3-flash", ["low", "high", "max"]],
		["openrouter", "z-ai/glm-5.3", ["low", "high", "max"]],
		["openrouter", "z-ai/glm-5.3-flash", ["low", "high", "max"]],
		["openrouter", "z-ai/glm-5.3-flash:batch", ["low", "high", "max"]],
		["together", "zai-org/GLM-5.3-Flash", ["low", "high", "max"]],
		["vercel-ai-gateway", "zai/glm-5.3", ["low", "high", "max"]],
		["vercel-ai-gateway", "zai/glm-5.3-flash", ["low", "high", "max"]],
		["zai", "glm-5.3", ["low", "high", "max"]],
		["zai", "glm-5.3-flash", ["low", "high", "max"]],
		["zai", "glm-5.3-highspeed", ["low", "high", "max"]],
		["zai-coding-cn", "glm-5.3", ["low", "high", "max"]],
		["zai-coding-cn", "glm-5.3-flash", ["low", "high", "max"]],
		["zai-coding-cn", "glm-5.3-highspeed", ["low", "high", "max"]],
	] as const) {
		const model = getBuiltinModels(provider).find((entry) => entry.id === modelId);
		if (!model) throw new Error(`Missing ${provider}/${modelId}`);

		expect(model.thinkingLevelMap?.off).toBeNull();
		expect(getSupportedThinkingLevels(model)).toEqual(expectedLevels);
	}
});

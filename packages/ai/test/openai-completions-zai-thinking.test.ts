import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";

type CapturedZaiParams = {
	thinking?: {
		type?: "enabled" | "disabled";
		clear_thinking?: boolean;
	};
	reasoning?: {
		effort?: string;
	};
	reasoning_effort?: string;
};

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions Z.AI thinking payload", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	for (const modelId of ["glm-5.1", "glm-5.2"] as const) {
		it(`preserves thinking context for Z.AI ${modelId} when thinking is enabled`, async () => {
			const model = getModel("zai", modelId)!;

			await streamSimple(
				model,
				{
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{ apiKey: "test", reasoning: "high" },
			).result();

			const params = mockState.lastParams as CapturedZaiParams;
			expect(params.thinking).toEqual({ type: "enabled", clear_thinking: false });
		});
	}

	it("preserves thinking context for OpenRouter z-ai/glm-5.2 when thinking is enabled", async () => {
		const model = getModel("openrouter", "z-ai/glm-5.2")!;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", reasoning: "high" },
		).result();

		const params = mockState.lastParams as CapturedZaiParams;
		expect(params.reasoning).toEqual({ effort: "high" });
		expect(params.thinking).toEqual({ type: "enabled", clear_thinking: false });
	});

	it("does not send clear_thinking when Z.AI thinking is disabled", async () => {
		const model = getModel("zai", "glm-5.1")!;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as CapturedZaiParams;
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.thinking?.clear_thinking).toBeUndefined();
	});
});

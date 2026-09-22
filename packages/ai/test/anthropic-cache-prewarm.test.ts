import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

/** Fake client that records the request body and answers with a fixed response. */
function createRecordingClient(response: Response): { client: Anthropic; bodies: Record<string, unknown>[] } {
	const bodies: Record<string, unknown>[] = [];
	const client = {
		beta: {
			messages: {
				create: (body: Record<string, unknown>) => {
					bodies.push(body);
					return { asResponse: async () => response };
				},
			},
		},
	} as unknown as Anthropic;
	return { client, bodies };
}

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

describe("Anthropic cache pre-warm (max_tokens 0)", () => {
	it("sends a non-streaming primary-model request and reads the JSON usage", async () => {
		const base = getModel("anthropic", "claude-opus-4-8");
		// Server-side fallbacks would warm a cache entry the next request never reads.
		const model = {
			...base,
			compat: {
				...base.compat,
				allowedFallbackModels: [{ provider: "anthropic", model: "claude-sonnet-4-5", cost: base.cost }],
			},
		};
		const { client, bodies } = createRecordingClient(
			Response.json({
				id: "msg_warm",
				type: "message",
				role: "assistant",
				model: model.id,
				content: [],
				stop_reason: "max_tokens",
				usage: {
					input_tokens: 3,
					output_tokens: 0,
					cache_read_input_tokens: 90_000,
					cache_creation_input_tokens: 0,
				},
			}),
		);

		const result = await streamAnthropic(model, context, { client, maxTokens: 0 }).result();

		expect(bodies[0]).toMatchObject({ max_tokens: 0, stream: false });
		expect(bodies[0]).not.toHaveProperty("fallbacks");
		expect(result).toMatchObject({
			stopReason: "length",
			responseId: "msg_warm",
			content: [],
			usage: { input: 3, output: 0, cacheRead: 90_000, cacheWrite: 0, totalTokens: 90_003 },
		});
		// 90k cache reads at 0.5/Mtok plus 3 input tokens at 5/Mtok.
		expect(result.usage.cost.total).toBeCloseTo(0.045015, 10);
	});

	it("keeps ordinary requests streaming", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const { client, bodies } = createRecordingClient(new Response("", { status: 200 }));

		await streamAnthropic(model, context, { client, maxTokens: 1 }).result();

		expect(bodies[0]).toMatchObject({ max_tokens: 1, stream: true });
	});
});

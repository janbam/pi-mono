import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface CacheControlBlock {
	type: string;
	cache_control?: { type: "ephemeral"; ttl?: "1h" };
}

interface AnthropicWarmupPayload {
	max_tokens: number;
	messages: Array<{ role: "user" | "assistant"; content: string | CacheControlBlock[] }>;
	stream: boolean;
	thinking?: { type: string; budget_tokens?: number };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

afterEach(() => vi.restoreAllMocks());

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-compatible",
		name: "Claude Compatible",
		api: "anthropic-messages",
		provider: "custom-anthropic-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

function makeWarmupResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "message",
			id: "msg_warm",
			role: "assistant",
			model: "claude-compatible",
			content: [],
			stop_reason: "max_tokens",
			stop_sequence: null,
			stop_details: null,
			container: null,
			usage: {
				input_tokens: 3,
				output_tokens: 0,
				cache_read_input_tokens: 120,
				cache_creation_input_tokens: 5,
				cache_creation: null,
				inference_geo: null,
				server_tool_use: null,
				service_tier: "standard",
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

async function captureWarmupPayload(
	context: Context,
	model: Model<"anthropic-messages"> = makeModel(),
	options: Pick<SimpleStreamOptions, "maxTokens" | "reasoning"> = { maxTokens: 0 },
): Promise<AnthropicWarmupPayload> {
	let captured: AnthropicWarmupPayload | undefined;
	const stream = streamSimple(model, context, {
		apiKey: "fake-key",
		...options,
		promptCacheWarmup: true,
		onPayload: (payload) => {
			captured = payload as AnthropicWarmupPayload;
			throw new PayloadCaptured();
		},
	});
	await stream.result();
	if (!captured) throw new Error("Expected Anthropic payload capture");
	return captured;
}

describe("Anthropic prompt-cache warmup requests", () => {
	it("sends max_tokens zero and keeps the synthetic dot outside the cached prefix", async () => {
		const payload = await captureWarmupPayload({
			messages: [
				{ role: "user", content: "Question", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "Answer" }],
					api: "anthropic-messages",
					provider: "custom-anthropic-proxy",
					model: "claude-compatible",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 2,
				},
				{ role: "user", content: ".", timestamp: 3 },
			],
		});

		expect(payload.max_tokens).toBe(0);
		expect(payload.stream).toBe(false);
		const answer = payload.messages[1]?.content;
		const dot = payload.messages[2]?.content;
		expect(Array.isArray(answer) && answer[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(dot).toBe(".");
	});

	it("preserves adaptive thinking and effort on a zero-token warmup", async () => {
		const model: Model<"anthropic-messages"> = {
			...makeModel(),
			reasoning: true,
			compat: { forceAdaptiveThinking: true },
		};
		const payload = await captureWarmupPayload({ messages: [{ role: "user", content: ".", timestamp: 1 }] }, model, {
			maxTokens: 0,
			reasoning: "high",
		});

		expect(payload).toMatchObject({
			max_tokens: 0,
			stream: false,
			thinking: { type: "adaptive" },
			output_config: { effort: "high" },
		});
	});

	it("sets max_tokens to the thinking budget plus one for budget-based warmups", async () => {
		const model: Model<"anthropic-messages"> = {
			...makeModel(),
			reasoning: true,
			maxTokens: 32_000,
		};
		const payload = await captureWarmupPayload(
			{ messages: [{ role: "user", content: "Reply only with OK.", timestamp: 1 }] },
			model,
			{ maxTokens: 1, reasoning: "high" },
		);

		expect(payload).toMatchObject({
			max_tokens: 16_385,
			stream: false,
			thinking: { type: "enabled", budget_tokens: 16_384 },
		});
	});

	it("reasserts the warmup token and thinking ceiling after payload hooks", async () => {
		let requestPayload: unknown;
		const client = {
			messages: {
				create: (payload: unknown) => {
					requestPayload = payload;
					return { asResponse: async () => makeWarmupResponse() };
				},
			},
		} as unknown as Anthropic;
		const model: Model<"anthropic-messages"> = { ...makeModel(), reasoning: true, maxTokens: 32_000 };

		await streamAnthropic(
			model,
			{ messages: [{ role: "user", content: "Reply only with OK.", timestamp: 1 }] },
			{
				client,
				maxTokens: 16_385,
				thinkingEnabled: true,
				thinkingBudgetTokens: 16_384,
				promptCacheWarmup: true,
				onPayload: (payload) => ({
					...(payload as AnthropicWarmupPayload),
					max_tokens: 8_192,
					stream: true,
					thinking: { type: "enabled", budget_tokens: 1 },
					output_config: { effort: "low" },
				}),
			},
		).result();

		expect(requestPayload).toMatchObject({
			max_tokens: 16_385,
			stream: false,
			thinking: { type: "enabled", budget_tokens: 16_384 },
		});
		expect(requestPayload).not.toHaveProperty("output_config");
	});

	it("uses the non-streaming Messages response and returns its maintenance usage", async () => {
		let requestPayload: unknown;
		const client = {
			messages: {
				create: (payload: unknown) => {
					requestPayload = payload;
					return { asResponse: async () => makeWarmupResponse() };
				},
			},
		} as unknown as Anthropic;

		const result = await streamAnthropic(
			makeModel(),
			{ messages: [{ role: "user", content: ".", timestamp: 1 }] },
			{ client, maxTokens: 0, promptCacheWarmup: true },
		).result();

		expect(requestPayload).toMatchObject({ max_tokens: 0, stream: false });
		expect(result).toMatchObject({
			responseId: "msg_warm",
			stopReason: "length",
			usage: { input: 3, output: 0, cacheRead: 120, cacheWrite: 5, totalTokens: 128 },
		});
	});

	it("does not dispatch after synchronous payload preparation crosses the absolute deadline", async () => {
		const fetch = vi.fn(async () => makeWarmupResponse()) as unknown as typeof globalThis.fetch;
		const expiresAt = 2_000;
		const now = vi.spyOn(Date, "now").mockReturnValue(expiresAt - 1);

		const result = await streamSimple(
			makeModel(),
			{ messages: [{ role: "user", content: ".", timestamp: 1 }] },
			{
				apiKey: "fake-key",
				fetch,
				maxTokens: 0,
				promptCacheWarmup: true,
				promptCacheWarmupExpiresAt: expiresAt,
				onPayload: (payload) => {
					// Simulate synchronous extension work starving timers until the lease is already cold.
					now.mockReturnValue(expiresAt);
					return payload;
				},
			},
		).result();

		expect(fetch).not.toHaveBeenCalled();
		expect(result.stopReason).toBe("aborted");
	});
});

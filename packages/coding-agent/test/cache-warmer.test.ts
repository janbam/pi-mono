import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type CacheWarmingDecisionEvent,
	type CacheWarmingEffectiveMode,
	type CacheWarmRequest,
	formatCacheWarmingStatus,
	formatCacheWarmingUsage,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
	type RebuiltCacheWarmRequest,
} from "../src/core/cache-warmer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import { formatCacheWarmingIndicator } from "../src/modes/interactive/components/cache-warming-indicator.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const adaptiveModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...getBuiltinModel("openai", "gpt-5"),
	promptCache: { short: 300, long: 86_400 },
};
const unknownModel: Model<Api> = { ...adaptiveModel, promptCache: undefined };

const warmUsage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: warmUsage,
		stopReason,
		timestamp: 0,
	};
}

function branchWithPrompt(promptTokens: number): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				...response(adaptiveModel),
				usage: { ...warmUsage, output: 10, cacheRead: promptTokens, totalTokens: promptTokens + 10 },
			},
		},
	];
}

function fakeRuntime(
	options: {
		result?: (model: Model<Api>) => Promise<AssistantMessage>;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction | Promise<CacheWarmingAction>;
		mode?: CacheWarmingEffectiveMode;
		maxAgeMs?: number;
		branch?: SessionEntry[];
		rebuild?: () => Promise<RebuiltCacheWarmRequest | undefined>;
	} = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const warmedEntries: UsageEntry[] = [];
	const usageManager = SessionManager.inMemory();
	const appendUsage = vi.fn(usageManager.appendUsage.bind(usageManager));
	const state = {
		mode: options.mode ?? "idle",
		maxAgeMs: options.maxAgeMs ?? 60 * 60_000,
		branch: options.branch ?? branchWithPrompt(100_000),
	};
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				return {
					result: () => (options.result ?? (async (m: Model<Api>) => response(m)))(model),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => state.branch },
		() => ({ mode: state.mode, maxAgeMs: state.maxAgeMs }),
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
		options.rebuild,
	);
	warmer.onWarmed = (entry) => warmedEntries.push(entry);
	return { warmer, calls, events, warmedEntries, appendUsage, state };
}

/** A persisted real response dispatched at `at` whose request used the prompt cache. */
function assistantEntry(at: number, model: Model<Api> = adaptiveModel): SessionEntry {
	return {
		type: "message",
		id: `assistant-${at}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { ...response(model), usage: { ...warmUsage, cacheRead: 100_000 }, timestamp: at },
	};
}

/** A persisted refresh, written when its response arrived at `at`. */
function warmEntry(at: number): SessionEntry {
	return {
		type: "usage",
		id: `warm-${at}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		kind: "cache_warm",
		provider: adaptiveModel.provider,
		model: adaptiveModel.id,
		usage: warmUsage,
	};
}

function rebuiltAs(model: Model<Api> = adaptiveModel): () => Promise<RebuiltCacheWarmRequest> {
	return async () => ({ request: request(model), isCurrent: current });
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

afterEach(() => vi.useRealTimers());

describe("cache warming", () => {
	it("derives eligibility and timing from retention and provider behavior", () => {
		expect([
			getPromptCacheTtlMs(adaptiveModel, undefined),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" }),
			getPromptCacheTtlMs(adaptiveModel, { env: { PI_CACHE_RETENTION: "long" } }),
			getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(unknownModel, undefined),
		]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000, undefined]);
		// JBMOD: refresh ten seconds before expiry instead of at 90% of the TTL.
		expect([getCacheWarmingDelayMs(300_000), getCacheWarmingDelayMs(60_000), getCacheWarmingDelayMs(10_000)]).toEqual(
			[290_000, 50_000, undefined],
		);
		expect([
			isReplayable(budgetModel, { reasoning: "medium" }),
			isReplayable(budgetModel, undefined),
			isReplayable(adaptiveModel, { reasoning: "medium" }),
			isReplayable(openaiModel, { reasoning: "medium" }),
			// JBMOD: fork options carry the unresolved level; judge what the model actually receives.
			isReplayable(budgetModel, { reasoning: "off" }),
			isReplayable({ ...budgetModel, thinkingLevelMap: { off: null } }, { reasoning: "off" }),
		]).toEqual([false, true, true, true, true, false]);
	});

	it("replays profitable requests and preserves options across repeated refreshes", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, appendUsage, warmedEntries } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s", transformHeaders }), current);
		await vi.advanceTimersByTimeAsync(290_000);

		// JBMOD: the Anthropic Messages API gets the documented max_tokens 0 pre-warm.
		expect(calls[0]).toMatchObject({
			model: adaptiveModel,
			options: { reasoning: "high", sessionId: "s", transformHeaders, maxTokens: 0, maxRetries: 0 },
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(events[0]).toMatchObject({
			type: "cache_warming_decision",
			continuationProbability: 1,
			action: "warm",
		});
		expect(events[0].missCost).toBeCloseTo(0.575);
		expect(events[0].warmCost).toBeCloseTo(0.050025);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			warmUsage,
			undefined,
		);
		expect(warmedEntries).toEqual([appendUsage.mock.results[0]?.value]);
		expect(warmer.status).toMatchObject({ state: "scheduled", refreshCount: 1, refreshCost: 0.01 });

		await vi.advanceTimersByTimeAsync(290_000);
		expect(calls).toHaveLength(2);
		warmer.cancel();
	});

	// JBMOD: proxies speaking the Anthropic API pre-warm too; other APIs keep the one-token replay.
	it("pre-warms every Anthropic Messages model and replays one token elsewhere", async () => {
		vi.useFakeTimers();
		const proxied = { ...adaptiveModel, provider: "clode" };
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(proxied), current);
		await vi.advanceTimersByTimeAsync(290_000);
		warmer.start(request(openaiModel), current);
		await vi.advanceTimersByTimeAsync(290_000);

		expect(calls.map((call) => call.options?.maxTokens)).toEqual([0, 1]);
		warmer.cancel();
	});

	it("does not issue refreshes after their safe deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(), current);

		// A five-minute cache is scheduled for 4m50s and retains 5 seconds of
		// the 10-second expiry margin. Simulate a timer delayed by sleep.
		vi.setSystemTime(295_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("rechecks the deadline after an extension decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({
			decide: async () => {
				await Promise.resolve();
				vi.setSystemTime(295_001);
				return "warm" as const;
			},
		});
		warmer.start(request(), current);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("applies economic decisions and extension overrides", async () => {
		vi.useFakeTimers();
		const unprofitable = fakeRuntime({ branch: branchWithPrompt(5_000) });
		unprofitable.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(290_000);
		expect(unprofitable.calls).toHaveLength(0);
		expect(unprofitable.warmer.status).toMatchObject({
			state: "inactive",
			decision: { action: "stop", economicsAvailable: true },
			extensionOverride: false,
		});

		const forced = fakeRuntime({ branch: branchWithPrompt(5_000), decide: () => "warm" });
		forced.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(290_000);
		expect(forced.calls).toHaveLength(1);
		expect(forced.warmedEntries[0]?.note).toBe("extension override");
		forced.warmer.cancel();

		const vetoed = fakeRuntime({ decide: () => "stop" });
		vetoed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(290_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", extensionOverride: true });

		const unavailable = fakeRuntime({ branch: branchWithPrompt(0) });
		unavailable.warmer.start(request(), current);
		expect(unavailable.warmer.status).toMatchObject({
			state: "inactive",
			reason: "cache economics unavailable",
		});
		await vi.advanceTimersByTimeAsync(290_000);
		expect(unavailable.calls).toHaveLength(0);
	});

	// JBMOD: -kw and /warm on mean "warm until the cap", but extensions keep their veto.
	it("skips the savings floor when warming was enabled explicitly", async () => {
		vi.useFakeTimers();
		const explicit = fakeRuntime({ mode: "on", branch: branchWithPrompt(5_000) });
		explicit.warmer.start(request(), current);
		explicit.warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(290_000);
		expect(explicit.calls).toHaveLength(1);
		expect(explicit.events[0]).toMatchObject({ action: "warm", continuationProbability: 0.15 });
		expect(explicit.warmer.status.decision).toMatchObject({ explicit: true, action: "warm" });
		expect(explicit.warmer.status.decision?.expectedSavings).toBeLessThan(0.05);
		explicit.warmer.cancel();

		// Unknown economics would stop the ordinary modes; explicit warming still runs.
		const unknown = fakeRuntime({ mode: "on", branch: branchWithPrompt(0) });
		unknown.warmer.start(request(), current);
		expect(unknown.warmer.status.state).toBe("scheduled");
		await vi.advanceTimersByTimeAsync(290_000);
		expect(unknown.calls).toHaveLength(1);
		unknown.warmer.cancel();

		const vetoed = fakeRuntime({ mode: "on", decide: () => "stop" });
		vetoed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(290_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", reason: "stopped by extension" });
	});

	// JBMOD: 1-hour entries are rewritten at 2x input, not at the 5-minute write rate.
	it("prices a lost 1-hour entry at the 1-hour write rate", async () => {
		vi.useFakeTimers();
		const { warmer, events } = fakeRuntime();
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		await vi.advanceTimersByTimeAsync(3_590_000);

		// 100k tokens: 1h write at 2 * $5/Mtok minus a $0.5/Mtok read.
		expect(events[0].missCost).toBeCloseTo(0.95);
		warmer.cancel();
	});

	// JBMOD: one configurable cap for both phases, counted from the last real request.
	it("stops at the configured age cap regardless of phase", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({ mode: "on", maxAgeMs: 10 * 60_000 });
		warmer.start(request(), current);
		warmer.onAgentSettled();

		// Refreshes at 4m50s and 9m40s fit in ten minutes; the one at 14m30s would not.
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(calls).toHaveLength(2);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "10-minute warming limit reached" });

		// A cap lowered after a refresh was armed applies to that refresh too.
		const lowered = fakeRuntime({ mode: "on" });
		lowered.warmer.start(request(), current);
		lowered.state.maxAgeMs = 60_000;
		await vi.advanceTimersByTimeAsync(290_000);
		expect(lowered.calls).toHaveLength(0);
		expect(lowered.warmer.status.reason).toBe("1-minute warming limit reached");
	});

	// JBMOD: a refresh without a cache read means the entry was lost or the replay diverged.
	it("stops after a refresh that did not read the cache, keeping its usage", async () => {
		vi.useFakeTimers();
		const missed = fakeRuntime({
			result: async (model) => ({
				...response(model),
				usage: { ...warmUsage, cacheRead: 0, cacheWrite: 100 },
			}),
		});
		missed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(290_000);

		// The write was billed, so it is recorded; warming does not continue on a cold or mismatched entry.
		expect(missed.appendUsage).toHaveBeenCalledOnce();
		expect(missed.warmer.status).toMatchObject({
			state: "inactive",
			failed: true,
			reason: "refresh missed the cache (entry expired or replay differs)",
		});
		await vi.advanceTimersByTimeAsync(600_000);
		expect(missed.calls).toHaveLength(1);
	});

	it("stops for unsupported requests, context changes, and mode changes", async () => {
		vi.useFakeTimers();
		const unsupported = fakeRuntime();
		unsupported.state.mode = "off";
		unsupported.warmer.start(request(), current);
		expect(unsupported.warmer.status.reason).toBe("cache warming disabled");
		unsupported.state.mode = "idle";
		unsupported.warmer.start(request(unknownModel), current);
		expect(unsupported.warmer.status.reason).toBe("cache lifetime unavailable");
		unsupported.warmer.start(request(budgetModel, { reasoning: "high" }), current);
		expect(unsupported.warmer.status.reason).toBe("request cannot be replayed safely");

		let stillCurrent = true;
		unsupported.warmer.start(request(), () => stillCurrent);
		stillCurrent = false;
		expect(unsupported.warmer.status.reason).toBe("conversation context changed");
		await vi.advanceTimersByTimeAsync(290_000);
		expect(unsupported.calls).toHaveLength(0);

		unsupported.warmer.start(request(), current);
		unsupported.state.mode = "off";
		await vi.advanceTimersByTimeAsync(290_000);
		expect(unsupported.calls).toHaveLength(0);

		const streaming = fakeRuntime({ mode: "streaming", branch: branchWithPrompt(400_000) });
		streaming.warmer.start(request(), current);
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status.reason).toBe("agent run settled");
	});

	it("aborts replaced requests and does not record failed refreshes", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const pending = fakeRuntime({
			result: (model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		});
		pending.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(290_000);
		pending.warmer.start(request(), current);
		expect(pending.calls[0].options?.signal?.aborted).toBe(true);
		release();
		pending.warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(pending.calls).toHaveLength(1);

		// JBMOD: a failed refresh stops warming loudly; a retry past the margin would be a full write.
		const failed = fakeRuntime({
			result: async (model) => ({ ...response(model, "error"), errorMessage: "overloaded" }),
		});
		failed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(290_000);
		expect(failed.appendUsage).not.toHaveBeenCalled();
		expect(failed.warmer.status).toMatchObject({
			state: "inactive",
			failed: true,
			reason: "cache refresh failed: overloaded",
		});
		await vi.advanceTimersByTimeAsync(600_000);
		expect(failed.calls).toHaveLength(1);
	});

	// JBMOD: resuming a session keeps warming the entry its last request left behind.
	it("resumes warming the transcript's last request from its live lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const { warmer, calls } = fakeRuntime({
			mode: "on",
			branch: [assistantEntry(700_000), warmEntry(990_000)],
			rebuild: rebuiltAs(),
		});

		await warmer.restore();

		// The last refresh renewed the entry; the age cap still counts from the real request.
		expect(warmer.status).toMatchObject({
			state: "scheduled",
			nextWarmAt: 1_280_000,
			warmSince: 700_000,
			refreshCount: 1,
			refreshCost: 0.01,
			decision: { phase: "idle" },
		});
		await vi.advanceTimersByTimeAsync(280_000);
		expect(calls).toHaveLength(1);
		warmer.cancel();
	});

	it("does not resume an expired, rewritten, or foreign cache entry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(400_000);
		const expired = fakeRuntime({ mode: "on", branch: [assistantEntry(0)], rebuild: rebuiltAs() });
		await expired.warmer.restore();
		expect(expired.warmer.status.reason).toBe("prompt cache already expired");

		const compaction = {
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp: new Date(350_000).toISOString(),
			summary: "s",
			firstKeptEntryId: "x",
			tokensBefore: 1,
		} satisfies SessionEntry;
		const rewritten = fakeRuntime({
			mode: "on",
			branch: [assistantEntry(300_000), compaction],
			rebuild: rebuiltAs(),
		});
		await rewritten.warmer.restore();
		expect(rewritten.warmer.status.reason).toBe("context rewritten since the last request");

		const foreign = fakeRuntime({ mode: "on", branch: [assistantEntry(300_000)], rebuild: rebuiltAs(openaiModel) });
		await foreign.warmer.restore();
		expect(foreign.warmer.status.reason).toBe("model changed since the last request");

		// Streaming-only warming never runs between agent runs, so there is nothing to resume.
		const streaming = fakeRuntime({ mode: "streaming", branch: [assistantEntry(300_000)], rebuild: rebuiltAs() });
		await streaming.warmer.restore();
		expect(streaming.warmer.status.state).toBe("inactive");
		await vi.advanceTimersByTimeAsync(600_000);
		expect([expired, rewritten, foreign, streaming].flatMap((runtime) => runtime.calls)).toHaveLength(0);
	});

	it("leaves warming to a real request that starts while the transcript is rebuilt", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(400_000);
		let finishRebuild!: () => void;
		const { warmer } = fakeRuntime({
			mode: "on",
			branch: [assistantEntry(300_000)],
			rebuild: () =>
				new Promise((resolve) => {
					finishRebuild = () => resolve({ request: request(), isCurrent: current });
				}),
		});

		const restoring = warmer.restore();
		warmer.start(request(), current);
		finishRebuild();
		await restoring;

		expect(warmer.status).toMatchObject({ state: "scheduled", warmSince: 400_000, refreshCount: 0 });

		// A real request that could not be warmed leaves no run behind, yet it still supersedes the restore.
		warmer.cancel();
		const restoringAgain = warmer.restore();
		warmer.start(request(budgetModel, { reasoning: "high" }), current);
		finishRebuild();
		await restoringAgain;
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "request cannot be replayed safely" });
	});

	// Regression (review of PR #42): disposal during a slow rebuild must not revive warming.
	it("does not resume warming after being cancelled during the rebuild", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(400_000);
		let finishRebuild!: () => void;
		const { warmer, calls } = fakeRuntime({
			mode: "on",
			branch: [assistantEntry(300_000)],
			rebuild: () =>
				new Promise((resolve) => {
					finishRebuild = () => resolve({ request: request(), isCurrent: current });
				}),
		});

		const restoring = warmer.restore();
		warmer.cancel();
		finishRebuild();
		await restoring;

		expect(warmer.status).toMatchObject({ state: "inactive", reason: "inactive" });
		await vi.advanceTimersByTimeAsync(600_000);
		expect(calls).toHaveLength(0);
	});

	it("formats status and usage entries", () => {
		const decision: CacheWarmingDecision = {
			phase: "idle",
			warmCost: 0.013,
			missCost: 0.621,
			continuationProbability: 0.6,
			expectedSavings: 0.36,
			economicsAvailable: true,
			explicit: false,
			action: "warm",
		};
		expect(formatCacheWarmingStatus({ state: "scheduled", nextWarmAt: 222_000, decision }, 0)).toBe(
			"Decision in 3m 42s (60% continuation probability, expected savings $0.360 >= $0.050 -> warm)",
		);
		const usage = {
			...warmUsage,
			cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
		};
		const entry = SessionManager.inMemory().appendUsage(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			usage,
			"extension override",
		);
		expect(formatCacheWarmingUsage(entry)).toBe("Cache warmed (extension override): $0.029497");

		// JBMOD: indicator line above the editor.
		expect(
			formatCacheWarmingIndicator(
				{
					mode: "on",
					status: { state: "scheduled", decision, warmSince: 0, refreshCount: 3, refreshCost: 0.1234 },
				},
				723_000,
			),
		).toBe("Cache warming (on) · held warm for 12m 03s · 3 refreshes · maintenance cost $0.123");
		expect(
			formatCacheWarmingIndicator({
				mode: "idle",
				status: { state: "inactive", reason: "refresh missed the cache (entry expired or replay differs)" },
			}),
		).toBe("Cache warming (idle) · stopped: refresh missed the cache (entry expired or replay differs)");
	});
});

describe("ExtensionRunner.emitCacheWarmingDecision", () => {
	it("uses the last extension override", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const factories: ExtensionFactory[] = [
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
			},
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "stop" }));
			},
		];
		const extensions = [];
		for (const factory of factories) {
			extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		const event: CacheWarmingDecisionEvent = {
			type: "cache_warming_decision",
			warmCost: 0.05,
			missCost: 0.5,
			continuationProbability: 0.15,
			action: "warm",
		};

		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
	});
});

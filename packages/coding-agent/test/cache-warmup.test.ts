import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentSession,
	PromptCacheSystemPromptSnapshot,
	PromptCacheWarmResult,
} from "../src/core/agent-session.ts";
import {
	CACHE_WARM_MARKER_TYPE,
	CacheWarmController,
	type CacheWarmMarker,
	type ForegroundCacheRefresh,
	isCacheWarmEntry,
	omitCacheWarmEntries,
} from "../src/core/cache-warmup.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const START_TIME = new Date("2026-08-23T12:00:00.000Z").getTime();
const SHORT_TTL_MS = 5 * 60 * 1000;
const LONG_TTL_MS = 60 * 60 * 1000;
const WARM_LEAD_MS = 10 * 1000;
const BASE_PROMPT = "base";
const BASE_PROMPT_SNAPSHOT: PromptCacheSystemPromptSnapshot = {
	version: 1,
	baseHash: "base-hash",
	prefixLength: BASE_PROMPT.length,
	suffix: "",
};

function makeUsage(cost = 0): Usage {
	return {
		input: 1,
		output: 0,
		cacheRead: 1,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: cost, cacheWrite: 0, total: cost },
	};
}

function makeUsageWithoutCacheActivity(cost = 0): Usage {
	return {
		input: 1,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "proxy",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

function makeAssistant(timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "proxy",
		model: "claude-test",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp,
	};
}

/** Create a complete foreground cache proof at the manager's currently selected leaf. */
function makeForegroundRefresh(
	manager: SessionManager,
	warmedAt: number,
	overrides: Partial<Omit<ForegroundCacheRefresh, "warmedAt">> = {},
): ForegroundCacheRefresh {
	return {
		provider: "proxy",
		model: "claude-test",
		cacheIdentity: "identity",
		leafId: manager.getLeafId(),
		generation: 0,
		warmedAt,
		...overrides,
	};
}

function makeMarker(options: {
	warmedAt: number;
	retention?: PromptCacheWarmResult["retention"];
	totalCost?: number;
	cacheIdentity?: string;
	systemPrompt?: PromptCacheSystemPromptSnapshot;
	cacheActive?: boolean;
}): CacheWarmMarker {
	const retention = options.retention ?? "short";
	const ttl = retention === "long" ? LONG_TTL_MS : SHORT_TTL_MS;
	const cacheActive = options.cacheActive ?? true;
	return {
		version: 1,
		api: "anthropic-messages",
		provider: "proxy",
		model: "claude-test",
		cacheIdentity: options.cacheIdentity ?? "identity",
		systemPrompt: options.systemPrompt ?? BASE_PROMPT_SNAPSHOT,
		cacheActive,
		retention,
		warmedAt: options.warmedAt,
		expiresAt: cacheActive ? options.warmedAt + ttl : options.warmedAt,
		warmSince: options.warmedAt - 60_000,
		refreshCount: 2,
		totalCost: options.totalCost ?? 0.02,
	};
}

function makeSession(options: {
	manager: SessionManager;
	retention?: PromptCacheWarmResult["retention"];
	canWarmPromptCache?: boolean;
	isIdle?: boolean;
	isPauseRequested?: boolean;
	systemPrompt?: string;
	getIdentity?: (systemPrompt: string) => string | undefined;
	createSnapshot?: (systemPrompt: string) => PromptCacheSystemPromptSnapshot;
	restoreSnapshot?: (snapshot: PromptCacheSystemPromptSnapshot) => string | undefined;
	warm?: (signal?: AbortSignal, systemPrompt?: string, expiresAt?: number) => Promise<PromptCacheWarmResult>;
}): { session: AgentSession; warm: ReturnType<typeof vi.fn> } {
	const retention = options.retention ?? "short";
	const warm = vi.fn(
		options.warm ??
			(async () => ({
				warmedAt: Date.now(),
				retention,
				usage: makeUsage(0.005),
			})),
	);
	const session = {
		model: makeModel(),
		sessionManager: options.manager,
		isIdle: options.isIdle ?? true,
		isPauseRequested: options.isPauseRequested ?? false,
		canWarmPromptCache: options.canWarmPromptCache ?? true,
		isCompacting: false,
		systemPrompt: options.systemPrompt ?? BASE_PROMPT,
		getPromptCacheIdentity: options.getIdentity ?? (() => "identity"),
		createPromptCacheSystemPromptSnapshot: options.createSnapshot ?? (() => BASE_PROMPT_SNAPSHOT),
		restorePromptCacheSystemPrompt:
			options.restoreSnapshot ??
			((snapshot: PromptCacheSystemPromptSnapshot) =>
				snapshot.baseHash === BASE_PROMPT_SNAPSHOT.baseHash ? BASE_PROMPT : undefined),
		getPromptCacheRetention: async () => retention,
		warmPromptCache: warm,
	} as unknown as AgentSession;
	return { session, warm };
}

describe("CacheWarmController", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START_TIME);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits for the first foreground request in an empty session", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-empty-test");
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();
		await vi.advanceTimersByTimeAsync(SHORT_TTL_MS * 2);

		expect(warm).not.toHaveBeenCalled();
		expect(manager.getBranch()).toEqual([]);
		expect(controller.getState()).toMatchObject({ enabled: true, active: false, refreshCount: 0, totalCost: 0 });
		await controller.dispose();
	});

	it("adopts a foreground-warmed lease when warming is enabled after the turn", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-interactive-enable-test");
		const foregroundWarmedAt = START_TIME - 30_000;
		manager.appendMessage(makeAssistant(foregroundWarmedAt));
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: false });

		await controller.start();
		await controller.pause();
		await controller.resumeAfterForegroundRequest(makeForegroundRefresh(manager, foregroundWarmedAt));

		// Warming stays inert while disabled, but the foreground cache proof must survive a later interactive opt-in.
		expect(manager.getBranch().some(isCacheWarmEntry)).toBe(false);
		expect(controller.getState()).toMatchObject({ enabled: false, active: false });

		await controller.setEnabled(true);

		expect(controller.getState()).toMatchObject({
			enabled: true,
			active: true,
			warmSince: foregroundWarmedAt,
			refreshCount: 0,
			totalCost: 0,
		});
		expect(manager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: CACHE_WARM_MARKER_TYPE,
			data: { warmedAt: foregroundWarmedAt, warmSince: foregroundWarmedAt },
		});

		// The adopted lease schedules maintenance against its original provider expiry, not a fictitious new TTL.
		await vi.advanceTimersByTimeAsync(foregroundWarmedAt + SHORT_TTL_MS - WARM_LEAD_MS - START_TIME);
		expect(warm).toHaveBeenCalledTimes(1);
		await controller.dispose();
	});

	it("does not carry a disabled foreground lease onto a sibling branch", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-interactive-enable-branch-test");
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: START_TIME - 120_000 });
		manager.appendMessage({ role: "user", content: "branch A", timestamp: START_TIME - 60_000 });
		manager.appendMessage(makeAssistant(START_TIME - 30_000));
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: false });

		await controller.start();
		await controller.resumeAfterForegroundRequest(makeForegroundRefresh(manager, START_TIME - 30_000));

		// Move the selected leaf away from the response that proved the provider cache was warm.
		manager.branch(rootId);
		manager.appendMessage({ role: "user", content: "branch B", timestamp: START_TIME - 10_000 });
		await controller.setEnabled(true);

		expect(controller.getState()).toMatchObject({ enabled: true, active: false, cold: false });
		expect(manager.getBranch().some(isCacheWarmEntry)).toBe(false);
		expect(warm).not.toHaveBeenCalled();
		await controller.dispose();
	});

	it("keeps the newest foreground proof when pause continuations settle out of order", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-out-of-order-settle-test");
		manager.appendMessage({ role: "user", content: "turn A", timestamp: START_TIME - 60_000 });
		const turnARefresh = makeForegroundRefresh(manager, START_TIME - 30_000);
		manager.appendMessage({ role: "user", content: "turn B", timestamp: START_TIME - 20_000 });
		const turnBRefresh = makeForegroundRefresh(manager, START_TIME - 10_000);
		const { session } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: false });

		await controller.start();
		// Turn B's listener may finish before the older turn A listener that launched it.
		await controller.resumeAfterForegroundRequest(turnBRefresh);
		await controller.resumeAfterForegroundRequest(turnARefresh);
		await controller.setEnabled(true);

		expect(controller.getState()).toMatchObject({ active: true, warmSince: turnBRefresh.warmedAt });
		expect(manager.getBranch().at(-1)).toMatchObject({ data: { warmedAt: turnBRefresh.warmedAt } });
		await controller.dispose();
	});

	it("rejects a retained foreground proof after the prompt cache identity changes", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-retained-identity-test");
		manager.appendMessage(makeAssistant(START_TIME - 30_000));
		let cacheIdentity = "identity";
		const { session, warm } = makeSession({ manager, getIdentity: () => cacheIdentity });
		const controller = new CacheWarmController(session, { enabled: false });

		await controller.start();
		await controller.resumeAfterForegroundRequest(makeForegroundRefresh(manager, START_TIME - 30_000));
		// Extensions can change active tools while warming is disabled without calling controller.invalidate().
		cacheIdentity = "changed-identity";
		await controller.setEnabled(true);

		expect(controller.getState()).toMatchObject({ enabled: true, active: false, cold: false });
		expect(manager.getBranch().some(isCacheWarmEntry)).toBe(false);
		expect(warm).not.toHaveBeenCalled();
		await controller.dispose();
	});

	it("resumes a still-warm short lease and refreshes it ten seconds before expiry", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-test");
		const requestTime = START_TIME - 60_000;
		const existingMarker = makeMarker({ warmedAt: requestTime });
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, existingMarker);
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();
		expect(controller.getState()).toMatchObject({
			active: true,
			warmSince: existingMarker.warmSince,
			totalCost: existingMarker.totalCost,
		});
		expect(warm).not.toHaveBeenCalled();

		const delay = requestTime + SHORT_TTL_MS - WARM_LEAD_MS - START_TIME;
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(warm).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(warm).toHaveBeenCalledTimes(1);

		const markerEntry = manager.getBranch().at(-1);
		expect(markerEntry).toMatchObject({ type: "custom", customType: CACHE_WARM_MARKER_TYPE });
		if (markerEntry?.type !== "custom") throw new Error("Expected cache warm marker");
		expect(markerEntry.data).toMatchObject({ refreshCount: 3, totalCost: 0.025 });
		await controller.dispose();
	});

	it("refreshes a proven foreground lease while a long-running tool is active", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-tool-execution-test");
		const { session, warm } = makeSession({ manager, isIdle: false, canWarmPromptCache: true });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.pause();
		await controller.resumeAfterForegroundRequest(makeForegroundRefresh(manager, START_TIME));

		// Keep the tool pending across the lease refresh boundary; the event loop remains available to maintenance.
		await vi.advanceTimersByTimeAsync(SHORT_TTL_MS - WARM_LEAD_MS);

		expect(warm).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toMatchObject({ idle: false, active: true, refreshCount: 1 });
		await controller.dispose();
	});

	it("keeps maintenance visible while a requested pause drains through active tools", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-pause-requested-test");
		const requestTime = START_TIME - 60_000;
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, makeMarker({ warmedAt: requestTime }));
		const { session, warm } = makeSession({
			manager,
			isIdle: false,
			isPauseRequested: true,
			canWarmPromptCache: true,
		});
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();

		// Once tools make maintenance safe, a requested pause must keep both the scheduler and its box active.
		expect(controller.getState()).toMatchObject({ idle: true, active: true });
		await vi.advanceTimersByTimeAsync(requestTime + SHORT_TTL_MS - WARM_LEAD_MS - START_TIME);
		expect(warm).toHaveBeenCalledTimes(1);
		await controller.dispose();
	});

	it("does not send a delayed refresh after the cache lease has expired", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-delayed-expiry-test");
		const requestTime = START_TIME - 60_000;
		const existingMarker = makeMarker({ warmedAt: requestTime });
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, existingMarker);
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();

		// Simulate suspension across the scheduled refresh and the cache's hard expiry.
		vi.setSystemTime(existingMarker.expiresAt + 1);
		await vi.runOnlyPendingTimersAsync();

		expect(warm).not.toHaveBeenCalled();
		expect(controller.getState()).toMatchObject({
			active: false,
			cold: true,
			retrying: false,
			refreshCount: existingMarker.refreshCount,
			totalCost: existingMarker.totalCost,
		});

		// A cold lease is terminal until a foreground request creates a new cache.
		await vi.advanceTimersByTimeAsync(SHORT_TTL_MS);
		expect(warm).not.toHaveBeenCalled();
		await controller.dispose();
	});

	it("aborts asynchronous warmup preparation when the lease expires", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-preparation-expiry-test");
		const requestTime = START_TIME - 60_000;
		const existingMarker = makeMarker({ warmedAt: requestTime });
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, existingMarker);
		let providerDispatches = 0;
		const { session, warm } = makeSession({
			manager,
			warm: async (signal) => {
				// Hold request preparation until the proven cache lease has crossed its hard expiry.
				await new Promise((resolve) => setTimeout(resolve, WARM_LEAD_MS + 1));
				if (signal?.aborted) throw new Error("Cache lease expired during preparation");
				providerDispatches++;
				return { warmedAt: Date.now(), retention: "short", usage: makeUsage(0.005) };
			},
		});
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();
		const refreshDelay = existingMarker.expiresAt - WARM_LEAD_MS - START_TIME;
		await vi.advanceTimersByTimeAsync(refreshDelay);
		expect(warm).toHaveBeenCalledTimes(1);
		expect(controller.getState().warming).toBe(true);

		await vi.advanceTimersByTimeAsync(WARM_LEAD_MS + 1);

		expect(providerDispatches).toBe(0);
		expect(controller.getState()).toMatchObject({ active: false, cold: true, retrying: false, warming: false });

		// Expiry cancellation is terminal; it must not enter the ordinary error retry loop.
		await vi.advanceTimersByTimeAsync(SHORT_TTL_MS);
		expect(warm).toHaveBeenCalledTimes(1);
		await controller.dispose();
	});

	it("reconstructs an extension-modified prompt when resuming a still-warm lease", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-resume-prompt-test");
		const effectivePrompt = `${BASE_PROMPT}\n\nextension context`;
		const effectiveIdentity = "effective-identity";
		const promptSnapshot: PromptCacheSystemPromptSnapshot = {
			...BASE_PROMPT_SNAPSHOT,
			suffix: effectivePrompt.slice(BASE_PROMPT.length),
		};
		const requestTime = START_TIME - 60_000;
		manager.appendCustomEntry(
			CACHE_WARM_MARKER_TYPE,
			makeMarker({ warmedAt: requestTime, cacheIdentity: effectiveIdentity, systemPrompt: promptSnapshot }),
		);
		const { session, warm } = makeSession({
			manager,
			systemPrompt: BASE_PROMPT,
			getIdentity: (systemPrompt) => (systemPrompt === effectivePrompt ? effectiveIdentity : "base-identity"),
			createSnapshot: () => BASE_PROMPT_SNAPSHOT,
			restoreSnapshot: (snapshot) =>
				snapshot.baseHash === BASE_PROMPT_SNAPSHOT.baseHash
					? BASE_PROMPT.slice(0, snapshot.prefixLength) + snapshot.suffix
					: undefined,
		});
		const controller = new CacheWarmController(session, { enabled: true });

		// Replay must activate immediately even though the newly constructed session still exposes only its base prompt.
		await controller.start();
		expect(controller.getState()).toMatchObject({ active: true, warmSince: requestTime - 60_000 });
		expect(warm).not.toHaveBeenCalled();

		// The scheduled maintenance request must use the reconstructed prompt, not the resumed session's base prompt.
		const delay = requestTime + SHORT_TTL_MS - WARM_LEAD_MS - START_TIME;
		await vi.advanceTimersByTimeAsync(delay);
		expect(warm).toHaveBeenCalledTimes(1);
		expect(warm.mock.calls[0]?.[1]).toBe(effectivePrompt);
		expect(manager.getBranch().at(-1)).toMatchObject({
			data: { cacheIdentity: effectiveIdentity, systemPrompt: promptSnapshot, refreshCount: 3 },
		});
		await controller.dispose();
	});

	it("drops a lease without retry churn when maintenance reports no cache activity", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-no-activity-test");
		const requestTime = START_TIME - 60_000;
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, makeMarker({ warmedAt: requestTime }));
		const { session, warm } = makeSession({
			manager,
			warm: async () => ({
				warmedAt: Date.now(),
				retention: "short",
				usage: makeUsageWithoutCacheActivity(0.001),
			}),
		});
		const errors: string[] = [];
		const controller = new CacheWarmController(session, {
			enabled: true,
			onError: (message) => errors.push(message),
		});

		await controller.start();
		const delay = requestTime + SHORT_TTL_MS - WARM_LEAD_MS - START_TIME;
		await vi.advanceTimersByTimeAsync(delay);

		expect(warm).toHaveBeenCalledTimes(1);
		expect(controller.getState()).toMatchObject({
			active: false,
			cacheUnavailable: true,
			retrying: false,
			refreshCount: 2,
			totalCost: 0.021,
		});
		expect(errors).toEqual(["Cache warming reported no cache read or cache write"]);
		expect(manager.getBranch()).toHaveLength(2);
		expect(manager.getBranch().at(-1)).toMatchObject({
			data: { cacheActive: false, refreshCount: 2, totalCost: 0.021 },
		});

		// An endpoint that ignores cache control must not be polled and billed every retry interval.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(warm).toHaveBeenCalledTimes(1);
		await controller.dispose();

		// The terminal result remains branch-local durable accounting instead of resurrecting the previous lease.
		const resumed = new CacheWarmController(session, { enabled: true });
		await resumed.start();
		expect(resumed.getState()).toMatchObject({
			active: false,
			cacheUnavailable: true,
			retrying: false,
			refreshCount: 2,
			totalCost: 0.021,
		});
		await resumed.dispose();
	});

	it("keeps a newer inactive marker authoritative over retained foreground proof", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-inactive-marker-precedence-test");
		const foregroundWarmedAt = START_TIME - 30_000;
		manager.appendMessage(makeAssistant(foregroundWarmedAt));
		const foregroundRefresh = makeForegroundRefresh(manager, foregroundWarmedAt);
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: false });

		await controller.start();
		await controller.resumeAfterForegroundRequest(foregroundRefresh);
		// A later maintenance miss closes this warm span and must not be bypassed by toggling warming back on.
		manager.appendCustomEntry(
			CACHE_WARM_MARKER_TYPE,
			makeMarker({ warmedAt: START_TIME - 10_000, cacheActive: false }),
		);
		await controller.setEnabled(true);

		expect(controller.getState()).toMatchObject({ active: false, cacheUnavailable: true, retrying: false });
		expect(manager.getBranch()).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(SHORT_TTL_MS);
		expect(warm).not.toHaveBeenCalled();
		await controller.dispose();
	});

	it("replays long retention and cumulative maintenance cost from an active-branch marker", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-long-test");
		manager.appendCustomEntry(
			CACHE_WARM_MARKER_TYPE,
			makeMarker({ warmedAt: START_TIME - 30_000, retention: "long", totalCost: 0.123 }),
		);
		const { session, warm } = makeSession({ manager, retention: "long" });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();
		expect(controller.getState()).toMatchObject({
			active: true,
			expiresAt: START_TIME - 30_000 + LONG_TTL_MS,
			refreshCount: 2,
			totalCost: 0.123,
		});
		expect(warm).not.toHaveBeenCalled();
		await controller.dispose();
	});

	it("does not attribute a foreground refresh from another model to the selected cache identity", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-model-identity-test");
		const existingMarker = makeMarker({ warmedAt: START_TIME - 60_000 });
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, existingMarker);
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.pause();
		await controller.resumeAfterForegroundRequest(
			makeForegroundRefresh(manager, START_TIME - 10_000, {
				provider: "another-provider",
				model: "another-model",
			}),
		);

		expect(manager.getBranch()).toHaveLength(1);
		expect(manager.getBranch()[0]).toMatchObject({ data: { warmedAt: existingMarker.warmedAt } });
		expect(controller.getState()).toMatchObject({ warmSince: existingMarker.warmSince });
		expect(warm).not.toHaveBeenCalled();
		await controller.dispose();
	});

	it("starts a fresh duration and cost chain after a persisted lease expired", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-expired-test");
		manager.appendCustomEntry(
			CACHE_WARM_MARKER_TYPE,
			makeMarker({ warmedAt: START_TIME - SHORT_TTL_MS - 120_000, totalCost: 0.123 }),
		);
		const assistantTime = START_TIME - 60_000;
		manager.appendMessage(makeAssistant(assistantTime));
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();
		expect(controller.getState()).toMatchObject({
			active: false,
			cold: true,
			refreshCount: 2,
			totalCost: 0.123,
		});
		expect(warm).not.toHaveBeenCalled();

		await controller.pause();
		await controller.resumeAfterForegroundRequest(makeForegroundRefresh(manager, assistantTime));

		expect(controller.getState()).toMatchObject({
			active: true,
			warmSince: assistantTime,
			refreshCount: 0,
			totalCost: 0,
		});
		expect(warm).not.toHaveBeenCalled();
		expect(manager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: CACHE_WARM_MARKER_TYPE,
			data: { warmedAt: assistantTime, totalCost: 0 },
		});
		await controller.dispose();
	});

	it("waits for a foreground request after prompt invalidation", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-invalidated-test");
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, makeMarker({ warmedAt: START_TIME - 30_000 }));
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();
		expect(controller.getState().active).toBe(true);
		const staleRefresh = makeForegroundRefresh(manager, Date.now());
		await controller.invalidate();
		await vi.advanceTimersByTimeAsync(SHORT_TTL_MS);

		expect(warm).not.toHaveBeenCalled();
		expect(controller.getState()).toMatchObject({ active: false, refreshCount: 0, totalCost: 0 });

		// A response started before invalidation cannot reactivate the discarded prompt generation.
		await controller.resumeAfterForegroundRequest(staleRefresh);
		expect(controller.getState()).toMatchObject({ active: false, refreshCount: 0, totalCost: 0 });

		await controller.resumeAfterForegroundRequest(
			makeForegroundRefresh(manager, Date.now(), {
				generation: controller.getForegroundRefreshGeneration(),
			}),
		);
		expect(controller.getState()).toMatchObject({ active: true, warmSince: Date.now(), refreshCount: 0 });
		await controller.dispose();
	});

	it("ignores a warm marker on a sibling branch", async () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-tree-test");
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: START_TIME - 120_000 });
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, makeMarker({ warmedAt: START_TIME - 30_000 }));
		manager.branch(rootId);
		const { session, warm } = makeSession({ manager });
		const controller = new CacheWarmController(session, { enabled: true });

		await controller.start();
		expect(warm).not.toHaveBeenCalled();
		expect(manager.getBranch()).toHaveLength(1);

		// A real request on the selected branch establishes the only lease the scheduler may maintain.
		await controller.pause();
		await controller.resumeAfterForegroundRequest(makeForegroundRefresh(manager, START_TIME));
		expect(manager.getBranch().at(-1)).toMatchObject({
			type: "custom",
			customType: CACHE_WARM_MARKER_TYPE,
			parentId: rootId,
		});
		await controller.dispose();
	});

	it("removes markers from visible projections and reconnects their tree descendants", () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-projection-test");
		const rootId = manager.appendMessage({ role: "user", content: "root", timestamp: START_TIME - 120_000 });
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, makeMarker({ warmedAt: START_TIME - 60_000 }));
		const childId = manager.appendMessage(makeAssistant(START_TIME - 30_000));
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, makeMarker({ warmedAt: START_TIME - 10_000 }));

		const projected = omitCacheWarmEntries(manager.getEntries(), manager.getLeafId());

		expect(projected.entries.map((entry) => entry.id)).toEqual([rootId, childId]);
		expect(projected.entries[1]?.parentId).toBe(rootId);
		expect(projected.leafId).toBe(childId);
	});
});

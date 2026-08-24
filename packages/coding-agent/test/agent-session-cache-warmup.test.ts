import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

interface WarmRequestCapture {
	context?: Context;
	options?: SimpleStreamOptions;
}

describe("AgentSession prompt-cache warming", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-cache-warmup-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Create a session whose provider captures the private maintenance boundary without network traffic. */
	async function createCapturedSession(model: Model<"anthropic-messages">): Promise<{
		session: Awaited<ReturnType<typeof createAgentSession>>["session"];
		capture: WarmRequestCapture;
	}> {
		const cwd = join(tempDir, model.id, "project");
		const agentDir = join(tempDir, model.id, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		const capture: WarmRequestCapture = {};

		// Capture the provider boundary so each test proves the exact private request without billing tokens.
		modelRegistry.registerProvider(model.provider, {
			api: "anthropic-messages",
			streamSimple: (_model, context, options) => {
				capture.context = context;
				capture.options = options;
				const stream = createAssistantMessageEventStream();
				const response: AssistantMessage = {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 0,
						cacheRead: 10,
						cacheWrite: 0,
						totalTokens: 11,
						cost: { input: 0, output: 0, cacheRead: 0.001, cacheWrite: 0, total: 0.001 },
					},
					stopReason: "stop",
					timestamp: 1234,
				};
				stream.end(response);
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
		});
		return { session, capture };
	}

	it("uses a zero-token private dot when thinking is disabled without changing session state", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-cache-off-test",
			name: "Claude Cache Test",
			api: "anthropic-messages",
			provider: "cache-off-test-provider",
			baseUrl: "https://cache-test.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const { session, capture } = await createCapturedSession(model);
		const sessionManager = session.sessionManager;
		session.agent.state.messages = [{ role: "user", content: "existing prompt", timestamp: 1000 }];
		const baseIdentity = session.getPromptCacheIdentity();
		session.agent.state.systemPrompt = "effective extension-modified prompt";
		const messagesBefore = structuredClone(session.agent.state.messages);
		const entriesBefore = structuredClone(sessionManager.getEntries());

		const result = await session.warmPromptCache();

		expect(session.getPromptCacheIdentity()).not.toBe(baseIdentity);
		expect(capture.context).toMatchObject({ systemPrompt: "effective extension-modified prompt" });
		expect(capture.context?.messages.at(-1)).toMatchObject({ role: "user", content: "." });
		expect(capture.options).toMatchObject({ maxTokens: 0, promptCacheWarmup: true, cacheRetention: "short" });
		expect(capture.options?.reasoning).toBeUndefined();
		expect(result).toMatchObject({ warmedAt: 1234, retention: "short", usage: { cacheRead: 10 } });
		expect(session.agent.state.messages).toEqual(messagesBefore);
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("round-trips a compact extension prompt snapshot for resumed cache maintenance", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-cache-resume-test",
			name: "Claude Cache Resume Test",
			api: "anthropic-messages",
			provider: "cache-resume-test-provider",
			baseUrl: "https://cache-test.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const { session, capture } = await createCapturedSession(model);
		const basePrompt = session.systemPrompt;
		const effectivePrompt = `${basePrompt}\n\nRuntime extension context`;
		session.agent.state.systemPrompt = effectivePrompt;
		const effectiveIdentity = session.getPromptCacheIdentity();

		// Capture the smallest exact delta while the foreground request's effective prompt is still live.
		const snapshot = session.createPromptCacheSystemPromptSnapshot();
		expect(snapshot).toMatchObject({ prefixLength: basePrompt.length, suffix: "\n\nRuntime extension context" });

		// A resumed session starts from its base prompt but can reconstruct and verify the warm lease privately.
		session.agent.state.systemPrompt = basePrompt;
		const restoredPrompt = session.restorePromptCacheSystemPrompt(snapshot);
		expect(restoredPrompt).toBe(effectivePrompt);
		expect(session.getPromptCacheIdentity(restoredPrompt)).toBe(effectiveIdentity);
		expect(session.restorePromptCacheSystemPrompt({ ...snapshot, baseHash: "changed-base" })).toBeUndefined();
		const expiresAt = 5_000;
		await session.warmPromptCache(undefined, restoredPrompt, expiresAt);

		expect(capture.context?.systemPrompt).toBe(effectivePrompt);
		expect(capture.options?.promptCacheWarmupExpiresAt).toBe(expiresAt);
		expect(session.systemPrompt).toBe(basePrompt);
	});

	it("allows maintenance during tool execution but rejects other active agent phases", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-cache-tool-test",
			name: "Claude Cache Tool Test",
			api: "anthropic-messages",
			provider: "cache-tool-test-provider",
			baseUrl: "https://cache-test.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const { session, capture } = await createCapturedSession(model);
		Reflect.set(session, "_isAgentRunActive", true);

		await expect(session.warmPromptCache()).rejects.toThrow(
			"Prompt cache can only be warmed while the session is idle or executing tools",
		);

		// A pending tool means the preceding provider response is complete and no foreground request is in flight.
		const pendingToolCalls = Reflect.get(session.agent.state, "pendingToolCalls") as Set<string>;
		pendingToolCalls.add("long-tool");
		await session.warmPromptCache();

		expect(capture.options).toMatchObject({ promptCacheWarmup: true });
	});

	it("drains hidden maintenance at the awaited boundary before a tool-loop continuation", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-cache-next-turn-test",
			name: "Claude Cache Next Turn Test",
			api: "anthropic-messages",
			provider: "cache-next-turn-test-provider",
			baseUrl: "https://cache-test.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const { session } = await createCapturedSession(model);
		let releaseBarrier: (() => void) | undefined;
		const barrier = vi.fn(
			async () =>
				await new Promise<void>((resolve) => {
					releaseBarrier = resolve;
				}),
		);
		session.setBeforeProviderRequest(barrier);
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};

		let prepared = false;
		const prepareNextTurn = session.agent.prepareNextTurnWithContext;
		if (!prepareNextTurn) throw new Error("Expected AgentSession to install next-turn preparation");
		const preparation = Promise.resolve(
			prepareNextTurn({
				message,
				toolResults: [],
				context: {
					systemPrompt: session.systemPrompt,
					messages: [message],
					tools: session.agent.state.tools,
				},
				newMessages: [message],
			}),
		).then(() => {
			prepared = true;
		});

		await vi.waitFor(() => expect(barrier).toHaveBeenCalledTimes(1));
		expect(prepared).toBe(false);
		// The continuation may advance only after the hidden request has fully drained.
		releaseBarrier?.();
		await preparation;
		expect(barrier).toHaveBeenCalledTimes(1);
	});

	it("drains hidden provider work before unsummarized tree navigation moves the leaf", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-cache-tree-test",
			name: "Claude Cache Tree Test",
			api: "anthropic-messages",
			provider: "cache-tree-test-provider",
			baseUrl: "https://cache-test.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const { session } = await createCapturedSession(model);
		const manager = session.sessionManager;
		const targetId = manager.appendMessage({ role: "user", content: "target", timestamp: 1 });
		const targetParentId = manager.getEntry(targetId)?.parentId ?? null;
		const oldLeafId = manager.appendMessage({ role: "user", content: "current branch", timestamp: 2 });
		let releaseBarrier: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		const barrierStarted = vi.fn();
		session.setBeforeProviderRequest(async () => {
			barrierStarted();
			await barrier;
		});

		// Hold the private provider request open and prove navigation cannot cross the session-tree boundary yet.
		const navigation = session.navigateTree(targetId, { summarize: false });
		await vi.waitFor(() => expect(barrierStarted).toHaveBeenCalledTimes(1));
		expect(manager.getLeafId()).toBe(oldLeafId);

		// Once maintenance drains, navigation may safely select the other branch.
		releaseBarrier?.();
		await navigation;
		expect(manager.getLeafId()).toBe(targetParentId);
	});

	it("keeps adaptive thinking and effort on a zero-token private dot", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-cache-adaptive-test",
			name: "Claude Adaptive Cache Test",
			api: "anthropic-messages",
			provider: "cache-adaptive-test-provider",
			baseUrl: "https://cache-test.invalid",
			compat: { forceAdaptiveThinking: true },
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 8192,
		};
		const { session, capture } = await createCapturedSession(model);
		const thinkingOffIdentity = session.getPromptCacheIdentity();
		session.setThinkingLevel("high");
		session.agent.state.systemPrompt = "effective adaptive prompt";

		await session.warmPromptCache();

		expect(session.getPromptCacheIdentity()).not.toBe(thinkingOffIdentity);
		expect(capture.context).toMatchObject({ systemPrompt: "effective adaptive prompt" });
		expect(capture.context?.messages.at(-1)).toMatchObject({ role: "user", content: "." });
		expect(capture.options).toMatchObject({
			maxTokens: 0,
			promptCacheWarmup: true,
			reasoning: "high",
		});
	});

	it("reserves one answer token and requests OK with budget-based extended thinking", async () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-cache-budget-test",
			name: "Claude Budget Cache Test",
			api: "anthropic-messages",
			provider: "cache-budget-test-provider",
			baseUrl: "https://cache-test.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1.25 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		};
		const { session, capture } = await createCapturedSession(model);
		session.setThinkingLevel("high");
		session.agent.state.systemPrompt = "effective budget-thinking prompt";

		await session.warmPromptCache();

		expect(capture.context).toMatchObject({ systemPrompt: "effective budget-thinking prompt" });
		expect(capture.context?.messages.at(-1)).toMatchObject({ role: "user", content: "Reply only with OK." });
		expect(capture.options).toMatchObject({
			maxTokens: 1,
			promptCacheWarmup: true,
			reasoning: "high",
		});
	});
});

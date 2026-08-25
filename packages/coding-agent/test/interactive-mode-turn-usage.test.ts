import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CacheWarmState, ForegroundCacheRefresh } from "../src/core/cache-warmup.ts";
import { createUsageTotals, type UsageTotals } from "../src/core/usage-totals.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface TurnUsageContext {
	turnUsage: UsageTotals | undefined;
	chatContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

interface CacheWarmRenderContext {
	cacheWarmContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

const showTurnUsage = Reflect.get(InteractiveMode.prototype, "showTurnUsage") as (this: TurnUsageContext) => void;
const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: object,
	event: AgentSessionEvent,
) => Promise<void>;
const renderCacheWarmState = Reflect.get(InteractiveMode.prototype, "renderCacheWarmState") as (
	this: CacheWarmRenderContext,
	state: CacheWarmState,
) => void;
const handleWarmCommand = Reflect.get(InteractiveMode.prototype, "handleWarmCommand") as (
	this: object,
	text: string,
) => Promise<void>;

function makeUsage(input: number, cost: number): Usage {
	return {
		input,
		output: input + 1,
		cacheRead: input + 2,
		cacheWrite: input + 3,
		totalTokens: input * 4 + 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function makeAssistant(usage: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("InteractiveMode turn usage", () => {
	beforeAll(() => initTheme("dark"));

	it("shows all foreground token classes and cost after a turn", () => {
		const context: TurnUsageContext = {
			turnUsage: {
				input: 1234,
				output: 56,
				cacheRead: 7890,
				cacheWrite: 345,
				cost: 0.01234,
			},
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
		};

		showTurnUsage.call(context);

		const rendered = stripAnsi(context.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Turn usage");
		expect(rendered).toContain("uncached input 1,234");
		expect(rendered).toContain("output 56");
		expect(rendered).toContain("cache read 7,890");
		expect(rendered).toContain("cache write 345");
		expect(rendered).toContain("cost $0.012");
		expect(context.turnUsage).toBeUndefined();
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("keeps one total across internal continuations and includes tool-reported usage", async () => {
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			turnUsage: undefined as UsageTotals | undefined,
			turnCacheRefresh: undefined as ForegroundCacheRefresh | undefined,
			foregroundCacheRequest: {
				provider: "test",
				model: "test",
				cacheIdentity: "identity-a",
				leafId: "leaf-a",
				generation: 0,
			},
			footer: { invalidate: vi.fn() },
			pendingTools: new Map(),
			runtimeHost: {
				session: {
					systemPrompt: "prompt-a",
					getPromptCacheIdentity: () => "identity-a",
					sessionManager: { getLeafId: () => "leaf-a" },
					settingsManager: { getShowTerminalProgress: () => false },
				},
			},
			cacheWarmController: { getForegroundRefreshGeneration: () => 0 },
			updateEditorBorderColor: vi.fn(),
			retryEscapeHandler: undefined,
			defaultEditor: {},
			workingVisible: false,
			clearStatusIndicator: vi.fn(),
			streamingComponent: undefined,
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		});

		// A retry or post-compaction continuation starts another agent loop inside the same settled run.
		await handleEvent.call(context, { type: "agent_start" });
		await handleEvent.call(context, { type: "message_end", message: makeAssistant(makeUsage(10, 0.01)) });
		await handleEvent.call(context, { type: "agent_start" });
		await handleEvent.call(context, {
			type: "message_end",
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "nested-model",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 2,
				usage: makeUsage(20, 0.02),
			},
		});

		expect(context.turnUsage).toEqual({
			input: 30,
			output: 32,
			cacheRead: 34,
			cacheWrite: 36,
			cost: 0.03,
		});
		expect(context.turnCacheRefresh).toEqual({
			provider: "test",
			model: "test",
			cacheIdentity: "identity-a",
			leafId: "leaf-a",
			generation: 0,
			warmedAt: 1,
		});
	});

	it("does not establish a foreground lease without reported cache activity", async () => {
		const context = {
			isInitialized: true,
			turnUsage: createUsageTotals(),
			turnCacheRefresh: undefined as ForegroundCacheRefresh | undefined,
			footer: { invalidate: vi.fn() },
			pendingTools: new Map(),
			settingsManager: { getShowTerminalProgress: () => false },
			streamingComponent: undefined,
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const usage = makeUsage(10, 0.01);
		usage.cacheRead = 0;
		usage.cacheWrite = 0;

		await handleEvent.call(context, { type: "message_end", message: makeAssistant(usage) });

		expect(context.turnCacheRefresh).toBeUndefined();
		expect(context.turnUsage).toEqual({
			input: 10,
			output: 11,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
		});
	});

	it("reopens cache maintenance with the latest foreground lease when tool execution starts", async () => {
		const resumeAfterForegroundRequest = vi.fn().mockResolvedValue(undefined);
		const markExecutionStarted = vi.fn();
		const capturedRefresh: ForegroundCacheRefresh = {
			provider: "test",
			model: "test",
			cacheIdentity: "identity-a",
			leafId: "leaf-a",
			generation: 0,
			warmedAt: 1,
		};
		const pendingToolCalls = new Set(["tool-1"]);
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			turnCacheRefresh: capturedRefresh,
			footer: { invalidate: vi.fn() },
			cacheWarmController: { resumeAfterForegroundRequest },
			runtimeHost: {
				session: {
					state: { pendingToolCalls },
					systemPrompt: "prompt-a",
					getPromptCacheIdentity: () => "identity-a",
					sessionManager: { getLeafId: () => "leaf-a" },
				},
			},
			pendingTools: new Map([["tool-1", { markExecutionStarted }]]),
			ui: { requestRender: vi.fn() },
		});

		await handleEvent.call(context, {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "long-tool",
			args: {},
		});

		expect(resumeAfterForegroundRequest).toHaveBeenCalledWith(capturedRefresh);
		expect(markExecutionStarted).toHaveBeenCalledTimes(1);

		// Parallel siblings share the first tool's maintenance window instead of racing duplicate scheduler syncs.
		pendingToolCalls.add("tool-2");
		context.pendingTools.set("tool-2", { markExecutionStarted });
		await handleEvent.call(context, {
			type: "tool_execution_start",
			toolCallId: "tool-2",
			toolName: "second-long-tool",
			args: {},
		});
		expect(resumeAfterForegroundRequest).toHaveBeenCalledTimes(1);
	});

	it("resumes cache maintenance when an Escape pause lands", async () => {
		const resumeAfterForegroundRequest = vi.fn().mockResolvedValue(undefined);
		const capturedRefresh: ForegroundCacheRefresh = {
			provider: "test",
			model: "test",
			cacheIdentity: "identity-a",
			leafId: "leaf-a",
			generation: 0,
			warmedAt: 1,
		};
		const showStatus = vi.fn();
		const updateEditorBorderColor = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			turnUsage: undefined,
			turnCacheRefresh: capturedRefresh,
			pausePendingMessages: [],
			runtimeHost: {
				session: {
					isPaused: true,
					systemPrompt: "prompt-a",
					getPromptCacheIdentity: () => "identity-a",
					sessionManager: { getLeafId: () => "leaf-a" },
				},
			},
			getAppKeyDisplay: () => "Escape",
			showStatus,
			updateEditorBorderColor,
			shutdownRequested: false,
			cacheWarmController: { resumeAfterForegroundRequest },
		});

		await handleEvent.call(context, { type: "agent_settled" });

		expect(showStatus).toHaveBeenCalledWith(
			"Paused before the next model request - type a message or press Escape to continue",
		);
		expect(updateEditorBorderColor).toHaveBeenCalledTimes(1);
		expect(resumeAfterForegroundRequest).toHaveBeenCalledWith(capturedRefresh);
	});

	it("keeps provider-bound cache proof through message-end hooks and pause continuation", async () => {
		const resumeAfterForegroundRequest = vi.fn().mockResolvedValue(undefined);
		let cacheIdentity = "identity-a";
		let leafId = "leaf-a";
		const sessionManager = { getLeafId: () => leafId };
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			turnUsage: createUsageTotals() as UsageTotals | undefined,
			turnCacheRefresh: undefined as ForegroundCacheRefresh | undefined,
			foregroundCacheRequest: {
				provider: "test",
				model: "test",
				cacheIdentity: "identity-a",
				leafId: "leaf-a",
				generation: 7,
			},
			pendingTools: new Map(),
			streamingComponent: undefined,
			ui: { requestRender: vi.fn() },
			runtimeHost: {
				session: {
					systemPrompt: "prompt",
					getPromptCacheIdentity: () => cacheIdentity,
					sessionManager,
				},
			},
			cacheWarmController: { resumeAfterForegroundRequest },
			handlePauseSettled: vi.fn(async () => {
				// Simulate an extension or parked continuation changing state after the response was observed.
				cacheIdentity = "identity-c";
				leafId = "leaf-c";
			}),
			checkShutdownRequested: vi.fn().mockResolvedValue(undefined),
		});

		// Extension message-end hooks have already changed session state before InteractiveMode sees the response.
		cacheIdentity = "identity-b";
		leafId = "leaf-b";
		await handleEvent.call(context, {
			type: "message_end",
			message: {
				role: "custom",
				customType: "extension-note",
				content: "nested message",
				display: false,
				timestamp: 0,
			},
		});
		expect(context.foregroundCacheRequest).toMatchObject({ cacheIdentity: "identity-a", generation: 7 });
		await handleEvent.call(context, { type: "message_end", message: makeAssistant(makeUsage(10, 0.01)) });
		context.turnUsage = undefined;
		await handleEvent.call(context, { type: "agent_settled" });

		expect(resumeAfterForegroundRequest).toHaveBeenCalledWith({
			provider: "test",
			model: "test",
			cacheIdentity: "identity-a",
			leafId: "leaf-a",
			generation: 7,
			warmedAt: 1,
		});
	});

	it("renders the warm-cache box while a requested pause drains through tools", () => {
		const context: CacheWarmRenderContext = {
			cacheWarmContainer: new Container(),
			ui: { requestRender: vi.fn() },
		};

		renderCacheWarmState.call(context, {
			enabled: true,
			eligible: true,
			idle: true,
			warming: false,
			active: true,
			cold: false,
			cacheUnavailable: false,
			retrying: false,
			warmSince: Date.now() - 60_000,
			expiresAt: Date.now() + 60_000,
			refreshCount: 2,
			totalCost: 0.021,
		});

		const rendered = stripAnsi(context.cacheWarmContainer.render(120).join("\n"));
		expect(rendered).toContain("Claude cache warming");
		expect(rendered).toContain("held warm for");
		expect(rendered).toContain("2 refreshes");
	});

	it("shows a terminal cache miss without claiming that a retry is scheduled", () => {
		const context: CacheWarmRenderContext = {
			cacheWarmContainer: new Container(),
			ui: { requestRender: vi.fn() },
		};

		renderCacheWarmState.call(context, {
			enabled: true,
			eligible: true,
			idle: true,
			warming: false,
			active: false,
			cold: false,
			cacheUnavailable: true,
			retrying: false,
			refreshCount: 2,
			totalCost: 0.021,
			error: "Cache warming reported no cache read or cache write",
		});

		const rendered = stripAnsi(context.cacheWarmContainer.render(120).join("\n"));
		expect(rendered).toContain("cache unavailable");
		expect(rendered).toContain("2 refreshes");
		expect(rendered).toContain("maintenance cost $0.021");
		expect(rendered).not.toContain("retrying");
	});

	it("shows when the cache lease has gone cold", () => {
		const context: CacheWarmRenderContext = {
			cacheWarmContainer: new Container(),
			ui: { requestRender: vi.fn() },
		};

		renderCacheWarmState.call(context, {
			enabled: true,
			eligible: true,
			idle: true,
			warming: false,
			active: false,
			cold: true,
			cacheUnavailable: false,
			retrying: false,
			refreshCount: 2,
			totalCost: 0.021,
		});

		const rendered = stripAnsi(context.cacheWarmContainer.render(120).join("\n"));
		expect(rendered).toContain("cache is cold");
		expect(rendered).toContain("2 refreshes");
		expect(rendered).toContain("maintenance cost $0.021");
		expect(rendered).not.toContain("waiting for first request");
	});

	it("reports terminal cache-unavailable accounting from the warm command", async () => {
		const state: CacheWarmState = {
			enabled: true,
			eligible: true,
			idle: true,
			warming: false,
			active: false,
			cold: false,
			cacheUnavailable: true,
			retrying: false,
			refreshCount: 2,
			totalCost: 0.021,
			error: "Cache warming reported no cache read or cache write",
		};
		const showStatus = vi.fn();
		const context = {
			cacheWarmController: { getState: () => state, setEnabled: vi.fn() },
			showStatus,
			showWarning: vi.fn(),
		};

		await handleWarmCommand.call(context, "/warm");

		expect(showStatus).toHaveBeenCalledWith("Claude cache warming: on, cache unavailable, maintenance cost $0.021");
		expect(context.cacheWarmController.setEnabled).not.toHaveBeenCalled();
	});

	it("reports a cold lease from the warm command", async () => {
		const state: CacheWarmState = {
			enabled: true,
			eligible: true,
			idle: true,
			warming: false,
			active: false,
			cold: true,
			cacheUnavailable: false,
			retrying: false,
			refreshCount: 2,
			totalCost: 0.021,
		};
		const showStatus = vi.fn();
		const context = {
			cacheWarmController: { getState: () => state, setEnabled: vi.fn() },
			showStatus,
			showWarning: vi.fn(),
		};

		await handleWarmCommand.call(context, "/warm");

		expect(showStatus).toHaveBeenCalledWith("Claude cache warming: on, cache is cold, maintenance cost $0.021");
		expect(context.cacheWarmController.setEnabled).not.toHaveBeenCalled();
	});
});

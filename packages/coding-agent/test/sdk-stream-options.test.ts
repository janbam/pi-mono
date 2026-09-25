import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describe("createAgentSession stream options", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-stream-options-"));
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function createModel(api: Api): Model<Api> {
		return {
			id: "capture-model",
			name: "Capture Model",
			api,
			provider: "capture-provider",
			baseUrl: "https://capture.invalid/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
			headers: { "x-model": "model" },
		};
	}

	function createDoneMessage(api: Api, promptTokens = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api,
			provider: "capture-provider",
			model: "capture-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: promptTokens,
				cacheWrite: 0,
				totalTokens: promptTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function createDoneStream(api: Api, promptTokens = 0) {
		const stream = createAssistantMessageEventStream();
		stream.end(createDoneMessage(api, promptTokens));
		return stream;
	}

	async function captureStreamOptions(
		api: Api,
		settings: Partial<Settings>,
		requestOptions: SimpleStreamOptions = {},
		extensionSource?: string,
	): Promise<SimpleStreamOptions | undefined> {
		const model = createModel(api);
		const settingsManager = SettingsManager.inMemory(settings);
		if (extensionSource) {
			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "headers.ts"), extensionSource);
		}

		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let capturedOptions: SimpleStreamOptions | undefined;

		modelRegistry.registerProvider(model.provider, {
			api,
			headers: { "x-provider": "provider" },
			streamSimple: (_model, _context, providerOptions) => {
				capturedOptions = providerOptions;
				return createDoneStream(api);
			},
		});

		const modelRuntime = getModelRuntime(modelRegistry);
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime,
			settingsManager,
			sessionManager,
		});

		try {
			const stream = await session.agent.streamFunction(model, normalizeContext({ messages: [] }), requestOptions);
			await stream.result();
			return capturedOptions;
		} finally {
			session.dispose();
			modelRegistry.unregisterProvider(model.provider);
		}
	}

	async function createCacheWarmingSession(
		sessionManager = SessionManager.inMemory(cwd),
		settings: Partial<Settings> = { cacheWarming: "idle" },
		onProviderCall?: () => void,
	) {
		const model: Model<Api> = {
			...createModel("anthropic-messages"),
			cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			promptCache: { short: 300 },
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
		const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
		let providerCalls = 0;
		modelRegistry.registerProvider(model.provider, {
			api: model.api,
			streamSimple: () => {
				providerCalls++;
				onProviderCall?.();
				return createDoneStream(model.api, 100_000);
			},
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			modelRuntime: getModelRuntime(modelRegistry),
			settingsManager: SettingsManager.inMemory(settings),
			sessionManager,
		});
		return {
			session,
			sessionManager,
			providerCalls: () => providerCalls,
			dispose: () => {
				session.dispose();
				modelRegistry.unregisterProvider(model.provider);
			},
		};
	}

	it("schedules cache warming after a completed session request", async () => {
		const fixture = await createCacheWarmingSession();
		try {
			await fixture.session.prompt("test");
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());

			// Equivalent shallow copies remain current, but removing the request prefix does not.
			fixture.session.agent.state.messages = [...fixture.session.agent.state.messages];
			fixture.session.agent.state.model = { ...fixture.session.agent.state.model };
			expect(fixture.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());
			fixture.session.agent.state.messages = fixture.session.agent.state.messages.slice(1);
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("conversation context changed");
		} finally {
			fixture.dispose();
		}
	});

	// JBMOD regression: extension boundaries (e.g. any turn_end handler) refresh the context after the
	// request. The refresh rebuilds the branch summary as a new object and re-projected the triggered
	// custom message with its persistence time; both stopped warming after every pi-context compaction.
	it("keeps warming across context refreshes that rebuild equal messages", async () => {
		const fixture = await createCacheWarmingSession();
		try {
			await fixture.session.prompt("one");
			const checkpoint = fixture.sessionManager.getLeafId() as string;
			await fixture.session.prompt("two");
			const summaryId = fixture.sessionManager.branchWithSummary(checkpoint, "summary of two");
			fixture.sessionManager.branch(checkpoint);
			await fixture.session.navigateTree(summaryId, { summarize: false });

			// Advance the clock on every read, so a persistence stamp taken separately from the sent
			// message's time always differs, not only when the two land in different milliseconds.
			let clock = Date.now();
			const tickingNow = vi.spyOn(Date, "now").mockImplementation(() => {
				clock += 1_000;
				return clock;
			});
			try {
				await fixture.session.sendCustomMessage(
					{ customType: "continuation", content: "continue", display: false },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} finally {
				tickingNow.mockRestore();
			}

			const sent = fixture.session.agent.state.messages.find((message) => message.role === "custom");
			const persisted = fixture.sessionManager.getBranch().find((entry) => entry.type === "custom_message");
			expect(persisted?.timestamp).toBe(new Date(sent?.timestamp ?? 0).toISOString());

			const summaryIndex = fixture.session.agent.state.messages.findIndex(
				(message) => message.role === "branchSummary",
			);
			const requestSummary = fixture.session.agent.state.messages[summaryIndex];
			fixture.session.refreshContext();
			expect(fixture.session.agent.state.messages[summaryIndex]).not.toBe(requestSummary);
			expect(fixture.session.cacheWarmingStatus?.state).toBe("scheduled");

			// Value comparison must still catch a real change to a message the request sent.
			const messages = [...fixture.session.agent.state.messages];
			messages[summaryIndex] = { ...requestSummary, summary: "changed summary" } as typeof requestSummary;
			fixture.session.agent.state.messages = messages;
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("conversation context changed");
		} finally {
			fixture.dispose();
		}
	});

	// JBMOD: upstream only warms requests captured in-process; the fork resumes the transcript's
	// last request. The rebuild must reproduce the sent request, or its first refresh misses the cache.
	it("resumes warming a resumed transcript with the request it last sent", async () => {
		type RunView = { context: unknown; options: SimpleStreamOptions };
		const activeRun = (session: object) => (session as { _cacheWarmer: { run?: RunView } })._cacheWarmer.run;

		const first = await createCacheWarmingSession();
		let sent: RunView | undefined;
		try {
			await first.session.prompt("test");
			sent = activeRun(first.session);
		} finally {
			first.dispose();
		}

		const resumed = await createCacheWarmingSession(first.sessionManager);
		try {
			// The rebuild runs the context hooks, so it waits until extensions are bound.
			expect(resumed.session.cacheWarmingStatus?.state).toBe("inactive");
			await resumed.session.bindExtensions({});
			await vi.waitFor(() => expect(resumed.session.cacheWarmingStatus?.state).toBe("scheduled"));

			const rebuilt = activeRun(resumed.session);
			expect(sent).toBeDefined();
			expect(rebuilt?.context).toEqual(sent?.context);
			expect(rebuilt?.options.reasoning).toEqual(sent?.options.reasoning);
			expect(rebuilt?.options.sessionId).toBe(sent?.options.sessionId);
			expect(resumed.providerCalls()).toBe(0);
		} finally {
			resumed.dispose();
		}
	});

	// JBMOD: /warm on while idle picks up the entry the last request left, without persisting.
	it("starts warming the last request when warming is enabled explicitly while idle", async () => {
		const fixture = await createCacheWarmingSession(undefined, {});
		try {
			await fixture.session.prompt("test");
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("cache warming disabled");

			await fixture.session.setCacheWarmingOverride("on");
			expect(fixture.session.cacheWarmingStatus?.state).toBe("scheduled");
			expect(fixture.session.cacheWarmingMode).toBe("on");
			expect(fixture.session.settingsManager.getCacheWarmingMode()).toBe("off");

			await fixture.session.setCacheWarmingOverride("off");
			expect(fixture.session.cacheWarmingStatus?.reason).toBe("cache warming disabled");
			expect(fixture.providerCalls()).toBe(1);
		} finally {
			fixture.dispose();
		}
	});

	// Regression (review of PR #42): enabling during the final text turn has no later request to start warming.
	it("starts warming at settlement when enabled during the run's last request", async () => {
		let enableDuringRequest: (() => void) | undefined;
		const fixture = await createCacheWarmingSession(undefined, {}, () => enableDuringRequest?.());
		enableDuringRequest = () => void fixture.session.setCacheWarmingOverride("on");
		try {
			await fixture.session.prompt("test");
			await vi.waitFor(() => expect(fixture.session.cacheWarmingStatus?.state).toBe("scheduled"));
			expect(fixture.providerCalls()).toBe(1);
		} finally {
			fixture.dispose();
		}
	});

	it("forwards httpIdleTimeoutMs as timeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("defaults timeoutMs from httpIdleTimeoutMs for all providers", async () => {
		const options = await captureStreamOptions("openai-completions", { httpIdleTimeoutMs: 1234 });

		expect(options?.timeoutMs).toBe(1234);
	});

	it("lets request timeoutMs override httpIdleTimeoutMs for OpenAI Codex", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ httpIdleTimeoutMs: 1234 },
			{ timeoutMs: 0 },
		);

		expect(options?.timeoutMs).toBe(0);
	});

	it("forwards websocketConnectTimeoutMs from settings", async () => {
		const options = await captureStreamOptions("openai-codex-responses", { websocketConnectTimeoutMs: 1234 });

		expect(options?.websocketConnectTimeoutMs).toBe(1234);
	});

	it("lets request websocketConnectTimeoutMs override settings", async () => {
		const options = await captureStreamOptions(
			"openai-codex-responses",
			{ websocketConnectTimeoutMs: 1234 },
			{ websocketConnectTimeoutMs: 0 },
		);

		expect(options?.websocketConnectTimeoutMs).toBe(0);
	});

	it("forwards provider retry settings", async () => {
		const options = await captureStreamOptions("openai-completions", {
			retry: { provider: { maxRetries: 2, maxRetryDelayMs: 3000 } },
		});

		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(3000);
	});

	it("runs before_provider_headers on assembled headers without forwarding the transform", async () => {
		const options = await captureStreamOptions(
			"openai-completions",
			{},
			{ headers: { "x-explicit": "explicit" } },
			`export default function (pi) {
				pi.on("before_provider_headers", (event) => {
					event.headers["x-hook"] = [
						event.headers["x-provider"],
						event.headers["x-model"],
						event.headers["x-explicit"],
					].join(":");
				});
			}`,
		);

		expect(options?.headers).toMatchObject({
			"x-provider": "provider",
			"x-model": "model",
			"x-explicit": "explicit",
			"x-hook": "provider:model:explicit",
		});
		expect(options).not.toHaveProperty("transformHeaders");
	});
});

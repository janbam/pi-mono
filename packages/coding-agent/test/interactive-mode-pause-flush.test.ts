import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface FakeSession {
	isIdle: boolean;
	isPaused: boolean;
	prompt: (text: string) => Promise<void>;
}

interface PauseFlushContext {
	pausePendingMessages: string[];
	session: FakeSession;
	updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	getAppKeyDisplay: () => string;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

const handlePauseSettled = Reflect.get(InteractiveMode.prototype, "handlePauseSettled") as (
	this: PauseFlushContext,
) => Promise<void>;
const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: object,
	event: AgentSessionEvent,
) => Promise<void>;

function createContext(parked: string[], session: FakeSession): PauseFlushContext {
	return {
		pausePendingMessages: [...parked],
		session,
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		getAppKeyDisplay: () => "escape",
		ui: { requestRender: vi.fn() },
	};
}

describe("InteractiveMode pause-parked message flush", () => {
	it("sends parked messages serially, each after the previous run finished", async () => {
		const sent: string[] = [];
		const session: FakeSession = {
			isIdle: true,
			isPaused: false,
			// A real prompt outside the settle window occupies the session until its run ends.
			prompt: async (text) => {
				expect(session.isIdle).toBe(true);
				session.isIdle = false;
				sent.push(text);
				await Promise.resolve();
				session.isIdle = true;
			},
		};
		const context = createContext(["first", "second"], session);

		await handlePauseSettled.call(context);

		expect(sent).toEqual(["first", "second"]);
		expect(context.pausePendingMessages).toEqual([]);
	});

	it("keeps messages parked while another run owns the session", async () => {
		const prompt = vi.fn(async () => {});
		const context = createContext(["first", "second"], { isIdle: false, isPaused: false, prompt });

		await handlePauseSettled.call(context);

		// That run's own settle flushes them later.
		expect(prompt).not.toHaveBeenCalled();
		expect(context.pausePendingMessages).toEqual(["first", "second"]);
	});

	it("re-parks the failed message and everything after it instead of dropping them", async () => {
		const prompt = vi.fn(async (text: string) => {
			if (text === "second") throw new Error("No API key found");
		});
		const context = createContext(["first", "second", "third"], { isIdle: true, isPaused: false, prompt });

		await handlePauseSettled.call(context);

		// The editor was cleared when the messages were parked, so the queue is their only copy.
		expect(prompt.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
		expect(context.pausePendingMessages).toEqual(["second", "third"]);
		expect(context.showError).toHaveBeenCalledOnce();
	});

	it("flushes after the agent_settled dispatch instead of inside it", async () => {
		const handlePauseSettledSpy = vi.fn(async () => {});
		const context = {
			isInitialized: true,
			isShuttingDown: false,
			shutdownRequested: false,
			footer: { invalidate: vi.fn() },
			showTurnUsage: vi.fn(),
			handlePauseSettled: handlePauseSettledSpy,
			checkShutdownRequested: Reflect.get(InteractiveMode.prototype, "checkShutdownRequested"),
		};

		// prompt() issued during the dispatch would be deferred and could not be awaited or caught.
		await handleEvent.call(context, { type: "agent_settled" });
		expect(handlePauseSettledSpy).not.toHaveBeenCalled();

		await new Promise((resolve) => setImmediate(resolve));
		expect(handlePauseSettledSpy).toHaveBeenCalledOnce();
	});
});

import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface PauseFlushContext {
	pausePendingMessages: string[];
	session: { prompt: ReturnType<typeof vi.fn>; isPaused: boolean };
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

function createContext(parked: string[], prompt: ReturnType<typeof vi.fn>): PauseFlushContext {
	return {
		pausePendingMessages: [...parked],
		session: { prompt, isPaused: false },
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		getAppKeyDisplay: () => "escape",
		ui: { requestRender: vi.fn() },
	};
}

describe("InteractiveMode pause-parked message flush", () => {
	it("sends one parked message per settle so flushed runs never race each other", async () => {
		// prompt() issued from agent_settled is deferred and resolves before its run starts.
		const prompt = vi.fn(async () => {});
		const context = createContext(["first", "second"], prompt);

		await handlePauseSettled.call(context);
		expect(prompt.mock.calls).toEqual([["first"]]);
		expect(context.pausePendingMessages).toEqual(["second"]);

		// The flushed run's own settle delivers the next parked message.
		await handlePauseSettled.call(context);
		expect(prompt.mock.calls).toEqual([["first"], ["second"]]);
		expect(context.pausePendingMessages).toEqual([]);
	});

	it("re-parks a message whose send fails instead of dropping it", async () => {
		const prompt = vi.fn(async () => {
			throw new Error("Agent is already processing a prompt");
		});
		const context = createContext(["first", "second"], prompt);

		await handlePauseSettled.call(context);

		// The editor was cleared when the message was parked, so the queue is its only copy.
		expect(context.pausePendingMessages).toEqual(["first", "second"]);
		expect(context.showError).toHaveBeenCalledOnce();
	});
});

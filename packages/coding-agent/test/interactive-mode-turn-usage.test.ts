import type { AssistantMessage, Usage } from "@earendil-works/pi-ai/compat";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { UsageTotals } from "../src/core/usage-totals.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

interface TurnUsageContext {
	turnUsage: UsageTotals | undefined;
	chatContainer: Container;
	ui: { requestRender: ReturnType<typeof vi.fn> };
}

const showTurnUsage = Reflect.get(InteractiveMode.prototype, "showTurnUsage") as (this: TurnUsageContext) => void;
const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: object,
	event: AgentSessionEvent,
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
			footer: { invalidate: vi.fn() },
			pendingTools: new Map(),
			runtimeHost: {
				session: {
					settingsManager: { getShowTerminalProgress: () => false },
				},
			},
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
	});
});

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

const echoTool: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Echo text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_toolCallId, params) => {
		const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
		return {
			content: [{ type: "text", text: `echo:${text}` }],
			details: { text },
		};
	},
};

function scriptToolTurnThenDone(harness: Harness): void {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
}

/** Arm the pause request as soon as tool execution starts, mirroring an escape press mid-run. */
function armPauseOnToolStart(harness: Harness): () => void {
	const unsubscribe = harness.session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "tool_execution_start") {
			harness.session.requestPause();
		}
	});
	return unsubscribe;
}

describe("AgentSession pause at turn boundary", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("executes every parallel tool call of a batch before the pause lands", async () => {
		const executed: string[] = [];
		const markTool: AgentTool = {
			name: "mark",
			label: "Mark",
			description: "Record an execution marker",
			parameters: Type.Object({ n: Type.String() }),
			execute: async (_toolCallId, params) => {
				executed.push(typeof params === "object" && params !== null && "n" in params ? String(params.n) : "?");
				return { content: [{ type: "text", text: "ok" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [markTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("mark", { n: "1" }), fauxToolCall("mark", { n: "2" }), fauxToolCall("mark", { n: "3" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		let armed = false;
		const disarm = harness.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "tool_execution_start" && !armed) {
				armed = true;
				harness.session.requestPause();
			}
		});
		await harness.session.prompt("start");
		disarm();

		expect(executed.sort()).toEqual(["1", "2", "3"]);
		expect(harness.session.isPaused).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("holds the run after tool results and before the next LLM request", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		scriptToolTurnThenDone(harness);

		const disarm = armPauseOnToolStart(harness);
		await harness.session.prompt("start");
		disarm();

		expect(harness.session.isPaused).toBe(true);
		expect(harness.session.isPauseRequested).toBe(false);
		// The second scripted response was never requested.
		expect(harness.getPendingResponseCount()).toBe(1);
		// The transcript ends with the persisted tool result, a valid continuation point.
		expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
	});

	it("resumes without injecting a user message", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		scriptToolTurnThenDone(harness);

		const disarm = armPauseOnToolStart(harness);
		await harness.session.prompt("start");
		disarm();

		await harness.session.resumePaused();

		expect(harness.session.isPaused).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getAssistantTexts(harness)).toContain("done");
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("delivers a prompt submitted while paused before the next LLM request", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		scriptToolTurnThenDone(harness);

		const disarm = armPauseOnToolStart(harness);
		await harness.session.prompt("start");
		disarm();
		expect(harness.session.isPaused).toBe(true);

		await harness.session.prompt("go left");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getUserTexts(harness)).toEqual(["start", "go left"]);
		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("delivers queued steering messages on resume instead of auto-continuing", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		scriptToolTurnThenDone(harness);

		let steered = false;
		const disarm = harness.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "tool_execution_start" && !steered) {
				steered = true;
				void harness.session.steer("steer msg");
				harness.session.requestPause();
			}
		});
		await harness.session.prompt("start");

		// Without the paused guard in post-run handling, the queued steering message
		// would trigger an automatic continuation and dissolve the pause here.
		expect(harness.session.isPaused).toBe(true);
		expect(harness.session.getSteeringMessages()).toEqual(["steer msg"]);
		expect(harness.getPendingResponseCount()).toBe(1);
		disarm();

		await harness.session.resumePaused();

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getUserTexts(harness)).toEqual(["start", "steer msg"]);
		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("lets a naturally finishing text-only turn ignore the pause request", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("all done")]);

		const disarm = harness.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				harness.session.requestPause();
			}
		});
		await harness.session.prompt("start");
		disarm();

		expect(harness.session.isPaused).toBe(false);
		expect(harness.session.isPauseRequested).toBe(false);
		expect(getAssistantTexts(harness)).toEqual(["all done"]);
	});

	it("cancels a pending pause when the pause is requested twice", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		scriptToolTurnThenDone(harness);

		let armed = false;
		const disarm = harness.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "tool_execution_start" && !armed) {
				armed = true;
				// Simulate a double escape press: arm the pause, then cancel it again.
				harness.session.requestPause();
				harness.session.requestPause();
			}
		});
		await harness.session.prompt("start");
		disarm();

		expect(harness.session.isPaused).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getAssistantTexts(harness)).toContain("done");
	});

	it("clears a held pause on hard abort so resume becomes a no-op", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		scriptToolTurnThenDone(harness);

		const disarm = armPauseOnToolStart(harness);
		await harness.session.prompt("start");
		disarm();
		expect(harness.session.isPaused).toBe(true);

		await harness.session.abort();
		await harness.session.resumePaused();

		expect(harness.session.isPaused).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("freezes a retryable error at a landed pause until resumed", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("transient failure", { stopReason: "error", errorMessage: "provider overloaded" }),
			fauxAssistantMessage("recovered"),
		]);

		const disarm = armPauseOnToolStart(harness);
		await harness.session.prompt("start");
		disarm();

		// The pause armed during the batch, so the errored round itself still ran;
		// the hold lands after it and freezes the retry (third request) instead.
		expect(harness.session.isPaused).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);

		// Resume settles the frozen retry through the normal post-run pipeline.
		await harness.session.resumePaused();

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getAssistantTexts(harness)).toContain("recovered");
		expect(harness.eventsOfType("auto_retry_start").length).toBeGreaterThan(0);
	});

	it("marks the transcript aborted when a held pause is discarded", async () => {
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);
		scriptToolTurnThenDone(harness);

		const disarm = armPauseOnToolStart(harness);
		await harness.session.prompt("start");
		disarm();
		expect(harness.session.isPaused).toBe(true);

		harness.session.abortPausedTurn();

		expect(harness.session.isPaused).toBe(false);
		const last = harness.session.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect(last && "stopReason" in last ? last.stopReason : undefined).toBe("aborted");
		// The marker is persisted to the session file.
		const contextEntries = harness.sessionManager.buildContextEntries();
		const lastEntry = contextEntries.at(-1);
		expect(lastEntry?.type).toBe("message");
		expect(
			lastEntry?.type === "message" && lastEntry.message.role === "assistant"
				? lastEntry.message.stopReason
				: undefined,
		).toBe("aborted");
		// The emitted events let the UI render the regular aborted state.
		expect(harness.eventsOfType("message_end").at(-1)?.message.role).toBe("assistant");
	});
});

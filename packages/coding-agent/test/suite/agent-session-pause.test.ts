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
});

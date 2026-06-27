import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function createEchoTool(runs: string[]): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		prepareArguments: (args) => {
			const input = args as { text?: unknown; legacyText?: unknown };
			return { text: String(input.text ?? input.legacyText ?? "") };
		},
		execute: async (_toolCallId, params, _signal, onUpdate) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			runs.push(text);
			onUpdate?.({ content: [{ type: "text", text: `partial:${text}` }], details: { text } });
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
}

function createStrictTool(runs: string[]): AgentTool {
	return {
		name: "strict",
		label: "Strict",
		description: "Accepts only a string",
		parameters: Type.Object({ text: Type.String() }),
		execute: async (_toolCallId, params) => {
			const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
			runs.push(text);
			return { content: [{ type: "text", text }], details: { text } };
		},
	};
}

describe("AgentSession.executeTool", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("executes a registered SDK tool with prepareArguments, updates, lifecycle events, and no messages", async () => {
		const runs: string[] = [];
		const updates: string[] = [];
		const harness = await createHarness({ tools: [createEchoTool(runs)] });
		harnesses.push(harness);

		const result = await harness.session.executeTool(
			"echo",
			{ legacyText: "hello" },
			{
				toolCallId: "direct-1",
				onUpdate: (partial) => {
					updates.push(getMessageText(partial));
				},
			},
		);

		expect(result).toEqual({
			toolName: "echo",
			toolCallId: "direct-1",
			content: [{ type: "text", text: "hello" }],
			details: { text: "hello" },
			isError: false,
			terminate: undefined,
		});
		expect(runs).toEqual(["hello"]);
		expect(updates).toEqual(["partial:hello"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.events.map((event) => event.type)).toEqual([
			"tool_execution_start",
			"tool_execution_update",
			"tool_execution_end",
		]);
	});

	it("executes a built-in registered tool by name", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "note.txt"), "built-in read works\n");

		const result = await harness.session.executeTool("read", { path: "note.txt" });

		expect(getMessageText(result)).toContain("built-in read works");
		expect(harness.session.messages).toEqual([]);
	});

	it("throws for unknown tools and validation failures before execution", async () => {
		const runs: string[] = [];
		const harness = await createHarness({ tools: [createStrictTool(runs)] });
		harnesses.push(harness);

		await expect(harness.session.executeTool("missing", {})).rejects.toThrow('Registered tool "missing" not found');
		await expect(harness.session.executeTool("strict", {})).rejects.toThrow();

		expect(runs).toEqual([]);
		expect(harness.events).toEqual([]);
	});

	it("lets tool_call handlers block direct execution after lifecycle start", async () => {
		const runs: string[] = [];
		const harness = await createHarness({
			tools: [createEchoTool(runs)],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						if (event.toolName === "echo") {
							return { block: true, reason: "blocked by policy" };
						}
					});
				},
			],
		});
		harnesses.push(harness);

		const result = await harness.session.executeTool("echo", { text: "nope" }, { toolCallId: "blocked-1" });

		expect(result).toMatchObject({
			toolName: "echo",
			toolCallId: "blocked-1",
			content: [{ type: "text", text: "blocked by policy" }],
			details: {},
			isError: true,
		});
		expect(runs).toEqual([]);
		expect(harness.events.map((event) => event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
	});

	it("lets tool_result handlers mutate returned content, details, and error state", async () => {
		const runs: string[] = [];
		const harness = await createHarness({
			tools: [createEchoTool(runs)],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", (event) => {
						if (event.toolName === "echo") {
							return {
								content: [{ type: "text", text: `mutated:${getMessageText(event)}` }],
								details: { changed: true, input: event.input },
								isError: true,
							};
						}
					});
				},
			],
		});
		harnesses.push(harness);

		const result = await harness.session.executeTool("echo", { text: "value" });

		expect(result.content).toEqual([{ type: "text", text: "mutated:value" }]);
		expect(result.details).toEqual({ changed: true, input: { text: "value" } });
		expect(result.isError).toBe(true);
	});

	it("executes extension-registered tools with the current extension context", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "extension_echo",
						label: "Extension Echo",
						description: "Echo from an extension",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => ({
							content: [{ type: "text", text: `${params.text}:${ctx.cwd}` }],
							details: { cwd: ctx.cwd },
						}),
					});
				},
			],
		});
		harnesses.push(harness);

		const result = await harness.session.executeTool("extension_echo", { text: "ok" });

		expect(getMessageText(result)).toBe(`ok:${harness.tempDir}`);
		expect(result.details).toEqual({ cwd: harness.tempDir });
	});

	it("lets an agent-invoked extension tool execute another extension tool directly", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "inner_tool",
						label: "Inner Tool",
						description: "Inner direct execution target",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_toolCallId, params) => ({
							content: [{ type: "text", text: `inner:${params.text}` }],
							details: { inner: params.text },
						}),
					});
				},
				(pi) => {
					pi.registerTool({
						name: "outer_tool",
						label: "Outer Tool",
						description: "Calls another registered tool directly",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_toolCallId, params) => {
							const inner = await pi.executeTool("inner_tool", { text: params.text }, { toolCallId: "inner-1" });
							return {
								content: [{ type: "text", text: `outer:${getMessageText(inner)}` }],
								details: { inner },
							};
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("outer_tool", { text: "live" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("use outer");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
		expect(getMessageText(toolResults[0])).toBe("outer:inner:live");
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolName)).toEqual([
			"outer_tool",
			"inner_tool",
		]);
	});
});

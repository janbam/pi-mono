import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

interface ListenerSnapshot {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
}

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC direct tool execution", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("lists and executes registered tools without adding context or forwarding UI requests", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "ui_probe",
						label: "UI Probe",
						description: "Checks direct RPC tool UI behavior",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
							// Prove direct RPC execution sees no interactive UI and dialog calls resolve quietly.
							const selected = await ctx.ui.select("Choose", ["yes", "no"]);
							ctx.ui.notify("ignored");
							return {
								content: [{ type: "text", text: `${ctx.hasUI}:${selected ?? "none"}:${params.text}` }],
								details: { hasUI: ctx.hasUI, selected },
							};
						},
					});
				},
			],
		});

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			// Discover tool metadata through the janbam fork-owned direct tool RPC surface.
			rpcIo.lineHandler?.(JSON.stringify({ id: "tools-1", type: "get_all_tools" }));

			await vi.waitFor(() => {
				const response = parseOutputLines().find((line) => line.id === "tools-1");
				expect(response).toMatchObject({
					id: "tools-1",
					type: "response",
					command: "get_all_tools",
					success: true,
				});
				expect((response?.data as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toContain(
					"ui_probe",
				);
			});

			rpcIo.outputLines = [];

			// Execute the tool directly; this must emit lifecycle events but no UI request or session message.
			rpcIo.lineHandler?.(
				JSON.stringify({
					id: "exec-1",
					type: "execute_tool",
					toolName: "ui_probe",
					input: { text: "ok" },
					toolCallId: "direct-rpc-1",
				}),
			);

			await vi.waitFor(() => {
				const lines = parseOutputLines();
				expect(lines).toContainEqual({
					type: "tool_execution_start",
					toolCallId: "direct-rpc-1",
					toolName: "ui_probe",
					args: { text: "ok" },
				});
				expect(lines).toContainEqual({
					type: "tool_execution_end",
					toolCallId: "direct-rpc-1",
					toolName: "ui_probe",
					result: {
						content: [{ type: "text", text: "false:none:ok" }],
						details: { hasUI: false },
					},
					isError: false,
				});
				expect(lines).toContainEqual({
					id: "exec-1",
					type: "response",
					command: "execute_tool",
					success: true,
					data: {
						toolName: "ui_probe",
						toolCallId: "direct-rpc-1",
						content: [{ type: "text", text: "false:none:ok" }],
						details: { hasUI: false },
						isError: false,
					},
				});
			});

			expect(parseOutputLines().some((line) => line.type === "extension_ui_request")).toBe(false);
			expect(harness.session.messages).toEqual([]);
			expect(getMessageText(harness.eventsOfType("tool_execution_end")[0].result)).toBe("false:none:ok");
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createToolTextRenderer, type ToolTextRenderer } from "../src/core/export-html/tool-renderer.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { exportSessionToMarkdown, formatConversationAsMarkdown } from "../src/core/session-export.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

describe("Markdown conversation export", () => {
	it("labels turns exactly, omits thinking, and keeps settled tools inside the assistant turn", () => {
		const assistantWithTool: AssistantMessage = {
			...assistantMsg(""),
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "I’ll inspect it." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
			stopReason: "toolUse",
		};
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "complete file contents" }],
			isError: false,
			timestamp: Date.now(),
		};
		const toolRenderer: ToolTextRenderer = {
			renderCall: () => "read README.md",
			renderResult: () => "Read 12 lines",
		};

		const markdown = formatConversationAsMarkdown(
			[
				userMsg("Inspect the file."),
				assistantWithTool,
				toolResult,
				assistantMsg("The file is sound."),
				userMsg("Good."),
			],
			toolRenderer,
		);

		expect(markdown).toBe(
			[
				"A:\n\nInspect the file.",
				"B:\n\nI’ll inspect it.\n\n    <|TOOL_CALL|> read README.md\n    \n    <|TOOL_RESULT|> Read 12 lines\n\nThe file is sound.",
				"A:\n\nGood.",
			].join("\n\n---\n"),
		);
		expect(markdown).not.toContain("private reasoning");
		expect(markdown).not.toContain("complete file contents");
	});

	it("collapses embedded skill instructions and preserves Markdown-significant message whitespace", () => {
		const userPrompt = "    const userCode = true;  \nnext user line";
		const assistantText = "    const assistantCode = true;  \nnext assistant line";
		const skillMessage = userMsg(
			`<skill name="private-skill" location="/private/SKILL.md">\nsecret embedded instructions\n</skill>\n\n${userPrompt}`,
		);

		const markdown = formatConversationAsMarkdown([skillMessage, assistantMsg(`\n${assistantText}\n`)]);

		expect(markdown).toBe(
			[`A:\n\n[skill] private-skill\n\n${userPrompt}`, `B:\n\n${assistantText}`].join("\n\n---\n"),
		);
		expect(markdown).not.toContain("secret embedded instructions");
		expect(markdown).not.toContain("/private/SKILL.md");
	});

	it("settles aborted tool calls with the collapsed error rendering", () => {
		const aborted: AssistantMessage = {
			...assistantMsg(""),
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		};
		const toolRenderer: ToolTextRenderer = {
			renderCall: (_id, _name, _args, isPartial) => (isPartial === false ? "settled read" : "pending read"),
			renderResult: (_id, _name, result, _details, isError) =>
				`${isError ? "error" : "ok"}: ${result[0]?.text ?? ""}`,
		};

		const markdown = formatConversationAsMarkdown([aborted], toolRenderer);

		expect(markdown).toBe("B:\n\n    <|TOOL_CALL|> settled read\n    \n    <|TOOL_RESULT|> error: Operation aborted");
		expect(markdown).not.toContain("pending read");
	});

	it.each([
		["aborted", "Request was aborted", "Operation aborted"],
		["error", "provider unavailable", "Error: provider unavailable"],
		["length", undefined, "Response was truncated before completion."],
	] as const)("preserves a standalone %s assistant failure", (stopReason, errorMessage, expected) => {
		const failure: AssistantMessage = {
			...assistantMsg(""),
			stopReason,
			errorMessage,
		};

		expect(formatConversationAsMarkdown([failure])).toBe(`B:\n\n${expected}`);
	});

	it("falls back to a tool name and bounded result preview without leaking arguments", () => {
		const assistant: AssistantMessage = {
			...assistantMsg(""),
			content: [
				{
					type: "toolCall",
					id: "call-1",
					name: "custom",
					arguments: { secret: "must-not-appear" },
				},
			],
			stopReason: "toolUse",
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "custom",
			content: [{ type: "text", text: Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n") }],
			isError: false,
			timestamp: Date.now(),
		};

		const markdown = formatConversationAsMarkdown([assistant, result]);

		expect(markdown).toContain("    <|TOOL_CALL|> custom");
		expect(markdown).toContain("    <|TOOL_RESULT|> line-1");
		expect(markdown).toContain("    line-10");
		expect(markdown).toContain("    ... (2 more lines)");
		expect(markdown).not.toContain("must-not-appear");
		expect(markdown).not.toContain("line-11");
		expect(markdown).not.toContain("line-12");
	});

	it("writes the formatted conversation and creates the output directory", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-markdown-export-"));
		const outputPath = join(tempDir, "nested", "conversation.md");
		try {
			expect(exportSessionToMarkdown([userMsg("Hello"), assistantMsg("Hi")], outputPath)).toBe(outputPath);
			expect(readFileSync(outputPath, "utf8")).toBe("A:\n\nHello\n\n---\nB:\n\nHi\n");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses only the collapsed registered-tool result renderer", () => {
		initTheme("dark");
		const tool: ToolDefinition = {
			name: "custom",
			label: "custom",
			description: "custom",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			renderCall: () => new Text("custom concise-call", 0, 0),
			renderResult: (_result, options) => new Text(options.expanded ? "verbose result" : "concise result", 0, 0),
		};
		const renderer = createToolTextRenderer({
			getToolDefinition: () => tool,
			theme,
			cwd: process.cwd(),
		});

		expect(renderer.renderCall("call-1", "custom", { value: "hidden" })).toBe("custom concise-call");
		expect(renderer.renderResult("call-1", "custom", [], {}, false)).toBe("concise result");
	});

	it("does not fall back to raw output when a collapsed result intentionally renders blank", () => {
		initTheme("dark");
		const tool: ToolDefinition = {
			name: "quiet",
			label: "quiet",
			description: "quiet",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			renderCall: () => new Text("quiet concise-call", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};
		const renderer = createToolTextRenderer({
			getToolDefinition: () => tool,
			theme,
			cwd: process.cwd(),
		});
		const assistant: AssistantMessage = {
			...assistantMsg(""),
			content: [{ type: "toolCall", id: "call-1", name: "quiet", arguments: { value: "hidden" } }],
			stopReason: "toolUse",
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "quiet",
			content: [{ type: "text", text: "raw result must stay hidden" }],
			isError: false,
			timestamp: Date.now(),
		};

		const markdown = formatConversationAsMarkdown([assistant, result], renderer);

		expect(markdown).toContain("<|TOOL_CALL|> quiet concise-call");
		expect(markdown).not.toContain("<|TOOL_RESULT|>");
		expect(markdown).not.toContain("raw result must stay hidden");
	});

	it("preserves the built-in bash tool's collapsed output preview", () => {
		initTheme("dark");
		const bash = createBashToolDefinition(process.cwd());
		const renderer = createToolTextRenderer({
			getToolDefinition: () => bash as unknown as ToolDefinition,
			theme,
			cwd: process.cwd(),
		});
		const output = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");

		expect(renderer.renderCall("call-1", "bash", { command: "example" })).toContain("$ example");
		const result = renderer.renderResult("call-1", "bash", [{ type: "text", text: output }], undefined, false);

		expect(result).toContain("7 earlier lines");
		expect(result).toContain("line-8");
		expect(result).toContain("line-12");
		expect(result).not.toContain("line-7\n");
	});

	it("routes .md export paths to the Markdown session exporter", async () => {
		const exportToMarkdown = vi.fn(() => "/tmp/conversation.md");
		const exportToJsonl = vi.fn(() => "/tmp/conversation.jsonl");
		const exportToHtml = vi.fn(async () => "/tmp/conversation.html");
		const showStatus = vi.fn();
		const showError = vi.fn();
		const prototype = InteractiveMode.prototype as unknown as {
			handleExportCommand(this: unknown, text: string): Promise<void>;
			getPathCommandArgument(text: string, command: "/export"): string | undefined;
		};
		const context = {
			getPathCommandArgument: prototype.getPathCommandArgument,
			session: { exportToMarkdown, exportToJsonl, exportToHtml },
			showStatus,
			showError,
		};

		await prototype.handleExportCommand.call(context, "/export conversation.md");

		expect(exportToMarkdown).toHaveBeenCalledWith("conversation.md");
		expect(exportToJsonl).not.toHaveBeenCalled();
		expect(exportToHtml).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session exported to: /tmp/conversation.md");
		expect(showError).not.toHaveBeenCalled();
	});
});

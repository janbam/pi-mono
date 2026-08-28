import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage, UserMessage } from "@earendil-works/pi-ai/compat";
import { resolvePath } from "../utils/paths.ts";
import type { ToolTextRenderer } from "./export-html/tool-renderer.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";
import { parseSkillBlock } from "./skill-block.ts";

interface MarkdownTurn {
	speaker: "A" | "B";
	parts: string[];
}

interface MarkdownToolPart {
	turn: MarkdownTurn;
	partIndex: number;
	callText: string;
	toolName: string;
	args: unknown;
}

/** Remove only separator newlines introduced around a message, preserving Markdown-significant spaces. */
function trimStructuralNewlines(text: string): string {
	return text.replace(/^(?:\r?\n)+|(?:\r?\n)+$/g, "");
}

/** Render the user-visible text while collapsing persisted skill wrappers. */
function messageText(message: UserMessage): string {
	const rawText =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");
	const text = trimStructuralNewlines(rawText);
	const skillBlock = parseSkillBlock(text);
	if (!skillBlock) return text;

	// Match the collapsed TUI boundary without exporting Pi's embedded skill instructions.
	return skillBlock.userMessage
		? `[skill] ${skillBlock.name}\n\n${trimStructuralNewlines(skillBlock.userMessage)}`
		: `[skill] ${skillBlock.name}`;
}

/** Bound raw tool output when no registered collapsed renderer exists. */
function fallbackToolResult(content: Array<{ type: string; text?: string }>): string | undefined {
	const output = content
		.filter((block) => block.type === "text" && block.text)
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!output) return undefined;

	const lines = output.split("\n");
	const visibleLines = lines.slice(0, 10);
	if (lines.length > visibleLines.length) {
		visibleLines.push(`... (${lines.length - visibleLines.length} more lines)`);
	}
	return visibleLines.join("\n");
}

/** Indent collapsed tool rendering as a Markdown code block. */
function toolCodeBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

/** Prefix collapsed tool text with its machine-readable conversation role. */
function markedToolText(marker: "TOOL_CALL" | "TOOL_RESULT", text: string): string {
	return `<|${marker}|> ${text}`;
}

/**
 * Format the active conversation as speaker-labeled Markdown.
 *
 * Thinking content and non-conversation custom messages are omitted. Tool calls
 * and results use their collapsed interactive renderers, with a bounded generic
 * fallback when a renderer is unavailable.
 */
export function formatConversationAsMarkdown(
	messages: readonly AgentMessage[],
	toolRenderer?: ToolTextRenderer,
): string {
	const turns: MarkdownTurn[] = [];
	const toolParts = new Map<string, MarkdownToolPart>();

	const appendAssistantPart = (part: string): MarkdownTurn => {
		let turn = turns.at(-1);
		if (!turn || turn.speaker !== "B") {
			turn = { speaker: "B", parts: [] };
			turns.push(turn);
		}
		turn.parts.push(part);
		return turn;
	};

	const renderToolResultText = (
		toolCallId: string,
		toolName: string,
		content: ToolResultMessage["content"],
		details: unknown,
		isError: boolean,
	): string | undefined => {
		const rendered = toolRenderer?.renderResult(toolCallId, toolName, content, details, isError);
		if (rendered === undefined) return fallbackToolResult(content);
		return rendered || undefined;
	};

	const settleToolPart = (
		toolCallId: string,
		toolPart: MarkdownToolPart,
		content: ToolResultMessage["content"],
		details: unknown,
		isError: boolean,
	): void => {
		const settledCallText =
			toolRenderer?.renderCall(toolCallId, toolPart.toolName, toolPart.args, false) ?? toolPart.callText;
		const resultText = renderToolResultText(toolCallId, toolPart.toolName, content, details, isError);
		toolPart.turn.parts[toolPart.partIndex] = toolCodeBlock(
			resultText
				? `${markedToolText("TOOL_CALL", settledCallText)}\n\n${markedToolText("TOOL_RESULT", resultText)}`
				: markedToolText("TOOL_CALL", settledCallText),
		);
	};

	for (const message of messages) {
		if (message.role === "user") {
			const text = messageText(message);
			if (text.trim()) turns.push({ speaker: "A", parts: [text] });
			continue;
		}

		if (message.role === "assistant") {
			// Preserve assistant Markdown and tool order while deliberately skipping thinking blocks.
			for (const block of message.content) {
				if (block.type === "text") {
					const text = trimStructuralNewlines(block.text);
					if (text.trim()) appendAssistantPart(text);
					continue;
				}
				if (block.type !== "toolCall") continue;

				const callText = toolRenderer?.renderCall(block.id, block.name, block.arguments) ?? block.name;
				const turn = appendAssistantPart(toolCodeBlock(markedToolText("TOOL_CALL", callText)));
				toolParts.set(block.id, {
					turn,
					partIndex: turn.parts.length - 1,
					callText,
					toolName: block.name,
					args: block.arguments,
				});
			}

			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			// Settle failed calls through their tool renderer, or preserve the standalone TUI failure state.
			if (toolCalls.length > 0 && (message.stopReason === "aborted" || message.stopReason === "error")) {
				const errorText = message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
				for (const block of toolCalls) {
					const toolPart = toolParts.get(block.id);
					if (toolPart) {
						settleToolPart(block.id, toolPart, [{ type: "text", text: errorText }], undefined, true);
					}
				}
			} else if (message.stopReason === "aborted") {
				appendAssistantPart(
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted",
				);
			} else if (message.stopReason === "error") {
				appendAssistantPart(`Error: ${message.errorMessage || "Unknown error"}`);
			}

			// Length stops remain visible even when partial text or tool calls preceded the warning.
			if (message.stopReason === "length") {
				appendAssistantPart("Response was truncated before completion.");
			}
			continue;
		}

		if (message.role === "toolResult") {
			const toolPart = toolParts.get(message.toolCallId);
			// Keep the settled result in the same collapsed tool block and assistant turn as its call.
			if (toolPart) {
				settleToolPart(message.toolCallId, toolPart, message.content, message.details, message.isError);
				continue;
			}

			const resultText = renderToolResultText(
				message.toolCallId,
				message.toolName,
				message.content,
				message.details,
				message.isError,
			);
			if (resultText) {
				appendAssistantPart(
					toolCodeBlock(
						`${markedToolText("TOOL_CALL", message.toolName)}\n\n${markedToolText("TOOL_RESULT", resultText)}`,
					),
				);
			}
		}
	}

	return turns.map((turn) => `${turn.speaker}:\n\n${turn.parts.join("\n\n")}`).join("\n\n---\n");
}

/** Write the active conversation as a compact, speaker-labeled Markdown document. */
export function exportSessionToMarkdown(
	messages: readonly AgentMessage[],
	outputPath?: string,
	toolRenderer?: ToolTextRenderer,
): string {
	const markdown = formatConversationAsMarkdown(messages, toolRenderer);
	if (!markdown) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	writeFileSync(filePath, `${markdown}\n`);
	return filePath;
}

/** Write the current session branch and optional trailing export-only entries as JSONL. */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: (parentId: string | null, timestamp: string) => readonly object[],
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const lines = [JSON.stringify(header)];

	let parentId: string | null = null;
	for (const entry of sessionManager.getBranch()) {
		lines.push(JSON.stringify({ ...entry, parentId }));
		parentId = entry.id;
	}
	for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
		lines.push(JSON.stringify(entry));
	}

	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}

/** Render registered tools through their TUI definitions for HTML and plain-text exports. */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import type { ToolDefinition, ToolRenderContext } from "../extensions/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Function to look up tool definition by name */
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** Theme for styling */
	theme: Theme;
	/** Working directory for render context */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	width?: number;
}

export interface ToolHtmlRenderer {
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/** Render tool calls and collapsed results as plain text using their TUI renderers. */
export interface ToolTextRenderer {
	/** Render the concise tool call shown in collapsed interactive mode. */
	renderCall(toolCallId: string, toolName: string, args: unknown, isPartial?: boolean): string | undefined;
	/** Render the concise collapsed result; null means the renderer intentionally produced no visible text. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): string | null | undefined;
}

interface ToolComponentRenderer {
	renderCall(toolCallId: string, toolName: string, args: unknown, isPartial: boolean): string[] | undefined;
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
		expanded: boolean,
	): string[] | undefined;
}

/** Return whether a rendered line contains no visible characters. */
function isBlankRenderedLine(line: string): boolean {
	return stripAnsi(line).trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

/** Share stateful TUI component rendering before adapting the output format. */
function createToolComponentRenderer(deps: ToolHtmlRendererDeps): ToolComponentRenderer {
	const { getToolDefinition, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const renderedStates = new Map<string, any>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown, isPartial: boolean): string[] | undefined {
			try {
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}

				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, isPartial, false),
				);
				renderedCallComponents.set(toolCallId, component);
				return component.render(width);
			} catch {
				// Let the export format apply its own safe fallback.
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
			expanded: boolean,
		): string[] | undefined {
			try {
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// Render only the presentation requested by the export adapter.
				const component = toolDef.renderResult(
					agentToolResult,
					{ expanded, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), expanded, false, isError),
				);
				renderedResultComponents.set(toolCallId, component);
				return trimRenderedResultLines(component.render(width));
			} catch {
				// Let the export format apply its own safe fallback.
				return undefined;
			}
		},
	};
}

/** Create the HTML adapter over the shared collapsed/expanded TUI rendering path. */
export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const renderer = createToolComponentRenderer(deps);
	return {
		renderCall(toolCallId, toolName, args) {
			const lines = renderer.renderCall(toolCallId, toolName, args, true);
			return lines ? ansiLinesToHtml(lines) : undefined;
		},
		renderResult(toolCallId, toolName, result, details, isError) {
			const collapsedLines = renderer.renderResult(toolCallId, toolName, result, details, isError, false);
			if (!collapsedLines) return undefined;
			const expandedLines = renderer.renderResult(toolCallId, toolName, result, details, isError, true);
			if (!expandedLines) return undefined;

			const collapsed = ansiLinesToHtml(collapsedLines);
			const expanded = ansiLinesToHtml(expandedLines);
			return {
				...(collapsed && collapsed !== expanded ? { collapsed } : {}),
				expanded,
			};
		},
	};
}

function ansiLinesToText(lines: string[]): string | null {
	const text = trimRenderedResultLines(lines)
		.map((line) => stripAnsi(line).trimEnd())
		.join("\n");
	return text || null;
}

/** Create the plain-text adapter used by Markdown conversation export. */
export function createToolTextRenderer(deps: ToolHtmlRendererDeps): ToolTextRenderer {
	const renderer = createToolComponentRenderer(deps);
	return {
		renderCall(toolCallId, toolName, args, isPartial = true) {
			const lines = renderer.renderCall(toolCallId, toolName, args, isPartial);
			return lines ? (ansiLinesToText(lines) ?? undefined) : undefined;
		},
		renderResult(toolCallId, toolName, result, details, isError) {
			const lines = renderer.renderResult(toolCallId, toolName, result, details, isError, false);
			return lines ? ansiLinesToText(lines) : undefined;
		},
	};
}

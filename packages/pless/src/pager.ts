import * as path from "node:path";
import {
	KeybindingsManager,
	Markdown,
	type MarkdownTheme,
	ProcessTerminal,
	ScrollView,
	setKeybindings,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { StatusBar } from "./status-bar.ts";

export interface PagerDocument {
	/** Absolute path, used for display (basename) and identity. */
	path: string;
	content: string;
}

/** Result of an armed `:` command: which neighbor file to switch to. */
export type ColonCommand = "nextFile" | "previousFile";

/**
 * Resolve the second keypress of a `:` command sequence.
 *
 * Returns undefined for anything that is not `n` or `p`; the caller cancels
 * command mode either way. Pure function so tests can pin the mapping.
 */
export function resolveColonCommand(data: string): ColonCommand | undefined {
	if (data === "n") return "nextFile";
	if (data === "p") return "previousFile";
	return undefined;
}

/**
 * ScrollView that remembers layout metrics so the status bar can show a live
 * scroll percentage. The layout engine calls updateLayout on every frame.
 */
class TrackingScrollView extends ScrollView {
	trackedContentHeight = 0;
	trackedViewportHeight = 0;

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		this.trackedContentHeight = contentHeight;
		this.trackedViewportHeight = viewportHeight;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
	}

	positionLabel(): string {
		const maxScrollTop = Math.max(0, this.trackedContentHeight - this.trackedViewportHeight);
		if (maxScrollTop === 0) return "All";
		return `${Math.min(100, Math.round((this.scrollTop / maxScrollTop) * 100))}%`;
	}
}

const COLON_HINT = ":n next file :p prev :q cancel";

/**
 * Run the interactive pager over the given documents until the user quits.
 *
 * Assumes a TTY stdin (the CLI validates this); blocks until `q`/`ctrl+c`.
 */
export function runPager(documents: readonly PagerDocument[], theme: MarkdownTheme): void {
	if (documents.length === 0) throw new Error("runPager requires at least one document");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });

	// Extend pi-tui's semantic actions with less-style keys. User bindings
	// replace defaults entirely, so every list restates the original keys.
	setKeybindings(
		new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.altScreen.lineUp": ["up", "k"],
			"tui.altScreen.lineDown": ["down", "j"],
			"tui.altScreen.halfPageUp": ["ctrl+u"],
			"tui.altScreen.halfPageDown": ["ctrl+d"],
			"tui.altScreen.pageUp": ["pageUp", "b", "ctrl+b"],
			"tui.altScreen.pageDown": ["pageDown", "space", "f"],
			"tui.altScreen.top": ["home", "g"],
			"tui.altScreen.bottom": ["end", "shift+g"],
			"tui.altScreen.search": ["ctrl+shift+f", "/"],
			"tui.altScreen.searchNext": ["enter", "ctrl+g", "n"],
			"tui.altScreen.searchPrevious": ["shift+enter", "ctrl+shift+g", "shift+n"],
		}),
	);

	let currentIndex = 0;
	let colonPending = false;
	const markdown: Markdown = new Markdown("", 1, 0, theme);
	const scrollView = new TrackingScrollView(markdown, { primary: true, scrollbar: "auto" });
	// Position is read at render time so the bar tracks scrolling without
	// explicit refresh bookkeeping.
	const statusBar = new StatusBar(() => ({
		name: path.basename(documents[currentIndex]!.path),
		index: currentIndex + 1,
		count: documents.length,
		position: scrollView.positionLabel(),
	}));

	tui.setLayoutRoot(
		new VStack([
			{ component: scrollView, grow: 1 },
			{ component: statusBar, basis: 1, grow: 0, shrink: 0 },
		]),
	);

	function showFile(index: number): void {
		currentIndex = index;
		markdown.setText(documents[index]!.content);
		scrollView.scrollToStart();
	}

	function switchFile(delta: -1 | 1): void {
		const nextIndex = currentIndex + delta;
		if (nextIndex < 0 || nextIndex >= documents.length) {
			tui.flash(delta < 0 ? "No previous file" : "No next file");
			return;
		}
		showFile(nextIndex);
		tui.requestRender();
	}

	function quit(): void {
		// Hide the bar first so the stop path's final main-screen paint shows only
		// document content, mirroring how less leaves its last view in scrollback.
		statusBar.setHidden(true);
		tui.stop();
	}

	function disarmColon(): void {
		colonPending = false;
		statusBar.setHint(undefined);
	}

	showFile(0);

	// Registered after construction, so it only sees input the alt-screen's own
	// handler did not consume; overlay text (search queries) must never leak here.
	tui.addInputListener((data) => {
		if (tui.hasOverlay()) return undefined;
		if (data === "q" || data === "\x03") {
			quit();
			return { consume: true };
		}
		if (colonPending) {
			disarmColon();
			const command = resolveColonCommand(data);
			if (command === "nextFile") switchFile(1);
			else if (command === "previousFile") switchFile(-1);
			tui.requestRender();
			return { consume: true };
		}
		if (data === ":") {
			colonPending = true;
			statusBar.setHint(COLON_HINT);
			tui.requestRender();
			return { consume: true };
		}
		return undefined;
	});

	tui.start();
}

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface StatusInfo {
	/** Display name of the current file (basename). */
	name: string;
	/** 1-based index of the current file. */
	index: number;
	/** Total number of open files. */
	count: number;
	/** Scroll position as a percentage string ("42%") or "All" when the file fits. */
	position: string;
}

/**
 * Compose the status line text for the pager's bottom bar.
 *
 * Multi-file sessions show `(i/n)` after the file name; single-file sessions
 * omit it. Pure function so tests can pin the exact wording.
 */
export function formatStatus(info: StatusInfo): string {
	const filePart = info.count > 1 ? `${info.name} (${info.index}/${info.count})` : info.name;
	return `${filePart} ${info.position}`;
}

const REVERSE_VIDEO_ON = "\x1b[7m";
const REVERSE_VIDEO_OFF = "\x1b[27m";

/**
 * One-line bottom bar showing file identity and scroll position.
 *
 * Reads status through a getter on every render so scroll position stays live
 * with the TUI's normal render cycle; no invalidation bookkeeping needed.
 */
export class StatusBar implements Component {
	private readonly getStatus: () => StatusInfo;
	private hint?: string;
	private hidden = false;

	constructor(getStatus: () => StatusInfo) {
		this.getStatus = getStatus;
	}

	/** Show a transient key hint (e.g. armed `:` command mode) in place of the status. */
	setHint(hint: string | undefined): void {
		this.hint = hint;
	}

	/** Suppress rendering entirely; used before quitting so the bar stays out of scrollback. */
	setHidden(hidden: boolean): void {
		this.hidden = hidden;
	}

	render(width: number): string[] {
		if (this.hidden) return [];
		const left = this.hint ?? formatStatus(this.getStatus());
		let line = truncateToWidth(left, Math.max(0, width));
		line += " ".repeat(Math.max(0, width - visibleWidth(line)));
		return [`${REVERSE_VIDEO_ON}${line}${REVERSE_VIDEO_OFF}`];
	}

	invalidate(): void {}
}

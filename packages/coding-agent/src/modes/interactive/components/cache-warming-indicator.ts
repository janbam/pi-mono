import { type Component, Text } from "@earendil-works/pi-tui";
import type { CacheWarmingEffectiveMode, CacheWarmingStatus } from "../../../core/cache-warmer.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/** JBMOD: the warming state the indicator shows, read fresh on every render. */
export interface CacheWarmingIndicatorView {
	mode: CacheWarmingEffectiveMode;
	status: CacheWarmingStatus | undefined;
}

/** `12m 03s`, or `1h 02m 03s` from one hour on. */
function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const paddedSeconds = seconds.toString().padStart(2, "0");
	return hours > 0
		? `${hours}h ${minutes.toString().padStart(2, "0")}m ${paddedSeconds}s`
		: `${minutes}m ${paddedSeconds}s`;
}

/** JBMOD: one-line indicator text, e.g. `Cache warming (on) · held warm for 12m 03s · 3 refreshes · cost $0.123`. */
export function formatCacheWarmingIndicator(view: CacheWarmingIndicatorView, now = Date.now()): string {
	const label = `Cache warming (${view.mode})`;
	const status = view.status;
	if (!status) return `${label} · unavailable`;
	if (status.state === "inactive") {
		return status.reason === "waiting for first request"
			? `${label} · waiting for the next request`
			: `${label} · stopped: ${status.reason ?? "unknown reason"}`;
	}
	const refreshes = status.refreshCount === 1 ? "1 refresh" : `${status.refreshCount ?? 0} refreshes`;
	const parts = [
		label,
		`held warm for ${formatElapsed(now - (status.warmSince ?? now))}`,
		refreshes,
		`maintenance cost $${(status.refreshCost ?? 0).toFixed(3)}`,
	];
	if (status.state === "refreshing") parts.push("refreshing now");
	return parts.join(" · ");
}

/**
 * JBMOD: bordered status line above the editor while cache warming is enabled, as a reminder
 * that warming spends money. Renders nothing when the effective mode is off. Holds no state:
 * the owner re-renders it on a timer so the elapsed time stays live.
 */
export class CacheWarmingIndicator implements Component {
	private readonly getView: () => CacheWarmingIndicatorView;

	constructor(getView: () => CacheWarmingIndicatorView) {
		this.getView = getView;
	}

	/** Whether the indicator currently renders anything; lets the owner skip idle re-renders. */
	isVisible(): boolean {
		return this.getView().mode !== "off";
	}

	invalidate(): void {
		// Stateless: every render reads the live view.
	}

	render(width: number): string[] {
		const view = this.getView();
		if (view.mode === "off") return [];
		// Failures (refresh error, missed cache) switch to the warning color; policy stops do not.
		const border = new DynamicBorder((line) => theme.fg(view.status?.failed ? "warning" : "accent", line));
		const text = new Text(theme.fg("muted", formatCacheWarmingIndicator(view)), 1, 0);
		return [...border.render(width), ...text.render(width), ...border.render(width)];
	}
}

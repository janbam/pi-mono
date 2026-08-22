import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent/theme";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * Initialize the shared pi theme system and return its markdown renderer
 * theme.
 *
 * Deliberately delegates to the coding agent's own machinery instead of
 * duplicating colors: built-in dark/light themes, custom user themes,
 * terminal-background auto-detection, color-mode downgrading, and syntax
 * highlighting all behave exactly as in `pi`.
 */
export function resolveMarkdownTheme(themeName?: string): MarkdownTheme {
	initTheme(themeName);
	return getMarkdownTheme();
}

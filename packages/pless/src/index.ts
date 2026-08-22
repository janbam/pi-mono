// Public contract of the pless package: run the pager, or reuse its
// testable pure pieces (arg parsing, status formatting, key resolution).
export { type CliParseResult, type ParsedCliArgs, parseCliArgs } from "./cli.ts";
export {
	type ColonCommand,
	type PagerDocument,
	resolveColonCommand,
	resolveViewportAction,
	runPager,
	type ViewportAction,
} from "./pager.ts";
export { formatStatus, StatusBar, type StatusInfo } from "./status-bar.ts";
export { resolveMarkdownTheme } from "./theme.ts";

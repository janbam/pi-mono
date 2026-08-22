// Public contract of the pless package: run the pager, or reuse its
// testable pure pieces (arg parsing, status formatting, colon commands).
export { type CliParseResult, type ParsedCliArgs, parseCliArgs } from "./cli.ts";
export { type ColonCommand, type PagerDocument, resolveColonCommand, runPager } from "./pager.ts";
export { formatStatus, StatusBar, type StatusInfo } from "./status-bar.ts";
export { resolveMarkdownTheme } from "./theme.ts";

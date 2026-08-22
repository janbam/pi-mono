#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type PagerDocument, runPager } from "./pager.ts";
import { resolveMarkdownTheme } from "./theme.ts";

export interface ParsedCliArgs {
	files: string[];
	help: boolean;
	version: boolean;
}

export type CliParseResult = { kind: "ok"; args: ParsedCliArgs } | { kind: "error"; message: string };

const USAGE = `Usage: pless [options] <file> [<file> ...]

Page Markdown files in the terminal with pi's markdown renderer.

Options:
  -h, --help     Show this help
  -v, --version  Show version

Keys:
  j/k or arrows            Scroll by line
  space/f/pgdn/ctrl+d      Page forward (ctrl+d: half page)
  b/pgup/ctrl+u            Page back (ctrl+u: half page)
  g/home, G/end            Jump to top / bottom
  /                        Search overlay (enter/n next, shift+enter/N prev)
  : then n / p             Next / previous file
  q, ctrl+c                Quit`;

/**
 * Parse pless command-line arguments.
 *
 * Pure and TTY-free so tests can pin behavior; file existence is validated
 * separately at the process boundary.
 */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
	const files: string[] = [];
	let help = false;
	let version = false;
	for (const arg of argv) {
		if (arg === "-h" || arg === "--help") help = true;
		else if (arg === "-v" || arg === "--version") version = true;
		else if (arg.startsWith("-")) return { kind: "error", message: `pless: unknown option: ${arg}` };
		else files.push(arg);
	}
	return { kind: "ok", args: { files, help, version } };
}

/**
 * Read all given Markdown files up front.
 *
 * Failing fast before any terminal setup means a typo never leaves the user
 * inside a half-initialized alternate screen. Returns the first error.
 */
export function loadDocuments(
	paths: readonly string[],
): { kind: "ok"; documents: PagerDocument[] } | { kind: "error"; message: string } {
	const documents: PagerDocument[] = [];
	for (const filePath of paths) {
		try {
			const stat = fs.statSync(filePath);
			if (stat.isDirectory()) return { kind: "error", message: `pless: ${filePath}: is a directory` };
			documents.push({ path: path.resolve(filePath), content: fs.readFileSync(filePath, "utf8") });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const reason = code === "ENOENT" ? "no such file" : code === "EACCES" ? "permission denied" : String(error);
			return { kind: "error", message: `pless: ${filePath}: ${reason}` };
		}
	}
	return { kind: "ok", documents };
}

function readVersion(): string {
	try {
		const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			version?: string;
		};
		return manifest.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

function main(): void {
	const parseResult = parseCliArgs(process.argv.slice(2));
	if (parseResult.kind === "error") {
		console.error(parseResult.message);
		process.exit(2);
	}
	const { args } = parseResult;
	if (args.help) {
		console.log(USAGE);
		return;
	}
	if (args.version) {
		console.log(`pless ${readVersion()}`);
		return;
	}
	if (!process.stdin.isTTY) {
		console.error("pless: stdin is not a TTY; pless is an interactive pager and does not read piped input");
		process.exit(2);
	}
	if (args.files.length === 0) {
		console.error(USAGE);
		process.exit(2);
	}
	const loaded = loadDocuments(args.files);
	if (loaded.kind === "error") {
		console.error(loaded.message);
		process.exit(1);
	}
	runPager(loaded.documents, resolveMarkdownTheme());
}
// Only run as CLI binary, not when imported as a library via the package index.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}

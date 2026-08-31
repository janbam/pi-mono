import type { ModelCost } from "../src/types.ts";

// JANBAM fork mod: OpenCode Go publishes its subscription economics at
// https://opencode.ai/docs/go/. models.dev carries only the nominal per-1M
// prices, but each Go model burns a different monthly usage allowance ($15,
// $30, or $60) at those nominal prices. To make per-token cost reflect how fast
// a model drains its allowance, every page price is scaled by
// (baseline / usage): $60-usage models keep the nominal price, $30-usage
// models double it, $15-usage models quadruple it. This override applies only
// to the opencode-go provider, never to opencode (Zen).

export const OPENCODE_GO_PRICING_URL = "https://opencode.ai/docs/go/";
const OPENCODE_GO_USAGE_BASELINE = 60;
/** Lowercase header names the pricing table must provide; they also drive per-row column indexing. */
const REQUIRED_PRICING_COLUMNS = ["model", "input", "output", "cached read", "cached write", "usage"] as const;
type PricingColumnName = (typeof REQUIRED_PRICING_COLUMNS)[number];

/** One pricing-table row after normalization: page prices in $/1M tokens, usage allowance in $. */
export interface OpenCodeGoPricingRow {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	usage: number;
}

/** Match page model names to models.dev ids: "Grok 4.6" and "grok-4.6" both become "grok46". */
export function normalizeOpenCodeGoModelKey(name: string): string {
	return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function parsePriceCell(cell: string, label: string): number {
	const value = cell.replace("$", "").replaceAll(",", "").trim();
	if (value === "-" || value === "") return 0;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`OpenCode Go pricing table has an unparseable ${label} cell: ${JSON.stringify(cell)}`);
	}
	return parsed;
}

function decodeTableCell(cell: string): string {
	return cell
		// Decode numeric and named entities before &amp; so encoded markup does
		// not hide tier markers like "&gt; 200K tokens" from the variant check.
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replaceAll("&gt;", ">")
		.replaceAll("&lt;", "<")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function readTableRow(rowHtml: string): string[] {
	return [...rowHtml.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((match) => decodeTableCell(match[1]));
}

/**
 * Parse the Go docs pricing table out of the page HTML, keyed by normalized
 * model name. The table is anchored on its header row (Model / Input / Output /
 * Cached Read / Cached Write / Usage) because it is the only table on the page
 * with those columns, and the header names drive column indexing so a page
 * redesign that renames, removes, or inserts columns fails loudly here
 * instead of silently shifting prices into the wrong fields. Tiered
 * ("> N tokens") and Peak rows are skipped so each model keeps one flat cost
 * from its base row (plain, "≤ N tokens", or Off-Peak), matching the catalog's
 * single-cost schema.
 */
export function parseOpenCodeGoPricingTable(html: string): Map<string, OpenCodeGoPricingRow> {
	const tables = [...html.matchAll(/<table[^>]*>.*?<\/table>/gs)].map((match) => match[0]);
	let columns: Map<string, number> | undefined;
	let pricingTable: string | undefined;
	for (const table of tables) {
		const headerRow = table.match(/<tr[^>]*>.*?<\/tr>/s);
		const headers = headerRow ? readTableRow(headerRow[0]) : [];
		const indices = new Map(headers.map((header, index) => [header.toLowerCase(), index] as const));
		if (REQUIRED_PRICING_COLUMNS.every((name) => indices.has(name))) {
			columns = indices;
			pricingTable = table;
			break;
		}
	}
	if (!pricingTable || !columns) throw new Error("OpenCode Go pricing table not found on the docs page");

	const rows = [...pricingTable.matchAll(/<tr[^>]*>.*?<\/tr>/gs)].map((match) => readTableRow(match[0])).slice(1);
	const pricing = new Map<string, OpenCodeGoPricingRow>();
	for (const cells of rows) {
		// Row and header cell counts must agree, otherwise a shifted row would
		// read prices out of the wrong columns.
		if (cells.length !== columns.size) {
			throw new Error(
				`OpenCode Go pricing row has ${cells.length} cells, expected ${columns.size}: ${JSON.stringify(cells)}`,
			);
		}
		const cell = (name: PricingColumnName) => cells[columns.get(name) as number];
		const variant = cell("model").match(/\(([^)]*)\)\s*$/)?.[1] ?? "";
		if (variant.startsWith(">") || variant.toLowerCase() === "peak") continue;
		const baseName = cell("model").replace(/\s*\([^)]*\)\s*$/, "").trim();
		const usage = parsePriceCell(cell("usage"), "usage");
		if (usage <= 0) {
			throw new Error(`OpenCode Go pricing row ${JSON.stringify(cell("model"))} has invalid usage allowance`);
		}
		const key = normalizeOpenCodeGoModelKey(baseName);
		if (pricing.has(key)) {
			throw new Error(`OpenCode Go pricing table has duplicate rows for ${JSON.stringify(baseName)}`);
		}
		pricing.set(key, {
			input: parsePriceCell(cell("input"), "input"),
			output: parsePriceCell(cell("output"), "output"),
			cacheRead: parsePriceCell(cell("cached read"), "cached read"),
			cacheWrite: parsePriceCell(cell("cached write"), "cached write"),
			usage,
		});
	}
	if (pricing.size === 0) throw new Error("OpenCode Go pricing table parsed to zero model rows");
	return pricing;
}

/**
 * Scale a pricing row's nominal prices by (baseline / usage allowance) and
 * round to the catalog's cost precision. The dash cells were already turned
 * into 0 by the parser, so unsupported cache prices stay free.
 */
export function getOpenCodeGoUsageAdjustedCost(row: OpenCodeGoPricingRow): ModelCost {
	const multiplier = OPENCODE_GO_USAGE_BASELINE / row.usage;
	return {
		input: roundCost(row.input * multiplier),
		output: roundCost(row.output * multiplier),
		cacheRead: roundCost(row.cacheRead * multiplier),
		cacheWrite: roundCost(row.cacheWrite * multiplier),
	};
}

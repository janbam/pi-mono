import type { ModelCost } from "../src/types.ts";

// JANBAM fork mod: OpenCode Go publishes its subscription economics at
// https://opencode.ai/docs/go/. models.dev carries only the nominal per-1M
// prices, but each Go model burns a different monthly usage allowance ($15,
// $30, or $60) at those nominal prices. To make per-token cost reflect how fast
// a model drains its allowance, every page price is scaled by
// (baseline / usage): $60-usage models keep the nominal price, $30-usage
// models double it, $15-usage models quadruple it. Pricing rows are keyed by
// the model ids from the page's endpoints table, so models.dev entries match
// exactly. This override applies only to the opencode-go provider, never to
// opencode (Zen).

export const OPENCODE_GO_PRICING_URL = "https://opencode.ai/docs/go/";
const OPENCODE_GO_USAGE_BASELINE = 60;
/**
 * Canonical pricing column names and the header wordings that map to them.
 * Aliases keep table detection working across header rewordings ("Usage"
 * became "Monthly limit" in Sep 2026) while unknown or missing columns stay
 * unrecognized so the parser fails loudly instead of shifting prices into
 * the wrong fields.
 */
const PRICING_COLUMN_ALIASES = {
	model: ["model"],
	input: ["input"],
	output: ["output"],
	"cached read": ["cached read", "cache read"],
	"cached write": ["cached write", "cache write"],
	usage: ["usage", "monthly limit", "monthly usage"],
} as const satisfies Record<string, readonly string[]>;
type PricingColumnName = keyof typeof PRICING_COLUMN_ALIASES;
const REQUIRED_PRICING_COLUMNS = Object.keys(PRICING_COLUMN_ALIASES) as PricingColumnName[];
const PRICING_HEADER_TO_COLUMN = new Map<string, PricingColumnName>(
	Object.entries(PRICING_COLUMN_ALIASES).flatMap(([column, aliases]) =>
		aliases.map((alias) => [alias, column as PricingColumnName] as const),
	),
);

/** One pricing-table row after normalization: page prices in $/1M tokens, usage allowance in $ (Infinity for unlimited promos). */
export interface OpenCodeGoPricingRow {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	usage: number;
}

/** Join page display names across tables: "Grok 4.6" and "grok-4.6" both become "grok46". */
function normalizeOpenCodeGoModelKey(name: string): string {
	return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function parsePriceCell(cell: string, label: string): number {
	const value = cell.replace("$", "").replaceAll(",", "").trim();
	if (value === "-" || value === "") return 0;
	// Word cells name a price state rather than a number: free and unlimited
	// both mean zero marginal per-token cost.
	const lowered = value.toLowerCase();
	if (lowered === "free" || lowered === "unlimited") return 0;
	// Promo and price-change cells carry the current number first and
	// annotations after it ("$60 4x · Ends Sep 20"). Only a leading number that
	// stands alone counts: anything fused directly onto it ("4x", "4×") is an
	// annotation, not a price, and must keep failing loudly instead of parsing
	// to garbage.
	const leading = value.match(/^(?:\d+(?:\.\d+)?|\.\d+)(?!\S)/);
	if (!leading) {
		throw new Error(`OpenCode Go pricing table has an unparseable ${label} cell: ${JSON.stringify(cell)}`);
	}
	return Number(leading[0]);
}

function decodeTableCell(cell: string): string {
	const decoded = cell
		// Decode numeric and named entities before &amp; so encoded markup does
		// not hide tier markers like "&gt; 200K tokens" from the variant check.
		.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
		.replaceAll("&gt;", ">")
		.replaceAll("&lt;", "<")
		.replaceAll("&nbsp;", " ")
		.replaceAll("&amp;", "&");
	// Struck-through spans are superseded values: promo cells show the old
	// monthly limit as <del>$15</del> next to the current <strong>$60</strong>.
	// Drop them before tag stripping so only the current value survives.
	const unstruck = decoded.replace(/<(del|s)\b[^>]*>[\s\S]*?<\/\1>/g, "");
	// An unpaired struck-through tag was never dropped, so the superseded and
	// current values would both survive and the leading-number rule would
	// silently pick the superseded one — fail loudly instead.
	if (/<\/?(del|s)\b/i.test(unstruck)) {
		throw new Error(`OpenCode Go table cell has an unpaired struck-through tag: ${JSON.stringify(cell)}`);
	}
	return unstruck
		// Tags become spaces, not empty strings: a promo cell like
		// "<strong>$60</strong><br><small>4x …</small>" must decode to "$60 4x …",
		// not fuse into the unparseable "$604x …".
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function readTableRow(rowHtml: string): string[] {
	return [...rowHtml.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((match) => decodeTableCell(match[1]));
}

function extractTables(html: string): string[] {
	return [...html.matchAll(/<table[^>]*>.*?<\/table>/gs)].map((match) => match[0]);
}

/** Lowercase headers the endpoints table must provide to yield the page's authoritative model-id mapping. */
const REQUIRED_ENDPOINT_COLUMNS = ["model", "model id"] as const;

/**
 * Parse the endpoints table (Model / Model ID / Endpoint / AI SDK Package)
 * into normalized display name -> model id. The page's own mapping is
 * authoritative: display names can diverge from models.dev ids (the pricing
 * row "DeepSeek V4.1 Flash" is served as model id "deepseek-flash"), so
 * pricing rows must be matched to models.dev by id, never by name.
 */
function parseEndpointModelIds(html: string): Map<string, string> {
	for (const table of extractTables(html)) {
		const headerRow = table.match(/<tr[^>]*>.*?<\/tr>/s);
		const headers = headerRow ? readTableRow(headerRow[0]) : [];
		const indices = new Map(headers.map((header, index) => [header.toLowerCase(), index] as const));
		if (!REQUIRED_ENDPOINT_COLUMNS.every((name) => indices.has(name))) continue;
		const rows = [...table.matchAll(/<tr[^>]*>.*?<\/tr>/gs)].map((match) => readTableRow(match[0])).slice(1);
		const modelIds = new Map<string, string>();
		for (const cells of rows) {
			// Row and header cell counts must agree so ids cannot be read out of
			// a shifted column.
			if (cells.length !== headers.length) {
				throw new Error(
					`OpenCode Go endpoints row has ${cells.length} cells, expected ${headers.length}: ${JSON.stringify(cells)}`,
				);
			}
			const name = cells[indices.get("model") as number];
			const modelId = cells[indices.get("model id") as number];
			if (!name || !modelId) {
				throw new Error(`OpenCode Go endpoints row has an empty model name or id: ${JSON.stringify(cells)}`);
			}
			const nameKey = normalizeOpenCodeGoModelKey(name);
			// A duplicate name would overwrite its id mapping silently.
			if (modelIds.has(nameKey)) {
				throw new Error(`OpenCode Go endpoints table has duplicate rows for ${JSON.stringify(name)}`);
			}
			modelIds.set(nameKey, modelId);
		}
		// Two display names claiming the same id would collide once pricing
		// rows are keyed by id; fail instead of letting one win.
		if (new Set(modelIds.values()).size !== modelIds.size) {
			throw new Error("OpenCode Go endpoints table maps multiple models to the same model id");
		}
		if (modelIds.size === 0) throw new Error("OpenCode Go endpoints table parsed to zero rows");
		return modelIds;
	}
	throw new Error("OpenCode Go endpoints table not found on the docs page");
}

/**
 * Parse the Go docs pricing table out of the page HTML, keyed by the model
 * ids from the endpoints table (the page's authoritative name->id mapping).
 * The pricing table is anchored on its header row (Model / Input / Output /
 * Cached Read / Cached Write / Usage-or-Monthly-limit) because it is the only
 * table on the page with those columns: headers are matched through the
 * alias table so wording changes stay compatible, and the canonical column
 * names drive indexing so a page redesign that renames to an unknown
 * wording, removes, or inserts columns fails loudly here instead of silently
 * shifting prices into the wrong fields. Tiered ("> N tokens") and Peak rows
 * are skipped so each model keeps one flat cost from its base row (plain,
 * "≤ N tokens", or Off-Peak), matching the catalog's single-cost schema.
 */
export function parseOpenCodeGoPricingTable(html: string): Map<string, OpenCodeGoPricingRow> {
	let columns: Map<PricingColumnName, number> | undefined;
	let headerCount = 0;
	let pricingTable: string | undefined;
	for (const table of extractTables(html)) {
		const headerRow = table.match(/<tr[^>]*>.*?<\/tr>/s);
		const headers = headerRow ? readTableRow(headerRow[0]) : [];
		// Canonicalize headers via aliases; a candidate must expose every
		// required column, and no two headers may resolve to the same column.
		const candidate = new Map<PricingColumnName, number>();
		const duplicateColumns: PricingColumnName[] = [];
		for (const [index, header] of headers.entries()) {
			const column = PRICING_HEADER_TO_COLUMN.get(header.toLowerCase());
			if (!column) continue;
			// Duplicate resolution would make one header win silently; flag it
			// so a full candidate fails loudly instead of indexing the wrong one.
			if (candidate.has(column)) duplicateColumns.push(column);
			else candidate.set(column, index);
		}
		if (!REQUIRED_PRICING_COLUMNS.every((name) => candidate.has(name))) continue;
		if (duplicateColumns.length > 0) {
			throw new Error(`OpenCode Go pricing table has duplicate columns for ${duplicateColumns.join(", ")}`);
		}
		columns = candidate;
		headerCount = headers.length;
		pricingTable = table;
		break;
	}
	if (!pricingTable || !columns) throw new Error("OpenCode Go pricing table not found on the docs page");
	// The endpoints table supplies the authoritative id for each pricing row;
	// keying by id makes the models.dev lookup an exact match.
	const modelIds = parseEndpointModelIds(html);

	const rows = [...pricingTable.matchAll(/<tr[^>]*>.*?<\/tr>/gs)].map((match) => readTableRow(match[0])).slice(1);
	const pricing = new Map<string, OpenCodeGoPricingRow>();
	for (const cells of rows) {
		// Row and header cell counts must agree, otherwise a shifted row would
		// read prices out of the wrong columns.
		if (cells.length !== headerCount) {
			throw new Error(
				`OpenCode Go pricing row has ${cells.length} cells, expected ${headerCount}: ${JSON.stringify(cells)}`,
			);
		}
		const cell = (name: PricingColumnName) => cells[columns.get(name) as number];
		const variant = cell("model").match(/\(([^)]*)\)\s*$/)?.[1] ?? "";
		if (variant.startsWith(">") || variant.toLowerCase() === "peak") continue;
		const baseName = cell("model").replace(/\s*\([^)]*\)\s*$/, "").trim();
		// Unlimited-usage promos ("Unlimited" plus a "limited time" annotation)
		// make the allowance effectively infinite: the 60/usage multiplier
		// collapses to 0, so the promo-period per-token cost is free.
		const usageCell = cell("usage");
		const usage = usageCell.toLowerCase().startsWith("unlimited")
			? Infinity
			: parsePriceCell(usageCell, "usage");
		if (usage <= 0) {
			throw new Error(`OpenCode Go pricing row ${JSON.stringify(cell("model"))} has invalid usage allowance`);
		}
		const modelId = modelIds.get(normalizeOpenCodeGoModelKey(baseName));
		if (!modelId) {
			throw new Error(`OpenCode Go pricing row ${JSON.stringify(baseName)} has no model id in the endpoints table`);
		}
		if (pricing.has(modelId)) {
			throw new Error(`OpenCode Go pricing table has duplicate rows for model id ${JSON.stringify(modelId)}`);
		}
		pricing.set(modelId, {
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
 * round to the catalog's cost precision. Unlimited usage (Infinity) scales
 * everything to 0. The dash cells were already turned into 0 by the parser,
 * so unsupported cache prices stay free.
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

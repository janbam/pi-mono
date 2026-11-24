import type { ModelCost } from "../../src/types.ts";

/** Official Go model list, with endpoint IDs, per-million token prices, and plan allowances. */
export const OPENCODE_GO_PRICING_URL = "https://opencode.ai/inference/go/v1/models";

/** Monthly allowance in USD at which adjusted cost equals the nominal token price. */
const OPENCODE_GO_USAGE_BASELINE = 60;

/** Date-adjusted token prices in USD per million tokens and standard Go's monthly allowance in USD. */
export interface OpenCodeGoPricingRow {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Infinity represents an unlimited promotion. */
	usage: number;
}

/** Read a required JSON object and name the field if the provider changes its shape. */
function readObject(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`OpenCode Go pricing expected an object at ${field}`);
	}
	return value as Record<string, unknown>;
}

/** Read a finite, non-negative provider token rate without accepting string coercion. */
function readPrice(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`OpenCode Go pricing has an invalid rate at ${field}`);
	}
	return value;
}

/** Resolve the single cache-write rate shown in the Console's base pricing row. */
function readCacheWrite(value: unknown, field: string): number {
	if (value === undefined) return 0;
	if (typeof value === "number") return readPrice(value, field);
	const rates = readObject(value, field);
	// Match the Console's preference for short retention and its exclusion of the 12-hour rate.
	const rate = rates["5m"] ?? rates["30m"] ?? Object.entries(rates).find(([ttl]) => ttl !== "12h")?.[1];
	return rate === undefined ? 0 : readPrice(rate, field);
}

/** Match a UTC date range whose bounds use the catalog's YYYY-MM-DD format. */
function matchesDateRange(value: unknown, today: string, field: string): boolean {
	const bounds = Object.entries(readObject(value, field));
	if (bounds.length === 0) throw new Error(`OpenCode Go pricing expected date bounds at ${field}`);
	let matches = true;
	for (const [operator, bound] of bounds) {
		if (typeof bound !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(bound)) {
			throw new Error(`OpenCode Go pricing has an invalid UTC date at ${field}.${operator}`);
		}
		// Check every bound even if a previous bound already excludes today.
		switch (operator) {
			case "gt":
				matches = today > bound && matches;
				break;
			case "gte":
				matches = today >= bound && matches;
				break;
			case "lt":
				matches = today < bound && matches;
				break;
			case "lte":
				matches = today <= bound && matches;
				break;
			default:
				throw new Error(`OpenCode Go pricing has an unrecognised date condition at ${field}.${operator}`);
		}
	}
	return matches;
}

/** Evaluate a condition against the generation date, or return undefined for any peak schedule. */
function matchesDateCondition(value: unknown, today: string, field: string): boolean | undefined {
	const conditions = Object.entries(readObject(value, field));
	if (conditions.length === 0) throw new Error(`OpenCode Go pricing expected a condition at ${field}`);
	// Inspect every condition before deciding whether the rule can contribute a catalog rate.
	const matches = conditions.map(([kind, condition]) => {
		const path = `${field}.${kind}`;
		if (kind === "date") return matchesDateRange(condition, today, path);
		if (kind === "utc_days" || kind === "utc_hours") return undefined;
		if (kind === "all" || kind === "any") {
			if (!Array.isArray(condition) || condition.length === 0) {
				throw new Error(`OpenCode Go pricing expected a non-empty condition group at ${path}`);
			}
			const children = condition.map((child, index) => matchesDateCondition(child, today, `${path}[${index}]`));
			if (children.includes(undefined)) return undefined;
			return kind === "all" ? children.every(Boolean) : children.some(Boolean);
		}
		throw new Error(`OpenCode Go pricing has an unrecognised multiplier condition at ${path}`);
	});
	return matches.includes(undefined) ? undefined : matches.every(Boolean);
}

/** Combine active date-only factors that apply to every base text rate. */
function readDateMultiplier(value: unknown, today: string, field: string): number {
	if (value === undefined) return 1;
	if (!Array.isArray(value)) throw new Error(`OpenCode Go pricing expected an array at ${field}`);
	return value.reduce<number>((multiplier, rule, index) => {
		const path = `${field}[${index}]`;
		const { when, factor } = readObject(rule, path);
		return matchesDateCondition(when, today, `${path}.when`)
			? readPrice(multiplier * readPrice(factor, `${path}.factor`), field)
			: multiplier;
	}, 1);
}

/** Parse official Go catalog pricing by endpoint ID at the supplied generation time. Throws on unsupported conditions. */
export function parseOpenCodeGoPricing(payload: unknown, now = new Date()): Map<string, OpenCodeGoPricingRow> {
	const { data } = readObject(payload, "response");
	if (!Array.isArray(data) || data.length === 0) {
		throw new Error("OpenCode Go pricing expected a non-empty model list");
	}

	// Use one UTC calendar date for the whole catalog, even if generation crosses midnight.
	const today = now.toISOString().slice(0, 10);
	const pricing = new Map<string, OpenCodeGoPricingRow>();
	for (const entry of data) {
		const model = readObject(entry, "model");
		const { id } = model;
		if (typeof id !== "string" || id.trim() === "") throw new Error("OpenCode Go pricing has an invalid model ID");
		if (pricing.has(id)) throw new Error(`OpenCode Go pricing has duplicate rows for model ID ${JSON.stringify(id)}`);

		// Only an explicit null marks unlimited usage; never borrow another plan's allowance.
		const { monthly_usage: monthlyUsage } = readObject(model.go, `${id}.go`);
		const usage = monthlyUsage === null ? Infinity : readObject(monthlyUsage, `${id}.go.monthly_usage`).go;
		if (typeof usage !== "number" || usage <= 0 || (monthlyUsage !== null && !Number.isFinite(usage))) {
			throw new Error(`OpenCode Go pricing has an invalid standard Go allowance for ${id}`);
		}

		// Apply stable date changes to base text rates. Context tiers and peak prices depend on each request.
		const cost = readObject(model.cost, `${id}.cost`);
		const multiplier = readDateMultiplier(cost.multipliers, today, `${id}.cost.multipliers`);
		const text = readObject(cost.text, `${id}.cost.text`);
		const input = readObject(text.input, `${id}.cost.text.input`);
		const output = readObject(text.output, `${id}.cost.text.output`);
		const cache = input.cache === undefined ? undefined : readObject(input.cache, `${id}.cost.text.input.cache`);
		pricing.set(id, {
			input: multiplier * readPrice(input.price, `${id}.cost.text.input.price`),
			output: multiplier * readPrice(output.price, `${id}.cost.text.output.price`),
			cacheRead:
				cache?.read === undefined ? 0 : multiplier * readPrice(cache.read, `${id}.cost.text.input.cache.read`),
			cacheWrite: multiplier * readCacheWrite(cache?.write, `${id}.cost.text.input.cache.write`),
			usage,
		});
	}
	return pricing;
}

/** Normalize token cost to how fast the model drains its allowance, with unlimited usage costing zero. */
export function getOpenCodeGoUsageAdjustedCost(row: OpenCodeGoPricingRow): ModelCost {
	const multiplier = OPENCODE_GO_USAGE_BASELINE / row.usage;
	// Round each scaled rate to the catalog's six-decimal precision.
	return {
		input: Number((row.input * multiplier).toFixed(6)),
		output: Number((row.output * multiplier).toFixed(6)),
		cacheRead: Number((row.cacheRead * multiplier).toFixed(6)),
		cacheWrite: Number((row.cacheWrite * multiplier).toFixed(6)),
	};
}

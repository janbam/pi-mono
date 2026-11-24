import type { ModelCost } from "../src/types.ts";

/** Official Go model list, with endpoint IDs, per-million token prices, and plan allowances. */
export const OPENCODE_GO_PRICING_URL = "https://opencode.ai/inference/go/v1/models";

/** Monthly allowance in USD at which adjusted cost equals the nominal token price. */
const OPENCODE_GO_USAGE_BASELINE = 60;

/** Base token prices in USD per million tokens and standard Go's monthly allowance in USD. */
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

/** Parse official Go catalog pricing by exact endpoint ID. Throws on malformed prices or allowances. */
export function parseOpenCodeGoPricing(payload: unknown): Map<string, OpenCodeGoPricingRow> {
	const { data } = readObject(payload, "response");
	if (!Array.isArray(data) || data.length === 0) {
		throw new Error("OpenCode Go pricing expected a non-empty model list");
	}

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

		// Keep the base text rates, as before. Context overrides and scheduled multipliers are separate rates.
		const text = readObject(readObject(model.cost, `${id}.cost`).text, `${id}.cost.text`);
		const input = readObject(text.input, `${id}.cost.text.input`);
		const output = readObject(text.output, `${id}.cost.text.output`);
		const cache = input.cache === undefined ? undefined : readObject(input.cache, `${id}.cost.text.input.cache`);
		pricing.set(id, {
			input: readPrice(input.price, `${id}.cost.text.input.price`),
			output: readPrice(output.price, `${id}.cost.text.output.price`),
			cacheRead: cache?.read === undefined ? 0 : readPrice(cache.read, `${id}.cost.text.input.cache.read`),
			cacheWrite: readCacheWrite(cache?.write, `${id}.cost.text.input.cache.write`),
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

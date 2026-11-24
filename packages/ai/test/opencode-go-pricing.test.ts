import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getOpenCodeGoUsageAdjustedCost, parseOpenCodeGoPricing } from "../scripts/opencode-go-pricing.ts";
import type { Api, Model } from "../src/types.ts";

/** Models required by the generator's strict Qwen Token Plan Individual allowlist. */
const qwenTokenPlanIndividualModelIds = [
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
];

/** Relevant fields from OpenCode's public Go model response, including a context price override. */
const grok = {
	id: "grok-4.7",
	name: "Grok 4.7",
	cost: {
		text: {
			input: { price: 2, cache: { read: 0.5 }, overrides: [{ when: { context: { gt: 200000 } }, price: 4 }] },
			output: { price: 6, overrides: [{ when: { context: { gt: 200000 } }, price: 12 }] },
		},
	},
	go: { monthly_usage: { "go-plus": 60, go: 15, "go-teams": 20 } },
};

describe("parseOpenCodeGoPricing", () => {
	it("uses exact model IDs, standard Go allowances, and base rates despite context overrides", () => {
		const pricing = parseOpenCodeGoPricing({ data: [grok] });
		expect(pricing).toEqual(
			new Map([["grok-4.7", { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, usage: 15 }]]),
		);
	});

	it.each([
		[3, 3],
		[{ "12h": 0.5, "30m": 0.25 }, 0.25],
		[{ "1h": 3, "5m": 1.875 }, 1.875],
	])("accepts scalar and retention-specific cache write rates: %j", (write, cacheWrite) => {
		const catalog = {
			data: [{ ...grok, cost: { text: { input: { price: 2, cache: { write } }, output: { price: 6 } } } }],
		};
		expect(parseOpenCodeGoPricing(catalog).get(grok.id)).toMatchObject({ cacheRead: 0, cacheWrite });
	});

	it("interprets a null monthly usage record as an unlimited promotion", () => {
		const free = {
			id: "beam-free",
			cost: { text: { input: { price: 0, cache: { read: 0 } }, output: { price: 0 } } },
			go: { monthly_usage: null },
		};
		expect(parseOpenCodeGoPricing({ data: [free] }).get(free.id)).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			usage: Infinity,
		});
	});

	it.each([
		[{ data: [] }, "expected a non-empty model list"],
		[{ data: [grok, grok] }, 'duplicate rows for model ID "grok-4.7"'],
		[{ data: [{ ...grok, id: "" }] }, "invalid model ID"],
		[{ data: [{ ...grok, go: { monthly_usage: { "go-plus": 60 } } }] }, "invalid standard Go allowance"],
		[{ data: [{ ...grok, go: { monthly_usage: { go: 0 } } }] }, "invalid standard Go allowance"],
		[
			{ data: [{ ...grok, cost: { text: { ...grok.cost.text, output: { price: "6" } } } }] },
			"invalid rate at grok-4.7.cost.text.output.price",
		],
	])("rejects malformed pricing: %s", (payload, message) => {
		expect(() => parseOpenCodeGoPricing(payload)).toThrow(message);
	});
});

describe("getOpenCodeGoUsageAdjustedCost", () => {
	it.each([
		[15, { input: 8, output: 24, cacheRead: 2, cacheWrite: 1 }],
		[30, { input: 4, output: 12, cacheRead: 1, cacheWrite: 0.5 }],
		[60, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0.25 }],
		[Infinity, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
	])("scales base prices by 60 / %s", (usage, expected) => {
		expect(getOpenCodeGoUsageAdjustedCost({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0.25, usage })).toEqual(
			expected,
		);
	});

	it("rounds adjusted prices to the catalog's cost precision", () => {
		expect(getOpenCodeGoUsageAdjustedCost({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, usage: 7 }).input).toBe(
			8.571429,
		);
	});
});

/** Disposable output roots owned by generator subprocess tests. */
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** Run strict generation with a mocked Go response and isolated JSON output. */
function generateWithGoCatalog(goCatalog: unknown, status = 200) {
	const root = mkdtempSync(join(tmpdir(), "pi-opencode-go-pricing-"));
	temporaryRoots.push(root);
	const preloadPath = join(root, "mock-fetch.mjs");
	const outputPath = join(root, "catalog");

	// Zen shares the ID but has different prices. A Go model missing from the official list must also keep its rates.
	const catalog = {
		"alibaba-token-plan": {
			models: Object.fromEntries(
				qwenTokenPlanIndividualModelIds.map((id) => [id, { id, name: id, tool_call: true }]),
			),
		},
		"opencode-go": {
			models: {
				[grok.id]: {
					name: "Different display name",
					tool_call: true,
					cost: { input: 2, output: 6, cache_read: 0.5 },
				},
				"brand-new-model": { tool_call: true, cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
			},
		},
		opencode: { models: { [grok.id]: { tool_call: true, cost: { input: 9, output: 9, cache_read: 9 } } } },
	};

	// Serve only the metadata sources required for catalog generation, with no live provider calls.
	writeFileSync(
		preloadPath,
		`globalThis.fetch = async (input) => {
			const url = String(input);
			if (url === "https://models.dev/api.json") return Response.json(${JSON.stringify(catalog)});
			if (url === "https://opencode.ai/inference/go/v1/models") return Response.json(${JSON.stringify(goCatalog)}, { status: ${status} });
			if (url === "https://models.dev/models.json?type=decision") return Response.json({ "typesafe/jev-latest": { id: "jev-latest", name: "Jev", type: "decision" } });
			if (url === "https://openrouter.ai/api/v1/models?output_modalities=image") return Response.json({ data: [{ id: "test-image", name: "Test Image", architecture: { input_modalities: ["text"], output_modalities: ["image"] } }] });
			if (url.startsWith("https://openrouter.ai/api/v1/models") || url === "https://ai-gateway.vercel.sh/v1/models") return Response.json({ data: [] });
			if (url === "https://radius.pi.dev/v1/config") return Response.json({ baseUrl: "https://radius.pi.dev", models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 4096 }] });
			throw new Error(\`Unexpected fetch: \${url}\`);
		};`,
	);

	// JSON-only output keeps the package's checked-in and generated model artifacts untouched.
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--strict",
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
	);
	return { outputPath, status: result.status, log: `${result.stdout}\n${result.stderr}` };
}

/** Read a provider's generated chat catalog keyed by endpoint ID. */
function readGeneratedModels(outputPath: string, provider: string): Record<string, Model<Api>> {
	return JSON.parse(readFileSync(join(outputPath, "providers", `${provider}.json`), "utf8"));
}

describe("strict model generation with the OpenCode Go pricing override", () => {
	it("scales matched Go models and preserves the nominal rates for Zen and unmatched Go models", () => {
		const { outputPath, status, log } = generateWithGoCatalog({ data: [grok] });
		expect(status, log).toBe(0);
		expect(log).toContain("OpenCode Go pricing catalog has no row for brand-new-model");

		const goModels = readGeneratedModels(outputPath, "opencode-go");
		expect(goModels[grok.id].cost).toEqual({ input: 8, output: 24, cacheRead: 2, cacheWrite: 0 });
		expect(goModels["brand-new-model"].cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
		expect(readGeneratedModels(outputPath, "opencode")[grok.id].cost).toEqual({
			input: 9,
			output: 9,
			cacheRead: 9,
			cacheWrite: 0,
		});
	});

	it.each([
		[503, "OpenCode Go model list returned 503"],
		[200, "OpenCode Go pricing expected a non-empty model list"],
	])("does not emit a catalog when the Go source fails validation (HTTP %s)", (httpStatus, message) => {
		const { outputPath, status, log } = generateWithGoCatalog({ data: [] }, httpStatus);
		expect(status, log).toBe(1);
		expect(log).toContain(message);
		expect(existsSync(outputPath)).toBe(false);
	});
});

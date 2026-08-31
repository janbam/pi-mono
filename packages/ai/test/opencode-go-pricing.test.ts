import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	getOpenCodeGoUsageAdjustedCost,
	normalizeOpenCodeGoModelKey,
	OPENCODE_GO_PRICING_URL,
	parseOpenCodeGoPricingTable,
} from "../scripts/opencode-go-pricing.ts";
import type { Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];
/** Models required by the generator's strict Qwen Token Plan Individual allowlist. */
const qwenTokenPlanIndividualModelIds = [
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max",
];

/** Mirrors the Go docs page structure: a decoy table first, then the pricing table. */
const pricingPageHtml = `
<table>
	<tr><th>Model</th><th>requests per 5 hour</th><th>requests per week</th><th>requests per month</th></tr>
	<tr><td>Grok 4.6</td><td>100</td><td>600</td><td>2400</td></tr>
</table>
<table>
	<tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Usage</th></tr>
	<tr><td>Grok 4.6 (&#8804; 200K tokens)</td><td>$2.00</td><td>$6.00</td><td>$0.50</td><td>-</td><td>$15</td></tr>
	<tr><td>Grok 4.6 (&gt; 200K tokens)</td><td>$4.00</td><td>$12.00</td><td>$1.00</td><td>-</td><td>$15</td></tr>
	<tr><td>DeepSeek V4 Pro (Off-Peak)</td><td>$0.66</td><td>$1.98</td><td>$0.022</td><td>-</td><td>$15</td></tr>
	<tr><td>DeepSeek V4 Pro (Peak)</td><td>$1.32</td><td>$3.96</td><td>$0.044</td><td>-</td><td>$15</td></tr>
	<tr><td>GPT 5.6 Luna</td><td>$0.20</td><td>$1.20</td><td>$0.02</td><td>$0.25</td><td>$15</td></tr>
	<tr><td>MiniMax M2.7</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td></tr>
	<tr><td>GLM-5.3-Flash</td><td>$0.15</td><td>$0.50</td><td>$0.03</td><td>-</td><td>$15</td></tr>
</table>
<table>
	<tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr>
	<tr><td>Grok 4.6</td><td>grok-4.6</td><td>/</td><td>@ai-sdk/xai</td></tr>
</table>
`;

describe("parseOpenCodeGoPricingTable", () => {
	it("selects the pricing table by its header columns and skips high-tier and peak rows", () => {
		const pricing = parseOpenCodeGoPricingTable(pricingPageHtml);
		// Every base model appears once: the > 200K and Peak variants are dropped.
		expect([...pricing.keys()].sort()).toEqual(["deepseekv4pro", "glm53flash", "gpt56luna", "grok46", "minimaxm27"]);
		// The ≤ 200K row is the one kept for Grok, and the dash cache-write cell becomes 0.
		expect(pricing.get("grok46")).toEqual({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, usage: 15 });
		expect(pricing.get("deepseekv4pro")).toEqual({
			input: 0.66,
			output: 1.98,
			cacheRead: 0.022,
			cacheWrite: 0,
			usage: 15,
		});
		expect(pricing.get("minimaxm27")).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
			usage: 60,
		});
	});

	it("normalizes page names and model ids to the same lookup key", () => {
		expect(normalizeOpenCodeGoModelKey("GPT 5.6 Luna")).toBe(normalizeOpenCodeGoModelKey("gpt-5.6-luna"));
		expect(normalizeOpenCodeGoModelKey("GLM-5.3-Flash")).toBe(normalizeOpenCodeGoModelKey("glm-5.3-flash"));
	});

	it("indexes columns by header name, so reordered or extra columns cannot shift prices", () => {
		const reordered = `
<table>
	<tr><th>Usage</th><th>Cached Write</th><th>Cached Read</th><th>Output</th><th>Input</th><th>Model</th></tr>
	<tr><td>$60</td><td>$0.375</td><td>$0.06</td><td>$1.20</td><td>$0.30</td><td>MiniMax M2.7</td></tr>
	<tr><td>$15</td><td>-</td><td>$0.02</td><td>$1.20</td><td>$0.20</td><td>GPT 5.6 Luna</td></tr>
</table>`;
		const reorderedPricing = parseOpenCodeGoPricingTable(reordered);
		expect(reorderedPricing.get("minimaxm27")).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
			usage: 60,
		});
		expect(reorderedPricing.get("gpt56luna")).toEqual({
			input: 0.2,
			output: 1.2,
			cacheRead: 0.02,
			cacheWrite: 0,
			usage: 15,
		});

		const withExtraColumn = `
<table>
	<tr><th>Model</th><th>Notes</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Usage</th></tr>
	<tr><td>MiniMax M2.7</td><td>preview</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td></tr>
</table>`;
		expect(parseOpenCodeGoPricingTable(withExtraColumn).get("minimaxm27")).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
			usage: 60,
		});
	});

	it("fails loudly when the pricing table is missing or malformed", () => {
		const noPricingTable = "<table><tr><th>Model</th><th>requests per 5 hour</th></tr></table>";
		expect(() => parseOpenCodeGoPricingTable(noPricingTable)).toThrow("pricing table not found");

		const duplicateRow = pricingPageHtml.replace(
			"<tr><td>MiniMax M2.7</td>",
			"<tr><td>MiniMax M2.7 (EU)</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td></tr>\n\t<tr><td>MiniMax M2.7</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(duplicateRow)).toThrow("duplicate rows for");

		const badPrice = pricingPageHtml.replace(
			"<td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td>",
			"<td>call for pricing</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(badPrice)).toThrow("unparseable input cell");

		const badUsage = pricingPageHtml.replace(
			"<td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td>",
			"<td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>-</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(badUsage)).toThrow("invalid usage allowance");

		// A body row with a different cell count than the header would read
		// prices out of shifted columns; it must fail instead.
		const shiftedRow = pricingPageHtml.replace(
			"<tr><td>MiniMax M2.7</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td></tr>",
			"<tr><td>MiniMax M2.7</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td></tr>",
		);
		expect(() => parseOpenCodeGoPricingTable(shiftedRow)).toThrow("has 5 cells, expected 6");
	});
});

describe("getOpenCodeGoUsageAdjustedCost", () => {
	it("scales prices by the $60 usage baseline: $15 quadruples, $30 doubles, $60 keeps", () => {
		expect(getOpenCodeGoUsageAdjustedCost({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, usage: 15 })).toEqual(
			{ input: 8, output: 24, cacheRead: 2, cacheWrite: 0 },
		);
		expect(
			getOpenCodeGoUsageAdjustedCost({ input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2, usage: 30 }),
		).toEqual({ input: 0.3, output: 0.94, cacheRead: 0.032, cacheWrite: 0.4 });
		expect(
			getOpenCodeGoUsageAdjustedCost({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375, usage: 60 }),
		).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
	});

	it("rounds adjusted prices to the catalog's cost precision", () => {
		expect(
			getOpenCodeGoUsageAdjustedCost({ input: 0.834, output: 2.501, cacheRead: 0.042, cacheWrite: 0, usage: 30 }),
		).toEqual({ input: 1.668, output: 5.002, cacheRead: 0.084, cacheWrite: 0 });
	});
});

/** Copies the AI package into a disposable root so generator runs never mutate the worktree. */
function createIsolatedPackage(): { fixtureRoot: string; isolatedPackageRoot: string } {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-opencode-go-pricing-"));
	temporaryRoots.push(fixtureRoot);

	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}
	return { fixtureRoot, isolatedPackageRoot };
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("strict model generation with the OpenCode Go pricing override", () => {
	it("replaces opencode-go costs with usage-adjusted page prices while opencode (Zen) keeps models.dev costs", () => {
		const { fixtureRoot, isolatedPackageRoot } = createIsolatedPackage();
		const preloadPath = join(fixtureRoot, "mock-fetch.mjs");

		// Zen carries a grok-4.6 with distinct nominal prices: it must stay untouched,
		// proving the override is scoped to opencode-go only.
		const model = (cost: Record<string, number>) => ({
			name: "model",
			tool_call: true,
			reasoning: false,
			limit: { context: 8192, output: 1024 },
			cost,
		});
		const catalog = {
			"alibaba-token-plan": {
				models: Object.fromEntries(
					qwenTokenPlanIndividualModelIds.map((id) => [id, { id, name: id, tool_call: true }]),
				),
			},
			"opencode-go": {
				models: {
					"grok-4.6": model({ input: 2, output: 6, cache_read: 0.5, cache_write: 0 }),
					"minimax-m2.7": model({ input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0 }),
					"glm-5.3-flash": model({ input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0 }),
					// A model the pricing page does not list yet keeps its models.dev cost.
					"brand-new-model": model({ input: 1, output: 2, cache_read: 3, cache_write: 4 }),
				},
			},
			opencode: {
				models: {
					"grok-4.6": model({ input: 9, output: 9, cache_read: 9, cache_write: 0 }),
				},
			},
		};
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`const pricingPage = ${JSON.stringify(pricingPageHtml)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  if (url === ${JSON.stringify(OPENCODE_GO_PRICING_URL)}) return new Response(pricingPage, { status: 200 });\n` +
				`  if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === "https://ai-gateway.vercel.sh/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain("OpenCode Go pricing page has no row for brand-new-model");

		const goModels = readGeneratedModels(isolatedPackageRoot, "opencode-go.json");
		// Page prices scaled by 60/usage: grok-4.6 x4, minimax-m2.7 x1 (cache write picked up from the page), glm-5.3-flash x4.
		expect(goModels["grok-4.6"].cost).toEqual({ input: 8, output: 24, cacheRead: 2, cacheWrite: 0 });
		expect(goModels["minimax-m2.7"].cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
		expect(goModels["glm-5.3-flash"].cost).toEqual({ input: 0.6, output: 2, cacheRead: 0.12, cacheWrite: 0 });
		expect(goModels["brand-new-model"].cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });

		const zenModels = readGeneratedModels(isolatedPackageRoot, "opencode.json");
		expect(zenModels["grok-4.6"].cost).toEqual({ input: 9, output: 9, cacheRead: 9, cacheWrite: 0 });
	});

	it("fails the strict generator when the pricing page cannot be fetched", () => {
		const { fixtureRoot, isolatedPackageRoot } = createIsolatedPackage();
		const preloadPath = join(fixtureRoot, "mock-fetch.mjs");
		const catalog = {
			"alibaba-token-plan": {
				models: Object.fromEntries(
					qwenTokenPlanIndividualModelIds.map((id) => [id, { id, name: id, tool_call: true }]),
				),
			},
			"opencode-go": {
				models: {
					"grok-4.6": {
						name: "Grok 4.6",
						tool_call: true,
						reasoning: false,
						limit: { context: 8192, output: 1024 },
					},
				},
			},
		};
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === "https://ai-gateway.vercel.sh/v1/models") return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
				`  if (url === ${JSON.stringify(OPENCODE_GO_PRICING_URL)}) throw new Error("docs page unreachable");\n` +
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 10_000 },
		);
		// A failed pricing fetch is a build failure in strict mode, not a silent fallback.
		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("docs page unreachable");
	});
});

/** Read a generated provider file and flatten its API groups into a model map. */
function readGeneratedModels(isolatedPackageRoot: string, filename: string): Record<string, Model<any>> {
	const generated = JSON.parse(readFileSync(join(isolatedPackageRoot, "src/providers/data", filename), "utf8"));
	return Object.assign({}, ...Object.values(generated));
}

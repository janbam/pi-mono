import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	getOpenCodeGoUsageAdjustedCost,
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

/** Mirrors the Go docs page: request-estimate decoy table, pricing table, endpoints table. */
const requestsTableHtml = `
<table>
	<tr><th>Model</th><th>requests per 5 hour</th><th>requests per week</th><th>requests per month</th></tr>
	<tr><td>Grok 4.6</td><td>100</td><td>600</td><td>2400</td></tr>
</table>`;

const pricingTableHtml = `
<table>
	<tr><th>Model</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr>
	<tr><td>Grok 4.6 (&#8804; 200K tokens)</td><td>$2.00</td><td>$6.00</td><td>$0.50</td><td>-</td><td><strong>$15</strong></td></tr>
	<tr><td>Grok 4.6 (&gt; 200K tokens)</td><td>$4.00</td><td>$12.00</td><td>$1.00</td><td>-</td><td><strong>$15</strong></td></tr>
	<tr><td>DeepSeek V4.1 Flash (Off-Peak)</td><td>$0.15</td><td>$0.60</td><td>$0.003</td><td>-</td><td><strong>$15</strong></td></tr>
	<tr><td>DeepSeek V4.1 Flash (Peak)</td><td>$0.30</td><td>$1.20</td><td>$0.006</td><td>-</td><td><strong>$15</strong></td></tr>
	<tr><td>DeepSeek V4 Pro (Off-Peak)</td><td>$0.66</td><td>$1.98</td><td>$0.022</td><td>-</td><td><strong>$15</strong></td></tr>
	<tr><td>DeepSeek V4 Pro (Peak)</td><td>$1.32</td><td>$3.96</td><td>$0.044</td><td>-</td><td><strong>$15</strong></td></tr>
	<tr><td>GPT 5.6 Luna</td><td>$0.20</td><td>$1.20</td><td>$0.02</td><td>$0.25</td><td><strong>$15</strong></td></tr>
	<tr><td>MiniMax M2.7</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td><strong>$60</strong></td></tr>
	<tr><td>GLM-5.3-Flash</td><td>$0.15</td><td>$0.50</td><td>$0.03</td><td>-</td><td><strong>$60</strong></td></tr>
</table>`;

const endpointsTableHtml = `
<table>
	<tr><th>Model</th><th>Model ID</th><th>Endpoint</th><th>AI SDK Package</th></tr>
	<tr><td>Grok 4.6</td><td>grok-4.6</td><td>/</td><td>@ai-sdk/xai</td></tr>
	<tr><td>DeepSeek V4.1 Flash</td><td>deepseek-flash</td><td>/</td><td>@ai-sdk/openai-compatible</td></tr>
	<tr><td>DeepSeek V4 Pro</td><td>deepseek-v4-pro</td><td>/</td><td>@ai-sdk/openai-compatible</td></tr>
	<tr><td>GPT 5.6 Luna</td><td>gpt-5.6-luna</td><td>/</td><td>@ai-sdk/openai</td></tr>
	<tr><td>MiniMax M2.7</td><td>minimax-m2.7</td><td>/</td><td>@ai-sdk/anthropic</td></tr>
	<tr><td>GLM-5.3-Flash</td><td>glm-5.3-flash</td><td>/</td><td>@ai-sdk/openai-compatible</td></tr>
</table>`;

const pricingPageHtml = `${requestsTableHtml}${pricingTableHtml}${endpointsTableHtml}`;

describe("parseOpenCodeGoPricingTable", () => {
	it("selects the pricing table by its header columns, keys rows by endpoint model id, and skips high-tier and peak rows", () => {
		const pricing = parseOpenCodeGoPricingTable(pricingPageHtml);
		// Every base model appears once under its endpoint model id: the > 200K
		// and Peak variants are dropped, and names join to ids via the
		// endpoints table ("DeepSeek V4.1 Flash" -> "deepseek-flash").
		expect([...pricing.keys()].sort()).toEqual([
			"deepseek-flash",
			"deepseek-v4-pro",
			"glm-5.3-flash",
			"gpt-5.6-luna",
			"grok-4.6",
			"minimax-m2.7",
		]);
		// The ≤ 200K row is the one kept for Grok, and the dash cache-write cell becomes 0.
		expect(pricing.get("grok-4.6")).toEqual({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0, usage: 15 });
		expect(pricing.get("deepseek-flash")).toEqual({
			input: 0.15,
			output: 0.6,
			cacheRead: 0.003,
			cacheWrite: 0,
			usage: 15,
		});
		expect(pricing.get("deepseek-v4-pro")).toEqual({
			input: 0.66,
			output: 1.98,
			cacheRead: 0.022,
			cacheWrite: 0,
			usage: 15,
		});
		expect(pricing.get("minimax-m2.7")).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
			usage: 60,
		});
	});

	it("indexes columns by canonical header name, so reordered, extra, or reworded columns cannot shift prices", () => {
		// "Usage" is the legacy header wording; the live page says "Monthly
		// limit" since Sep 2026, so both must resolve to the usage column.
		const reordered = `
<table>
	<tr><th>Usage</th><th>Cached Write</th><th>Cached Read</th><th>Output</th><th>Input</th><th>Model</th></tr>
	<tr><td>$60</td><td>$0.375</td><td>$0.06</td><td>$1.20</td><td>$0.30</td><td>MiniMax M2.7</td></tr>
	<tr><td>$15</td><td>-</td><td>$0.02</td><td>$1.20</td><td>$0.20</td><td>GPT 5.6 Luna</td></tr>
</table>${endpointsTableHtml}`;
		const reorderedPricing = parseOpenCodeGoPricingTable(reordered);
		expect(reorderedPricing.get("minimax-m2.7")).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
			usage: 60,
		});
		expect(reorderedPricing.get("gpt-5.6-luna")).toEqual({
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
</table>${endpointsTableHtml}`;
		expect(parseOpenCodeGoPricingTable(withExtraColumn).get("minimax-m2.7")).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
			usage: 60,
		});
	});

	it("fails loudly when the pricing or endpoints table is missing or malformed", () => {
		const noPricingTable = "<table><tr><th>Model</th><th>requests per 5 hour</th></tr></table>";
		expect(() => parseOpenCodeGoPricingTable(noPricingTable)).toThrow("pricing table not found");

		// Pricing without the endpoints table cannot map names to model ids.
		expect(() => parseOpenCodeGoPricingTable(`${requestsTableHtml}${pricingTableHtml}`)).toThrow(
			"endpoints table not found",
		);

		// A pricing model absent from the endpoints table has no id to key by.
		const rowWithoutModelId = pricingPageHtml.replace(
			"<tr><td>GLM-5.3-Flash</td>",
			"<tr><td>Mystery Model</td><td>$1</td><td>$2</td><td>$0.1</td><td>-</td><td><strong>$60</strong></td></tr>\n\t<tr><td>GLM-5.3-Flash</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(rowWithoutModelId)).toThrow(
			'OpenCode Go pricing row "Mystery Model" has no model id in the endpoints table',
		);

		// Two endpoints rows for the same display name would overwrite the
		// name->id mapping silently.
		const duplicateEndpointsRow = pricingPageHtml.replace(
			"<tr><td>Grok 4.6</td><td>grok-4.6</td>",
			"<tr><td>Grok 4.6</td><td>grok-4.6</td><td>/</td><td>@ai-sdk/xai</td></tr>\n\t<tr><td>Grok 4.6</td><td>grok-4.6</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(duplicateEndpointsRow)).toThrow("duplicate rows for");

		// Two endpoints names claiming the same id would collide when pricing
		// rows are keyed by id.
		const endpointsIdCollision = pricingPageHtml.replace(
			"<td>grok-4.6</td><td>/</td><td>@ai-sdk/xai</td>",
			"<td>minimax-m2.7</td><td>/</td><td>@ai-sdk/xai</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(endpointsIdCollision)).toThrow("same model id");

		// Two pricing variants collapsing to one base name hit the same model
		// id; one row would silently win.
		const duplicateRow = pricingPageHtml.replace(
			"<tr><td>MiniMax M2.7</td>",
			"<tr><td>MiniMax M2.7 (EU)</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td><strong>$60</strong></td></tr>\n\t<tr><td>MiniMax M2.7</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(duplicateRow)).toThrow('duplicate rows for model id "minimax-m2.7"');

		const badPrice = pricingPageHtml.replace(
			"<td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td><strong>$60</strong></td>",
			"<td>call for pricing</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td><strong>$60</strong></td>",
		);
		expect(() => parseOpenCodeGoPricingTable(badPrice)).toThrow("unparseable input cell");

		const badUsage = pricingPageHtml.replace(
			"<td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td><strong>$60</strong></td>",
			"<td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>-</td>",
		);
		expect(() => parseOpenCodeGoPricingTable(badUsage)).toThrow("invalid usage allowance");

		// Two headers resolving to the same canonical column (here "Input" and
		// its alias) would make one win silently; the parser must fail instead.
		const aliasedDuplicateColumn = `
<table>
	<tr><th>Model</th><th>Input</th><th>Input</th><th>Output</th><th>Cached Read</th><th>Cached Write</th><th>Monthly limit</th></tr>
	<tr><td>MiniMax M2.7</td><td>$0.30</td><td>$9</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td>$60</td></tr>
</table>`;
		expect(() => parseOpenCodeGoPricingTable(aliasedDuplicateColumn)).toThrow("duplicate columns for input");

		// A body row with a different cell count than the header would read
		// prices out of shifted columns; it must fail instead.
		const shiftedRow = pricingPageHtml.replace(
			"<tr><td>MiniMax M2.7</td><td>$0.30</td><td>$1.20</td><td>$0.06</td><td>$0.375</td><td><strong>$60</strong></td></tr>",
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
					// Regression: models.dev reuses the short id "deepseek-flash" for
					// V4.1 Flash, which the page calls "DeepSeek V4.1 Flash" — only the
					// endpoints-table id mapping can join them.
					"deepseek-flash": model({ input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0 }),
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
		expect(`${result.stdout}\n${result.stderr}`).not.toContain("no row for deepseek-flash");

		const goModels = readGeneratedModels(isolatedPackageRoot, "opencode-go.json");
		// Page prices scaled by 60/usage: grok-4.6 and deepseek-flash x4 ($15
		// usage — proving the id-join), minimax-m2.7 and glm-5.3-flash x1 ($60,
		// cache write picked up from the page for minimax).
		expect(goModels["grok-4.6"].cost).toEqual({ input: 8, output: 24, cacheRead: 2, cacheWrite: 0 });
		expect(goModels["deepseek-flash"].cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.012, cacheWrite: 0 });
		expect(goModels["minimax-m2.7"].cost).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 });
		expect(goModels["glm-5.3-flash"].cost).toEqual({ input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 });
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

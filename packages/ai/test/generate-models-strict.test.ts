import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../src/api/cloudflare.ts";
import type { Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];
/** Models required by the generator's strict Qwen Token Plan Individual allowlist. */
const qwenTokenPlanIndividualModelIds = [
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max",
];

/** Copies the AI package into a disposable root for isolated generator tests. */
function createIsolatedPackage(): { fixtureRoot: string; isolatedPackageRoot: string } {
	// Track the complete fixture root so every generated artifact is removed after the test.
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
	temporaryRoots.push(fixtureRoot);

	// Preserve the package's real generator inputs while isolating all mutations from the worktree.
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

describe("strict model generation", () => {
	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const { fixtureRoot, isolatedPackageRoot } = createIsolatedPackage();
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [...qwenTokenPlanIndividualModelIds, "qwen3.8-max-preview"];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});

	it("derives gateway Workers AI routes while preserving direct gateway metadata", () => {
		const { fixtureRoot, isolatedPackageRoot } = createIsolatedPackage();
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const standaloneOnlyId = "@cf/example/standalone-only";
		const overlappingId = "@cf/example/overlap";

		// Simulate the drift that broke builds and an overlap that proves direct gateway metadata remains authoritative.
		const catalog = {
			"alibaba-token-plan": {
				models: Object.fromEntries(
					qwenTokenPlanIndividualModelIds.map((id) => [id, { id, name: id, tool_call: true }]),
				),
			},
			"cloudflare-workers-ai": {
				models: {
					[standaloneOnlyId]: {
						id: standaloneOnlyId,
						name: "Standalone only",
						tool_call: true,
						limit: { context: 8192, output: 1024 },
					},
					[overlappingId]: {
						id: overlappingId,
						name: "Standalone metadata",
						tool_call: true,
						limit: { context: 4096, output: 512 },
					},
				},
			},
			"cloudflare-ai-gateway": {
				models: {
					[`workers-ai/${overlappingId}`]: {
						id: `workers-ai/${overlappingId}`,
						name: "Gateway metadata",
						tool_call: true,
						limit: { context: 16384, output: 2048 },
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
				`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
				`};\n`,
		);

		// Run the real generator against only the controlled provider payloads.
		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

		// Prove both route synthesis and direct-metadata precedence in the generated catalog contract.
		const generated = JSON.parse(
			readFileSync(join(isolatedPackageRoot, "src/providers/data/cloudflare-ai-gateway.json"), "utf8"),
		) as {
			"openai-completions": Record<string, Model<"openai-completions">>;
		};
		const gatewayModels = generated["openai-completions"];
		expect(gatewayModels[`workers-ai/${standaloneOnlyId}`]).toMatchObject({
			id: `workers-ai/${standaloneOnlyId}`,
			name: "Standalone only",
			api: "openai-completions",
			provider: "cloudflare-ai-gateway",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
		});
		expect(gatewayModels[`workers-ai/${overlappingId}`]).toMatchObject({
			name: "Gateway metadata",
			contextWindow: 16384,
			maxTokens: 2048,
		});
	});
});

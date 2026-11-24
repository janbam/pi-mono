import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import type { ModelsDevV2Model } from "../catalog/sources/models-dev.ts";
import { CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } from "../src/api/cloudflare.ts";
import type { Model } from "../src/types.ts";
import { writeUpstreamMock } from "./catalog-generation-utils.ts";

/** A text model as listed by models.dev for Workers AI or its gateway. */
function sourceModel(id: string, name: string, context: number): ModelsDevV2Model {
	return {
		id,
		name,
		type: "chat",
		modalities: { input: ["text"], output: ["text"] },
		capabilities: { tools: { supported: true }, reasoning: { supported: false } },
		limit: { context, output: 2048 },
		api: { "chat-completions": { base_url: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL } },
	};
}

it("mirrors omitted Workers AI models into the gateway and gives directly listed models precedence", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-cloudflare-generation-"));
	const preloadPath = join(root, "mock-catalog.mjs");
	const outputPath = join(root, "catalog");
	const standalone = "@cf/example/standalone-only";
	const overlap = "@cf/example/overlap";
	try {
		// Exercise both the route missing from the gateway and a model with distinct direct metadata.
		writeUpstreamMock(preloadPath, {
			"cloudflare-workers-ai": {
				models: {
					[standalone]: sourceModel(standalone, "Standalone only", 8192),
					[overlap]: sourceModel(overlap, "Standalone metadata", 4096),
				},
			},
			"cloudflare-ai-gateway": {
				models: {
					[`workers-ai/${overlap}`]: sourceModel(`workers-ai/${overlap}`, "Gateway metadata", 16384),
				},
			},
		});
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				pathToFileURL(preloadPath).href,
				"catalog/generate.ts",
				"--strict",
				"--json-only",
				"--json-output",
				outputPath,
			],
			{ cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000 },
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
		const models = JSON.parse(
			readFileSync(join(outputPath, "providers/cloudflare-ai-gateway.json"), "utf8"),
		) as Record<string, Model<"openai-completions">>;
		expect(models[`workers-ai/${standalone}`]).toMatchObject({
			name: "Standalone only",
			api: "openai-completions",
			baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
		});
		expect(models[`workers-ai/${overlap}`]).toMatchObject({ name: "Gateway metadata", contextWindow: 16384 });
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

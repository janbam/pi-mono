import type { Model } from "../../src/types.ts";
import { defineProvider, mergeCompat } from "../define.ts";
import { getOpenCodeGoUsageAdjustedCost } from "../sources/opencode-go.ts";
import { finalizeOpencodeModel, OPENCODE_COMPLETIONS_COMPAT, opencodeModels } from "./opencode.ts";

export default defineProvider({
	id: "opencode-go",
	models: opencodeModels,
	compat: { "openai-completions": OPENCODE_COMPLETIONS_COMPAT },
	finalize: (model, ctx) => {
		finalizeOpencodeModel(model);
		// Keep the z.ai thinking payload on Go's GLM Chat Completions routes.
		if (model.api === "openai-completions" && model.id.startsWith("glm-")) {
			mergeCompat(model as Model<"openai-completions">, { thinkingFormat: "zai", supportsReasoningEffort: true });
		}
		const pricing = ctx.sources.opencodeGoPricing;
		if (!pricing) return;
		// Replace the full cost so no nominal context tiers survive alongside allowance-weighted base rates.
		const row = pricing.get(model.id);
		if (row) model.cost = getOpenCodeGoUsageAdjustedCost(row);
		else console.warn(`OpenCode Go pricing catalog has no row for ${model.id}; keeping models.dev cost`);
	},
});

import { type ChatModel, mergeThinking } from "../define.ts";

/** Match GLM-5.3 and Flash across provider prefixes and batch aliases. */
export function isGlm53ReasoningEffortModelId(modelId: string): boolean {
	return /(?:^|\/)glm-5\.3(?:-flash)?(?::batch)?$/i.test(modelId);
}

/** Keep GLM-5.3 thinking enabled and translate the effort vocabulary supported by each host. */
export function applyGlmFamilyRules(model: ChatModel): void {
	if (!isGlm53ReasoningEffortModelId(model.id)) return;
	// Cloudflare supports low, medium and high, while native GLM accepts low, high and max.
	const cloudflare = model.provider === "cloudflare-workers-ai" || model.provider === "cloudflare-ai-gateway";
	mergeThinking(model, {
		off: null,
		minimal: null,
		low: "low",
		medium: cloudflare ? "medium" : null,
		high: "high",
		xhigh: null,
		max: cloudflare ? null : "max",
	});
}

import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CACHE_WARM_MARKER_TYPE, type CacheWarmMarker } from "../src/core/cache-warmup.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("cache warm marker visibility", () => {
	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps markers invisible in the all-entries tree view and selects their visible ancestor", () => {
		const manager = SessionManager.inMemory("/tmp/cache-warm-visibility-test");
		manager.appendMessage({ role: "user", content: "visible root", timestamp: 1000 });
		const marker: CacheWarmMarker = {
			version: 1,
			api: "anthropic-messages",
			provider: "proxy",
			model: "claude-test",
			cacheIdentity: "identity",
			systemPrompt: { version: 1, baseHash: "base-hash", prefixLength: 4, suffix: "" },
			cacheActive: true,
			retention: "short",
			warmedAt: 1100,
			expiresAt: 301_100,
			warmSince: 1100,
			refreshCount: 1,
			totalCost: 0.001,
		};
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, marker);
		const assistantId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "visible answer" }],
			api: "anthropic-messages",
			provider: "proxy",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1200,
		});
		manager.appendCustomEntry(CACHE_WARM_MARKER_TYPE, { ...marker, warmedAt: 1300 });

		const selector = new TreeSelectorComponent(
			manager.getTree(),
			manager.getLeafId(),
			24,
			() => {},
			() => {},
			undefined,
			undefined,
			"all",
		);
		const rendered = stripVTControlCharacters(selector.render(100).join("\n"));

		expect(rendered).toContain("visible root");
		expect(rendered).toContain("visible answer");
		expect(rendered).not.toContain(CACHE_WARM_MARKER_TYPE);
		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe(assistantId);
	});
});

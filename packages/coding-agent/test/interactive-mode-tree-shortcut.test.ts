import { describe, expect, test, vi } from "vitest";
import type {
	ExtensionShortcut,
	ExtensionShortcutHandler,
	ExtensionShortcutTreeSelection,
} from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const SELECTION: ExtensionShortcutTreeSelection = {
	entryId: "user-1",
	entryType: "message",
	role: "user",
	text: "draft",
};

const CTRL_R = "\x12";

function shortcut(
	contexts: ExtensionShortcut["contexts"],
	handler: ExtensionShortcutHandler = () => undefined,
): ExtensionShortcut {
	return { shortcut: "ctrl+r", contexts, handler, extensionPath: "/tmp/ext.ts" };
}

/** Minimal stand-in for the InteractiveMode fields the tree shortcut path touches. */
function createFakeMode(overrides: Record<string, unknown> = {}) {
	return {
		extensionShortcuts: new Map<string, ExtensionShortcut>(),
		createExtensionShortcutContext: () => ({ ctx: true }),
		treeShortcutInFlight: false,
		sessionManager: { getLeafId: () => "leaf-1" },
		editor: {
			text: "",
			setText(next: string) {
				this.text = next;
			},
			getText() {
				return this.text;
			},
		},
		performTreeNavigation: vi.fn(async () => "navigated"),
		showTreeSelector: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		runTreeExtensionShortcut: (InteractiveMode as any).prototype.runTreeExtensionShortcut,
		...overrides,
	} as any;
}

const dispatch = (mode: any, selection = SELECTION, close = vi.fn()) =>
	(InteractiveMode as any).prototype.dispatchTreeExtensionShortcut.call(mode, CTRL_R, selection, close);

const run = (mode: any, sc: ExtensionShortcut, leafAtDispatch: string | null = "leaf-1") =>
	(InteractiveMode as any).prototype.runTreeExtensionShortcut.call(mode, sc, { ctx: true }, SELECTION, leafAtDispatch);

describe("tree-context extension shortcut dispatch", () => {
	test("claims the key for a tree shortcut and closes the selector first", async () => {
		const handler = vi.fn<ExtensionShortcutHandler>(() => undefined);
		const mode = createFakeMode();
		mode.extensionShortcuts.set("ctrl+r", shortcut(["tree"], handler));
		const close = vi.fn();

		const claimed = dispatch(mode, SELECTION, close);
		await vi.waitFor(() => expect(handler).toHaveBeenCalled());

		expect(claimed).toBe(true);
		// The selector must be gone before the handler opens its own dialogs.
		expect(close).toHaveBeenCalledBefore(handler as never);
		expect(handler.mock.calls[0]?.[1]).toEqual({ context: "tree", selection: SELECTION });
	});

	test("ignores editor-only shortcuts", () => {
		const handler = vi.fn();
		const mode = createFakeMode();
		mode.extensionShortcuts.set("ctrl+r", shortcut(["editor"], handler));

		expect(dispatch(mode)).toBe(false);
		expect(handler).not.toHaveBeenCalled();
	});

	test("refuses a second dispatch while a handler is still running", () => {
		const mode = createFakeMode({ treeShortcutInFlight: true });
		mode.extensionShortcuts.set("ctrl+r", shortcut(["tree"]));

		expect(dispatch(mode)).toBe(false);
	});
});

describe("tree-context extension shortcut results", () => {
	test("navigates and forwards the editor text", async () => {
		const mode = createFakeMode();

		await run(
			mode,
			shortcut(["tree"], () => ({ navigateTo: "user-1", editorText: "rewritten" })),
		);

		expect(mode.performTreeNavigation).toHaveBeenCalledWith("user-1", {
			summarize: false,
			editorText: "rewritten",
		});
	});

	test("applies editor text without navigating when the target is already the leaf", async () => {
		const mode = createFakeMode();

		await run(
			mode,
			shortcut(["tree"], () => ({ navigateTo: "leaf-1", editorText: "rewritten", reopenTree: true })),
		);

		expect(mode.performTreeNavigation).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("rewritten");
		expect(mode.showTreeSelector).toHaveBeenCalledWith(SELECTION.entryId);
	});

	test("drops a stale navigation when the session moved on during the handler", async () => {
		const mode = createFakeMode();

		// leafAtDispatch differs from the current leaf: the user started a new turn meanwhile.
		await run(
			mode,
			shortcut(["tree"], () => ({ navigateTo: "user-1", editorText: "rewritten" })),
			"leaf-0",
		);

		expect(mode.performTreeNavigation).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("");
		expect(mode.showStatus).toHaveBeenCalledWith("Skipped tree navigation: session moved on");
	});

	test("leaves the session untouched when the handler returns nothing", async () => {
		const mode = createFakeMode();

		await run(
			mode,
			shortcut(["tree"], () => undefined),
		);

		expect(mode.performTreeNavigation).not.toHaveBeenCalled();
		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("");
	});

	test("reports a throwing handler without touching the session", async () => {
		const mode = createFakeMode();

		await run(
			mode,
			shortcut(["tree"], () => {
				throw new Error("boom");
			}),
		);

		expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("boom"));
		expect(mode.performTreeNavigation).not.toHaveBeenCalled();
	});
});

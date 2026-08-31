import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("previous prompt");
		expect(modelCycles).toBe(0);

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
	});

	it("keeps raw backspace bytes away from the ctrl+h thinking toggle", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let toggles = 0;
		editor.onAction("app.thinking.toggle", () => {
			toggles++;
		});
		editor.setText("abc");

		// Legacy raw 0x08 is ambiguous (Backspace on many terminals, Ctrl+H in
		// control-byte encoding), so it must stay in the editor's backspace path.
		editor.handleInput("\x08");
		expect(editor.getText()).toBe("ab");
		expect(toggles).toBe(0);

		// Unambiguous Kitty/CSI-u encoding of Ctrl+H fires the app action.
		editor.handleInput("\x1b[104;5u");
		expect(toggles).toBe(1);
		expect(editor.getText()).toBe("ab");
	});
});

/**
 * Tree-context shortcut example.
 *
 * Press ctrl+shift+u while `/tree` is open to uppercase the selected user prompt,
 * navigate the session to that entry, and drop the edited text into the editor.
 *
 * The handler runs before pi navigates, so `ctx.sessionManager` still describes the
 * branch the user was looking at — including the turns after the selected entry.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+shift+u", {
		description: "Shout the selected prompt and branch from it",
		contexts: ["tree"],
		handler: async (ctx, invocation) => {
			if (invocation.context !== "tree") return;

			const { entryId, role, text } = invocation.selection;

			// Only user prompts can be replayed from the editor; reopen the tree otherwise
			// so the user keeps their place instead of being dumped back into the editor.
			if (role !== "user" || !text) {
				ctx.ui.notify("Select a user message", "warning");
				return { reopenTree: true };
			}

			// Report what the pre-navigation branch looked like: this is the window an
			// extension has for reading later turns before they leave the active branch.
			const branchLength = ctx.sessionManager.getBranch().length;
			ctx.ui.notify(`Branch had ${branchLength} entries before navigating`, "info");

			return { navigateTo: entryId, editorText: text.toUpperCase() };
		},
	});
}

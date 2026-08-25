# Fork Modifications

Deliberate behavioral divergences of this fork (`yannbam/pi-mono`) from upstream. Each entry records what changed, why, and where the change lives.

## /tree: Enter navigates directly, tab opens the summary menu

Upstream behavior: confirming a navigation target in `/tree` always prompts "Summarize branch?" (No summary / Summarize / Summarize with custom prompt) unless the `branchSummary.skipPrompt` setting suppresses it.

Fork behavior:

- `enter` on a tree entry navigates there immediately, no prompt, no summary.
- `tab` navigates and opens the summary menu. Escape in the menu returns to the tree with the previous selection; the custom-prompt retry loop is unchanged.

`tab` was chosen over a modified-Enter chord because it is delivered by every terminal as a plain byte (`\t`) with no Kitty-protocol requirement.

Implementation:

- New keybinding `app.tree.confirmSummaryMenu`, default `tab`: `packages/coding-agent/src/core/keybindings.ts`
- `TreeList.onSelect(entryId, showSummaryMenu)`: `packages/coding-agent/src/modes/interactive/components/tree-selector.ts` (plain confirm passes `false`, the summary-menu binding passes `true`)
- Menu gating in the tree navigation callback: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (`showTreeSelector`)
- Regression tests: `packages/coding-agent/test/tree-selector.test.ts`
- User docs: `packages/coding-agent/docs/keybindings.md`, `docs/sessions.md`, `docs/settings.md`

Consequence: the `branchSummary.skipPrompt` setting has no consumer anymore and is marked obsolete in the settings docs.

## Keybinding experiments that were reverted

An attempt to move the follow-up queueing keybinding (`app.message.followUp`) from `alt+enter` to the four-modifier chord `ctrl+alt+super+a` (emitted by a keyd remap of physical `Alt+Enter`) was reverted: the chord never reliably reached pi. Tested both without tmux and with Kitty-protocol passthrough enabled, so tmux is ruled out as the cause — the loss is in keyd's emitted events or the terminal's encoding of the chord, unresolved. `app.message.followUp` remains at the upstream default `alt+enter` and the keyd remap is unused.

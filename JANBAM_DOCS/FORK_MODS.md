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

## Extension shortcuts can be dispatched from the `/tree` selector

Upstream behavior: extension shortcuts registered with `pi.registerShortcut()` are wired only into the default editor (`defaultEditor.onExtensionShortcut`), so they never fire while a picker such as `/tree` owns the input. Extensions also have no way to read which tree node is selected.

Fork behavior: `pi.registerShortcut(key, { contexts: ["editor", "tree"], handler })`. `contexts` defaults to `["editor"]`, so existing extensions are unaffected. A `tree` shortcut receives keys the tree selector's own keybindings declined, before they would become type-to-search input. Pi closes the selector, runs the handler with the selected entry (`entryId`, `entryType`, `role`, `text`) while the session is still on the branch the user was looking at, and then applies the handler's returned `{ navigateTo?, editorText?, reopenTree? }`.

The pre-navigation ordering is the point of the feature: an extension can read the later turns of the current thread (via `ctx.sessionManager`) before navigation truncates the active branch, then ask pi to branch at the selected entry with rewritten prompt text.

Guards: only one tree handler runs at a time, and a navigation whose dispatch-time leaf no longer matches the current leaf is dropped instead of truncating a branch the user extended meanwhile.

Implementation:

- Types (`ExtensionShortcutContext`, `ExtensionShortcutTreeSelection`, `ExtensionShortcutInvocation`, `ExtensionShortcutResult`, `ExtensionShortcutHandler`) and the `registerShortcut` signature: `packages/coding-agent/src/core/extensions/types.ts`, exported via `src/core/extensions/index.ts` and `src/index.ts`
- `contexts` default: `packages/coding-agent/src/core/extensions/loader.ts`
- Selector hook `TreeSelectorComponent.onExtensionShortcut`: `packages/coding-agent/src/modes/interactive/components/tree-selector.ts`
- Dispatch, result application, and the extracted `performTreeNavigation` shared with the normal confirm path: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Tests: `packages/coding-agent/test/tree-selector.test.ts`, `test/interactive-mode-tree-shortcut.test.ts`, `test/extensions-runner.test.ts`
- Docs and example: `packages/coding-agent/docs/extensions.md`, `packages/coding-agent/examples/extensions/tree-shortcut.ts`

Note: shortcut keys are still validated against built-in *editor* keybindings, so keys reserved there (`ctrl+c`, `ctrl+g`, ...) are rejected even for tree-only shortcuts.

## Extensions can make model-aware one-off requests

Upstream behavior: extensions can make one-off requests through `ctx.modelRegistry.complete()`, but that API accepts provider-specific options. An extension holding a Pi thinking level must translate it into each provider's wire format and separately account for models that cannot honor the requested level.

Fork behavior: `ctx.modelRegistry.completeSimple()` accepts provider-neutral options, including the complete Pi thinking vocabulary (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The Models boundary clamps the requested level against model metadata before the provider adapter encodes it. Omitted reasoning means `off`; an always-thinking model receives its lowest supported level instead.

The same normalization applies to the public Pi compatibility API and Models implementation, so the TUI, CLI, and extensions share one policy boundary. Raw API-specific requests remain unchanged for callers that deliberately own provider payload semantics.

Implementation:

- Model-aware options and shared normalization: `packages/ai/src/types.ts`, `packages/ai/src/models.ts`
- Compatibility entry point: `packages/ai/src/compat.ts`
- Extension runtime and facade: `packages/coding-agent/src/core/model-runtime.ts`, `packages/coding-agent/src/core/model-registry.ts`
- Extension docs: `packages/coding-agent/docs/extensions.md`
- Regression coverage: `packages/ai/test/models-simple-reasoning.test.ts`, `packages/ai/test/openai-completions-tool-choice.test.ts`, `packages/ai/test/zai-coding-plan-models.test.ts`, `packages/coding-agent/test/model-runtime-auth-options.test.ts`

## Keybinding experiments that were reverted

An attempt to move the follow-up queueing keybinding (`app.message.followUp`) from `alt+enter` to the four-modifier chord `ctrl+alt+super+a` (emitted by a keyd remap of physical `Alt+Enter`) was reverted: the chord never reliably reached pi. Tested both without tmux and with Kitty-protocol passthrough enabled, so tmux is ruled out as the cause — the loss is in keyd's emitted events or the terminal's encoding of the chord, unresolved. `app.message.followUp` remains at the upstream default `alt+enter` and the keyd remap is unused.

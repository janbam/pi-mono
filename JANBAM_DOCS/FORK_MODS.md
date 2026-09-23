# Fork Modifications

Deliberate behavioral divergences of this fork (`janbam/pi-mono`) from upstream. Each entry records what changed, why, and where the change lives.

## Extensions can persist session-global state outside the conversation tree

Upstream behavior: `CustomEntry` persists branch-local extension data in the conversation tree. Upstream's `SessionManager.inMemory(..., entries)` can restore a complete externally stored session; it is a loading mechanism, not another state record.

Fork behavior: extensions can read and write durable JSON values through `pi.getSessionState(key)` and `pi.setSessionState(key, value)`. Keys share one open last-write-wins namespace with no ownership restrictions. State records are append-only session metadata outside the conversation tree, transcript, compaction input, and model context, so `/tree` never rolls them back.

Record roles:

- `SessionHeader`: one `type: "session"` record with `id`, `version`, and `cwd`; owns session identity.
- `SessionStateEntry`: `type: "session"` plus `sessionState`, without `id`/`parentId`; owns fork-global extension values. Loaders must distinguish it from the header by shape, not by `type` alone.
- `CustomEntry`: `type: "custom"` with `id`/`parentId`; owns branch-local extension data and follows tree navigation.

Lifecycle semantics:

- Resume, reload, switch, and import replay state in physical file order.
- New sessions start empty.
- Forks, clones, and branch JSONL exports inherit one effective snapshot per key. Outgoing `session_shutdown` writes remain source-only because derivation occurs before shutdown.
- Validation or persistence failure leaves the last durable value unchanged; non-finite numbers are rejected recursively.
- State uses a `type: "session"` metadata envelope so older version 3 readers skip it instead of misclassifying it as a tree entry. Temporary flat `session_state` records are normalized on load.

Implementation:

- Storage, replay, compatibility normalization, derivation, and public data types: `packages/coding-agent/src/core/session-manager.ts`, `src/core/session-export.ts`
- Runtime lifecycle ordering: `packages/coding-agent/src/core/agent-session-runtime.ts`
- Extension API and bindings: `packages/coding-agent/src/core/extensions/`, `src/core/agent-session.ts`, `src/index.ts`
- Tests: `packages/coding-agent/test/session-manager/session-state.test.ts`, `test/extensions-runner.test.ts`, `test/suite/agent-session-runtime.test.ts`
- Docs and example: `packages/coding-agent/docs/extensions.md`, `docs/session-format.md`, `docs/sessions.md`, `examples/extensions/session-state.ts`

## OpenCode Go model costs come from the Go pricing page, scaled by usage allowance

Upstream behavior: opencode-go model costs are models.dev's nominal per-1M prices (which also drop the page's context-tier and Peak/Off-Peak rows, and can lag the docs page).

Fork behavior: during model generation, the generator fetches https://opencode.ai/docs/go/, locates the pricing table by its header row (Model / Input / Output / Cached Read / Cached Write / Usage — the only table on the page with those columns, with header names driving per-row column indexing; headers are matched through a canonical-name alias table, e.g. the page's Sep 2026 rewording "Usage" → "Monthly limit" and "Cached Read/Write" → "Cache Read/Write" stay compatible, while unknown wordings still fail the build). It also parses the page's endpoints table (Model / Model ID / Endpoint / AI SDK Package) as the authoritative display-name → model-id mapping and keys every pricing row by that model id, so models.dev entries match by exact id — display names can diverge from ids (the pricing row "DeepSeek V4.1 Flash" is served as model id `deepseek-flash`, which name normalization alone cannot join). It then replaces every opencode-go cost with the page's base-row prices (plain, "≤ N tokens", or Off-Peak — Peak rows are dropped since the catalog schema has one cost per model) scaled by `60 / usage-allowance`. The multiplier normalizes per-token cost to how fast a model drains its monthly allowance: $60-usage models keep the nominal price, $30-usage models double, $15-usage models quadruple (e.g. grok-4.6 input $2 → $8, GLM-5.3 $1.40 → $5.60). The usage column is authoritative for every model — per-model annotations elsewhere (e.g. models.dev's "(2x usage)" naming for GLM-5.3-Flash) are deliberately ignored, no special cases. Promo and price-change cells decode generically: struck-through (`<del>`/`<s>`) values are dropped as superseded, the leading standalone number wins over trailing annotations ("$60 4x · Ends Sep 20" → 60, while digit-fused junk like "4x" still fails the build), and word cells "Free"/"Unlimited" mean zero marginal cost, with an "Unlimited" monthly limit scaling the model's prices to 0 for the promo's duration (e.g. Union Alpha Free, Sep 2026).

Scope and guards:

- Only the `opencode-go` provider; `opencode` (Zen) keeps models.dev costs.
- A registered model with no page row keeps its models.dev cost (warned in generator output) so the catalog never loses a model over pricing.
- Strict generator runs fail the build if the page is unreachable or the table cannot be found/parsed; non-strict runs fall back to models.dev costs.
- The pricing fetch only happens when the models.dev catalog actually lists opencode-go models, so fetch-mocked generator tests never see it.

Implementation:

- Pure parser, name normalizer, and usage-scaling cost helper: `packages/ai/scripts/opencode-go-pricing.ts`
- Fetch + override wiring in the OpenCode variant loop: `packages/ai/scripts/generate-models.ts` (`fetchOpenCodeGoPricing`, `opencodeGoPricing`, `goPricingRow`)
- Tests: `packages/ai/test/opencode-go-pricing.test.ts` (parser units, cost scaling, strict generator integration with mocked fetches)

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

## Thinking keybindings rebound; backward cycling added

Upstream behavior: `app.thinking.cycle` is `shift+tab`, `app.thinking.toggle` is `ctrl+t`, and thinking level cycling is forward-only.

Fork behavior: `app.thinking.toggle` is `ctrl+h`, `app.thinking.cycle` is `ctrl+t`, and the new `app.thinking.cycleBackward` (default `ctrl+alt+t`) steps down the available level list. `AgentSession.cycleThinkingLevel(direction?)` and RPC `cycle_thinking_level` / `RpcClient.cycleThinkingLevel(direction?)` accept an optional direction; omitted direction cycles forward.

`ctrl+alt+t` was chosen over `ctrl+shift+t` because the legacy encoding (ESC prefix + control byte) distinguishes Ctrl+Alt+T from plain Ctrl+T in every terminal, while Ctrl+Shift+T is indistinguishable from Ctrl+T without the Kitty keyboard protocol (see the reverted keybinding experiment below for a related failure).

Implementation:

- Defaults and action id: `packages/coding-agent/src/core/keybindings.ts`
- Direction-aware cycling: `packages/coding-agent/src/core/agent-session.ts`
- Interactive dispatch, startup hints, help overlay: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Extension conflict allowlist: `packages/coding-agent/src/core/extensions/runner.ts`
- RPC command and client: `packages/coding-agent/src/modes/rpc/rpc-types.ts`, `rpc-client.ts`, `rpc-mode.ts`
- Tests: `packages/coding-agent/test/keybindings.test.ts`, `test/suite/agent-session-model-extension.test.ts`, `test/rpc-prompt-response-semantics.test.ts`, `test/rpc.test.ts`
- Docs: `packages/coding-agent/docs/keybindings.md`, `docs/quickstart.md`, `docs/rpc.md`, `README.md`, `CHANGELOG.md`

## Prompt-cache warming: fork policy on upstream's `CacheWarmer`

Upstream behavior: `cacheWarming` defaults to `streaming`. `CacheWarmer` replays the last captured request with a one-token cap at 90% of the TTL, only while the $0.05 expected-savings floor holds, for at most 60 min (running) or 30 min (idle), and only for requests captured in the current process. Failed refreshes are rescheduled silently; the miss cost uses the 5-minute write rate even for 1-hour entries.

Fork behavior:

- `cacheWarming` defaults to `off`.
- `-kw` / `--keep-cache-warm` and `/warm [on|off]` set a process-only override (never persisted, survives `/resume` and `/new`). Effective mode `on` = warm while running and idle without the savings floor; economics are still computed for `/session`, and `cache_warming_decision` extensions can still stop it. Bare `/warm` reports the state.
- One age cap for both phases: `cacheWarmingMaxAgeMinutes` (default 60, `/settings` number field), counted from the last real request.
- Refresh 10 s before expiry, scheduled from the dispatch time of the last real request or refresh; the late-timer guard keeps half the margin (5 s).
- Every `anthropic-messages` model refreshes with `max_tokens: 0` (documented pre-warm, no output billed), including proxies: only models with a declared `promptCache` are warmed, and a proxy rejecting the pre-warm fails the refresh visibly. The adapter sends `maxTokens: 0` requests non-streaming without server-side fallbacks and reads the JSON `BetaMessage`. Other APIs keep the one-token replay.
- A refresh counts only with `usage.cacheRead > 0`; a refresh without a read, or a failed refresh, stops warming with `status.failed`.
- Miss cost for `long` retention prices the rewrite at the 1-hour rate (`cacheWrite1h`).
- Indicator above the editor while the effective mode is not `off`: held-warm time since the last real request, refresh count, maintenance cost, stop reason; warning border on failure. 1 s ticker.
- Resume: after `bindExtensions` (session resume, `/fork`) and when idle warming is enabled (immediately while idle, at settlement when enabled mid-run), `CacheWarmer.restore()` rebuilds the transcript's last request (projection before the last assistant message, `context` hooks, `convertToLlm`, agent request options) and derives the lease from the last assistant timestamp and later `cache_warm` entries. No custom markers. Compaction, branch summaries, and context edits after that request, a model change, or an expired entry prevent the restore.

Merge note: fork request options carry the unresolved Pi thinking level (`ModelsSimpleStreamOptions`, see model-aware requests above), so `CacheWarmer`'s helpers accept that type and `isReplayable` judges the clamped level. The constructor takes a policy getter (`{ mode, maxAgeMs }`) instead of upstream's mode getter, plus an optional request-rebuild function.

Implementation:

- Policy, scheduling, restore: `packages/coding-agent/src/core/cache-warmer.ts`
- Override holder, policy getter, request rebuild: `packages/coding-agent/src/core/sdk.ts`, `src/core/agent-session-services.ts`, `src/main.ts`; `-kw`: `src/cli/args.ts`
- Session API (`setCacheWarmingOverride`, `cacheWarmingMode`, restore triggers): `packages/coding-agent/src/core/agent-session.ts`
- Settings: `packages/coding-agent/src/core/settings-manager.ts`, `src/modes/interactive/components/settings-selector.ts`
- `/warm`, `/session`, indicator: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `components/cache-warming-indicator.ts`, `chat-viewport.ts`, `src/core/slash-commands.ts`
- `max_tokens: 0` pre-warm: `packages/ai/src/api/anthropic-messages.ts`
- Tests: `packages/coding-agent/test/cache-warmer.test.ts`, `test/sdk-stream-options.test.ts`, `test/settings-manager.test.ts`, `test/args.test.ts`, `packages/ai/test/anthropic-cache-prewarm.test.ts`
- Docs: `packages/coding-agent/docs/settings.md`, `docs/usage.md`, `README.md`

## Escape pauses the run at the next turn boundary

Upstream behavior: Escape while streaming aborts the stream and running tools immediately.

Fork behavior: `app.turn.pause` (default `escape`) arms a pause. The run finishes its current tool batch, persists the tool results, and holds before the next LLM request. Pressing Escape again before the hold lands cancels it. While held, the editor border is bright red; typing a message continues the run with that message, and `app.turn.resume` (default `escape`) continues without injecting anything. Messages typed while the pause drains are parked and sent serially after it lands. The flush is scheduled after the `agent_settled` dispatch (a `prompt()` issued inside it is deferred and could not be awaited or caught); messages stay parked while another run owns the session, and a failed send re-parks the rest. A triggered extension turn (`sendCustomMessage` with `triggerTurn`) supersedes a held pause like a new prompt. `app.interrupt` (defaults `ctrl+escape`, `ctrl+\`) keeps the old hard-abort behavior and discards a held pause with a persisted "Operation aborted" marker. A text-only final turn or a tool batch whose results all set `terminate: true` ends normally instead of holding, because resuming would issue a request the run was never going to make. A held run keeps its per-run system prompt (`before_agent_start` result) for the resume; discarding the hold (new prompt, abort, `abortPausedTurn`, tree navigation) clears it.

Implementation:

- Pause state, `requestPause()`, `resumePaused()`, `abortPausedTurn()`: `packages/coding-agent/src/core/agent-session.ts`. The hold is a `finishTurn` hook returning `{ action: "end" }`, installed after upstream's boundary hooks so extension `turn_end` drafts still persist. A held run skips post-run recovery and `agent_before_settle`; resume runs the staged post-run pass, one `continue()`, then the shared settle loop (`_settleAgentRun`).
- Keybindings: `packages/coding-agent/src/core/keybindings.ts`; `ctrl+escape` key matching: `packages/tui/src/keys.ts`
- Interactive dispatch, parked messages, red border: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Tests: `packages/coding-agent/test/suite/agent-session-pause.test.ts`, `test/interactive-mode-pause-flush.test.ts`

Merge note: v0.87.0 removed `shouldStopAfterTurn`, which the pause originally used; it now chains on `finishTurn`.

## Fork system prompt

Upstream behavior: the default prompt starts with the pi-harness introduction, includes a pi documentation routing section, and says "Be concise in your responses". An empty `--system-prompt ""` falls back to the default prompt.

Fork behavior: the preamble is "You are the top senior software engineer and system architecture designer.", the conciseness rule is stricter (high-signal, no preambles or hedging, ask about ambiguities), and the pi documentation section is omitted. An explicit empty custom prompt is a valid empty base prompt; only `undefined` selects the default. `--append-system-prompt ""` likewise disables appended prompts, replacing `APPEND_SYSTEM.md` discovery.

Implementation: `packages/coding-agent/src/core/system-prompt.ts` (`buildSystemPromptSections`, `buildRules`), `src/core/resource-loader.ts`, `src/cli/args.ts`.

Tests adjusted for the fork prompt: `packages/coding-agent/test/system-prompt.test.ts`, `test/system-prompt-updates.test.ts`, `test/suite/agent-session-boundaries.test.ts` (replacement text sized to cross the compaction threshold without the docs section), and `packages/evals/test/harness.test.ts` (docs-stripping variant tests skipped because the section does not exist). Consequence: upstream's docs eval runner (`packages/evals`, both `with_docs` and `without_docs` variants) does not work in the fork.

## Triggered runs keep extension prompt sections

Upstream behavior: runs started by `pi.sendMessage(..., { triggerTurn: true })` skip `before_agent_start`, so they have no per-run prompt options. The next-turn refresh after the first response rebuilds the prompt from base options and diffs it against the transcript. Every extension section set by an earlier `before_agent_start` (for example `sections.telegraph`) is patched away with `section: null`, and the next prompt adds it back. On providers without mid-conversation system messages, each patch rewrites the collapsed system head, so both requests miss the prompt cache.

Fork behavior: when a run has no per-run options, the refresh seeds `sections` with the extension-owned sections the model currently has, recovered from the transcript. Built-in sections (`preamble`, `tools`, `rules`, `addendum`, `project_context`, `skills`, `cwd`) are still rebuilt from live state, including when an extension overrode one of those names through `sections`. Such an override is not kept in triggered runs; the extension docs tell authors to use their own names. Only a `before_agent_start` pass may change or remove an extension section. Sections with invalid names or text that is not the builder's `<name>\n...\n</name>` wrapping cannot be rebuilt byte-identically and are dropped as before.

Implementation:

- Section recovery: `packages/coding-agent/src/core/system-prompt.ts` (`extensionSectionsFromTranscript`)
- Seeding in the next-turn refresh: `packages/coding-agent/src/core/agent-session.ts` (`_installAgentNextTurnRefresh`)
- Tests: `packages/coding-agent/test/system-prompt-updates.test.ts`
- Extension docs: `packages/coding-agent/docs/extensions.md` (section lifecycle paragraph under Events and concurrency)

## Direct registered-tool execution

Fork behavior: `AgentSession.executeTool()` for SDK hosts, `pi.executeTool()` for extensions, and RPC commands `get_all_tools` / `execute_tool` run a registered tool by name without starting an agent turn or appending a tool-result message. Argument preparation, schema validation, `tool_call` blocking, `tool_result` mutation, and lifecycle events behave as for model-requested calls.

Implementation: `packages/coding-agent/src/core/agent-session.ts`, `src/core/extensions/types.ts`, `src/modes/rpc/`. Tests: `test/suite/agent-session-execute-tool.test.ts`, `test/rpc-direct-tool-execution.test.ts`.

## Smaller fork additions

- `--log-api-requests <file>` writes every outgoing provider request (URL, method, redacted headers, body, status, duration) as JSONL. Amazon Bedrock's node:http transport is not covered. `packages/coding-agent/src/core/api-request-logging.ts`, test `test/api-request-logging.test.ts`.
- `/export <file>.md` exports the visible conversation as Markdown with thinking omitted and tools rendered like interactive mode. `packages/coding-agent/src/core/session-export.ts` (`exportSessionToMarkdown`), `AgentSession.exportToMarkdown()`, test `test/export-markdown.test.ts`.
- Interactive mode prints a turn-usage line (uncached input, output, cache read, cache write, cost) after every foreground run, including tool-reported usage and excluding compaction. `interactive-mode.ts` (`showTurnUsage`), test `test/interactive-mode-turn-usage.test.ts`.
- Shift+Enter under tmux: `matchesKey`/`parseKey` treat legacy `\x1b\r` and `\n` as shift+enter regardless of Kitty protocol state (upstream only does so while Kitty is active and otherwise reads `\x1b\r` as alt+enter and `\n` as enter). `packages/tui/src/keys.ts`.
- `packages/pless`: a Markdown pager CLI on the pi-tui renderer. It must carry the lockstep workspace version and matching `@earendil-works/*` ranges, or npm installs a nested published copy.

## Fullscreen mouse-wheel scrolling has a configurable step

Upstream behavior: each mouse-wheel event moves the fullscreen transcript by one logical line, or five lines while Alt is held.

Fork behavior: `fullscreenWheelScrollLines` controls the normal wheel step and defaults to 1. `/settings` accepts a free-form number instead of a preset list; persisted values are rounded down and clamped to at least 1. Alt-wheel always moves one line for precision. Changes apply immediately to an active fullscreen renderer and also when switching into fullscreen mode.

Implementation:

- Settings persistence and `/settings` input: `packages/coding-agent/src/core/settings-manager.ts`, `src/modes/interactive/components/settings-selector.ts`, `src/modes/interactive/interactive-mode.ts`
- Fullscreen renderer behavior and wiring: `packages/tui/src/tui-alt-screen.ts`, `packages/coding-agent/src/modes/interactive/tui-renderer.ts`
- Tests: `packages/tui/test/tui-alt-screen.test.ts`, `packages/coding-agent/test/settings-manager.test.ts`, `test/settings-selector.test.ts`, `test/interactive-tui.test.ts`
- User documentation: `packages/coding-agent/docs/settings.md`

## Keybinding experiments that were reverted

An attempt to move the follow-up queueing keybinding (`app.message.followUp`) from `alt+enter` to the four-modifier chord `ctrl+alt+super+a` (emitted by a keyd remap of physical `Alt+Enter`) was reverted: the chord never reliably reached pi. Tested both without tmux and with Kitty-protocol passthrough enabled, so tmux is ruled out as the cause — the loss is in keyd's emitted events or the terminal's encoding of the chord, unresolved. `app.message.followUp` remains at the upstream default `alt+enter` and the keyd remap is unused.

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

## Prompt-cache maintenance keeps Anthropic caches warm between turns

Upstream behavior: a cache lease can only be established or refreshed by a foreground turn; idle gaps let Anthropic's 5-minute / 1-hour cache entries expire.

Fork behavior: the ai package exposes `promptCacheWarmup` plus `promptCacheWarmupExpiresAt` on Anthropic Messages requests. The coding agent's cache-warming scheduler (`--keep-cache-warm` / `-kw`, `/warm`) sends non-streaming maintenance requests that hit the same cache prefix without producing visible output. `promptCacheWarmup` requests are zero-token (`max_tokens: 0`), except budget-thinking models which get the one-token answer allowance Anthropic requires; a scheduler-side lease deadline is enforced before dispatch and a missed deadline is encoded as `aborted`.

The request must be cache-compatible with the real continuation, so three invariants hold:

- The conversation cache breakpoint sits on the prefix shared with the real continuation: before the synthetic final dot, or on the unresolved tool-use block whose tool result is still missing.
- Payload hooks (`onPayload`) may change the body, but `max_tokens`, `thinking`, and `output_config` are restored from the pre-hook request and the stream flag is forced back to `false`; a hook can never turn a warmup into a streaming generation.
- Server-side model fallbacks are skipped for warmups so a fallback model cannot absorb a cache refresh attributed to the requested model.

Implementation:

- Warmup request shaping, breakpoint placement, hook invariants, and non-streaming response handling: `packages/ai/src/api/anthropic-messages.ts` (`capturePromptCacheWarmupInvariants`, `applyPromptCacheWarmupInvariants`, `applyConversationCacheControl`, `isPromptCacheWarmupExpired`)
- Public options: `packages/ai/src/types.ts`
- Scheduler, lease lifetime, marker replay, and maintenance accounting: `packages/coding-agent/src/core/cache-warmup.ts`
- Foreground request provenance, provider-work draining, UI state, and pause integration: `packages/coding-agent/src/core/agent-session.ts`, `src/modes/interactive/interactive-mode.ts`
- Tests: `packages/ai/test/anthropic-cache-warmup.test.ts`, `packages/ai/test/anthropic-sse-parsing.test.ts`, `packages/coding-agent/test/cache-warmup.test.ts`, `test/agent-session-cache-warmup.test.ts`, `test/interactive-mode-turn-usage.test.ts`

Merge note: upstream moved the Anthropic adapter to the beta Messages API (`client.beta.messages.create`). Warmups must dispatch through the same beta client and read the non-streaming `BetaMessage` body for usage and stop reason; fork tests inject fake clients under `beta.messages.create`. Anthropic may resolve a requested model alias to a concrete serving model, so `AssistantMessage.model` remains the request identity while `responseModel` records the serving model; otherwise the foreground cache proof would be rejected as belonging to a different request.

## Keybinding experiments that were reverted

An attempt to move the follow-up queueing keybinding (`app.message.followUp`) from `alt+enter` to the four-modifier chord `ctrl+alt+super+a` (emitted by a keyd remap of physical `Alt+Enter`) was reverted: the chord never reliably reached pi. Tested both without tmux and with Kitty-protocol passthrough enabled, so tmux is ruled out as the cause — the loss is in keyd's emitted events or the terminal's encoding of the chord, unresolved. `app.message.followUp` remains at the upstream default `alt+enter` and the keyd remap is unused.

# Prompt Caching in the ai Package

This document describes how the `ai` package decides prompt cache points, how
each provider adapter implements them, and how the behavior differs for
open-weight model hosts.

## Core Prompt Caching Behavior

Pi uses a common three-level preference, then each provider adapter maps it to
its own API fields.

### Decision

The shared preference is `CacheRetention = "none" | "short" | "long"`. The
default is `"short"`. The legacy environment variable `PI_CACHE_RETENTION=long`
only overrides an unset value. `"none"` disables prompt caching. See
[types.ts:104](../packages/ai/src/types.ts#L104) and
[types.ts:200](../packages/ai/src/types.ts#L200).

Each adapter has a `resolveCacheRetention()` function with the same policy.
Examples are
[anthropic-messages.ts:50](../packages/ai/src/api/anthropic-messages.ts#L50) and
[openai-completions.ts:191](../packages/ai/src/api/openai-completions.ts#L191).

The coding agent passes the session ID into every request but does not normally
set `cacheRetention`, so the provider default `"short"` applies. Compaction
explicitly sets `"none"` because its summary call must not become a cache
prefix. See [sdk.ts:352](../packages/coding-agent/src/core/sdk.ts#L352) and
[compaction.ts:573](../packages/coding-agent/src/core/compaction/compaction.ts#L573).

### Per Provider

Native Anthropic in
[anthropic-messages.ts](../packages/ai/src/api/anthropic-messages.ts):

- `getCacheControl()` builds `{ type: "ephemeral", ttl? }` at
  [line 60](../packages/ai/src/api/anthropic-messages.ts#L60).
- `buildParams()` puts `cache_control` on the system prompt, the last tool
  definition, and the last user message. See
  [line 957](../packages/ai/src/api/anthropic-messages.ts#L957) and
  [line 1274](../packages/ai/src/api/anthropic-messages.ts#L1274).
- A marker is a cache breakpoint. The provider caches everything before it.

OpenAI Completions in
[openai-completions.ts](../packages/ai/src/api/openai-completions.ts):

- Native OpenAI does not use block markers. It sends `prompt_cache_key` and, for
  `"long"`, `prompt_cache_retention: "24h"`. See
  [line 682](../packages/ai/src/api/openai-completions.ts#L682).
- OpenRouter Anthropic models use the Anthropic marker style. The same code
  adds `cache_control` to the system prompt, last tool, and last conversation
  text block. See
  [line 931](../packages/ai/src/api/openai-completions.ts#L931).
- The prompt cache key is clamped to 64 characters in
  [openai-prompt-cache.ts](../packages/ai/src/api/openai-prompt-cache.ts).

OpenAI Responses in
[openai-responses.ts](../packages/ai/src/api/openai-responses.ts):

- It sends `prompt_cache_key` when caching is enabled. It sends
  `prompt_cache_retention: "24h"` only for `"long"`. See
  [line 284](../packages/ai/src/api/openai-responses.ts#L284).
- For models that support explicit mode, it can send
  `prompt_cache_options: { mode: "explicit" }` when caching is `"none"` to
  disable implicit caching.

OpenAI Codex Responses in
[openai-codex-responses.ts](../packages/ai/src/api/openai-codex-responses.ts):

- It sends only `prompt_cache_key`, no retention field. See
  [line 554](../packages/ai/src/api/openai-codex-responses.ts#L554).
- In `websocket-cached` or `auto` transport, it reuses a websocket and sends
  only new input with `previous_response_id`. See
  [line 1420](../packages/ai/src/api/openai-codex-responses.ts#L1420).

Bedrock Converse in
[bedrock-converse-stream.ts](../packages/ai/src/api/bedrock-converse-stream.ts):

- It appends `cachePoint` blocks to the system prompt and last user message.
  See
  [line 780](../packages/ai/src/api/bedrock-converse-stream.ts#L780) and
  [line 981](../packages/ai/src/api/bedrock-converse-stream.ts#L981).
- It only does this for recognized Claude models or when
  `AWS_BEDROCK_FORCE_CACHE=1`. See
  [line 737](../packages/ai/src/api/bedrock-converse-stream.ts#L737).

Mistral in
[mistral-conversations.ts](../packages/ai/src/api/mistral-conversations.ts):

- It sends `prompt_cache_key` when caching is enabled and a session ID exists.
  See [line 516](../packages/ai/src/api/mistral-conversations.ts#L516).

Google does not set explicit cache points in pi. It reads
`cachedContentTokenCount` from usage for cost reporting.

### TTL Knowledge

Pi does not have a central provider TTL table. Each adapter hard-codes the
provider-specific mapping:

- Anthropic: `"long"` becomes `ttl: "1h"`.
- OpenAI Completions and Responses: `"long"` becomes `"24h"`.
- Bedrock: `"long"` becomes `CacheTTL.ONE_HOUR`.
- Mistral and OpenAI Codex: no explicit TTL is sent.

Model metadata can disable long retention with `supportsLongCacheRetention:
false`. Fireworks is one example. See
[types.ts:638](../packages/ai/src/types.ts#L638).

### Anthropic 5 Minute and 1 Hour

Yes. Pi distinguishes the two values in
[anthropic-messages.ts:60](../packages/ai/src/api/anthropic-messages.ts#L60):

- `"short"` sends `cache_control: { type: "ephemeral" }` without a TTL. The
  Anthropic server then applies its default 5 minute cache lifetime.
- `"long"` sends `cache_control: { type: "ephemeral", ttl: "1h" }` when the
  model supports long retention.
- `"none"` sends no cache marker.
- If a model sets `supportsLongCacheRetention: false`, `"long"` degrades to the
  same no-TTL ephemeral marker as `"short"`.

## Open-Weight Providers

There is no separate open-weight policy. Pi decides caching by API adapter and
provider compatibility, not by whether the model weights are open.

### Main Path

Most open-weight hosts use the OpenAI Completions adapter: Together, Fireworks,
Baseten, NVIDIA, Groq, DeepSeek, Moonshot, Qwen, Hugging Face, Vercel AI
Gateway, and OpenRouter.

For these providers,
[buildParams()](../packages/ai/src/api/openai-completions.ts#L682) sends
`prompt_cache_key` only in two cases:

- The base URL is `api.openai.com` and retention is not `"none"`.
- Retention is `"long"` and the provider supports long retention.

The default retention is `"short"`. For a non-OpenAI open-weight host, that
means the default request contains no `prompt_cache_key`, no
`prompt_cache_retention`, and no `cache_control` markers. The provider may still
cache automatically, but pi does not request it explicitly.

### Disabled Long Retention

Several open-weight providers have `supportsLongCacheRetention: false`. For
them, even `"long"` sends no prompt cache key or retention.

- Together:
  [generate-models.ts:152](../packages/ai/scripts/generate-models.ts#L152)
- NVIDIA:
  [generate-models.ts:209](../packages/ai/scripts/generate-models.ts#L209)
- Baseten:
  [generate-models.ts:1136](../packages/ai/scripts/generate-models.ts#L1136)
- Fireworks OpenAI path:
  [generate-models.ts:1243](../packages/ai/scripts/generate-models.ts#L1243)
- Cloudflare Workers AI and Cloudflare AI Gateway:
  [openai-completions.ts:1530](../packages/ai/src/api/openai-completions.ts#L1530)
- Ant Ling:
  [generate-models.ts:2487](../packages/ai/scripts/generate-models.ts#L2487)
- xAI Responses:
  [generate-models.ts:426](../packages/ai/scripts/generate-models.ts#L426)

Other OpenAI-style hosts such as Groq, DeepSeek, Moonshot, Qwen, and Hugging
Face do not set this flag to false. When retention is `"long"`, pi sends them
`prompt_cache_key` and `prompt_cache_retention: "24h"`. Whether each upstream
accepts those fields is provider-dependent.

### Anthropic-Style Exceptions

Fireworks serves many open-weight models through its Anthropic-compatible API.
Pi applies Anthropic-style `cache_control` markers to the system prompt and last
user message, but it deliberately omits tool markers and long TTL. Fireworks
also gets session-affinity headers for replica routing. See
[generate-models.ts:1232](../packages/ai/scripts/generate-models.ts#L1232) and
[openai-completions.ts:656](../packages/ai/src/api/openai-completions.ts#L656).

OpenRouter only gets Anthropic-style markers for its `anthropic/*` routed
models, not for open-weight models. The marker format is selected in
[openai-completions.ts:1493](../packages/ai/src/api/openai-completions.ts#L1493).
OpenRouter open-weight models take the OpenAI path and therefore get no explicit
cache fields under the default `"short"` retention.

Vercel AI Gateway exposes many open-weight models through its
`anthropic-messages` endpoint. Those models follow the Anthropic adapter and
receive the standard Anthropic `cache_control` markers.

# Ground Truth: How `AGENTS.md` and `CLAUDE.md` Are Handled by Pi
## (According to the Documentation Only)

> **Purpose:** This document captures *only* what the pi documentation says about how `AGENTS.md` and `CLAUDE.md` context files are discovered, loaded, parsed, and used. It is the baseline for a future code-vs-docs comparison.

---

## 1. What They Are

Context files provide **project-specific instructions** that are loaded into the system prompt at startup. They are meant for "project instructions, conventions, common commands" (`README.md`).

Pi supports two filename variants interchangeably:
- `AGENTS.md`
- `CLAUDE.md`

There is no documented precedence rule between the two names; they are treated as equivalent alternatives.

---

## 2. Discovery & Resolution Order

The documentation states that Pi loads these files from **three sources**, in the following order (`README.md#context-files`):

1. **`~/.pi/agent/AGENTS.md`** (global context file)
2. **Parent directories** (walking up from the current working directory)
3. **Current directory**

The `docs/sdk.md` section on `DefaultResourceLoader` confirms this resolution:
- `cwd` is used for "Context files (`AGENTS.md` walking up from cwd)"
- `agentDir` is used for "Global context file (`AGENTS.md`)"

### 2.1 Concatenation

> "All matching files are concatenated." (`README.md`)

All discovered `AGENTS.md` / `CLAUDE.md` files are concatenated together. There is no documented separator or header inserted between files.

### 2.2 No Deduplication (Historical Exception)

A `CHANGELOG.md` entry (v0.24.1) notes a historical bug:
> "**Global AGENTS.md loaded twice**: Fixed global AGENTS.md being loaded twice when present in both `~/.pi/agent/` and the current directory."

This implies that **before the fix**, the global file could be loaded twice if the cwd happened to be `~/.pi/agent/`. The documentation does not state any current deduplication rule; it only records that this specific double-loading bug was fixed.

---

## 3. Relationship to the System Prompt

Context files (`AGENTS.md` / `CLAUDE.md`) are **distinct from** the system prompt replacement/append mechanism, but they are loaded into the same final prompt block.

### 3.1 SYSTEM.md (Full Replacement)

You can replace the **default** system prompt entirely:
- **Project-level:** `.pi/SYSTEM.md`
- **Global:** `~/.pi/agent/SYSTEM.md`
- **CLI override:** `--system-prompt <text>` (highest priority)

The precedence is: `--system-prompt` flag > project `.pi/SYSTEM.md` > global `~/.pi/agent/SYSTEM.md` (`CHANGELOG.md` v0.29.1).

### 3.2 APPEND_SYSTEM.md

You can append instructions to the system prompt without replacing it:
- `APPEND_SYSTEM.md` (`CHANGELOG.md` v0.22.0)

### 3.3 Context Files Are Always Appended (Unless Disabled)

The docs state that `--system-prompt <text>` "Replace default prompt (context files and skills still appended)" (`README.md#cli-reference`).

This means:
- `SYSTEM.md` replaces the *default* system prompt text.
- `AGENTS.md` / `CLAUDE.md` context files are **still appended** after the custom system prompt.
- `APPEND_SYSTEM.md` is also appended.

A historical bug fix (`CHANGELOG.md` v0.30.1) confirms this design:
> "**Custom system prompts missing context**: When using a custom system prompt string, project context files (AGENTS.md), skills, date/time, and working directory were not appended."

Similarly, the SDK docs note that `systemPrompt` string in `createAgentSession()` "now works as a full replacement instead of having context files and skills appended, matching documented behavior" (`CHANGELOG.md` v0.37.0). This implies the intended behavior is that a custom `systemPrompt` string is a *replacement*, but context files are still appended by default unless explicitly overridden.

---

## 4. CLI Flags

| Flag | Effect |
|------|--------|
| `--no-context-files`, `-nc` | **Disable** `AGENTS.md` and `CLAUDE.md` discovery and loading entirely (`README.md`, `CHANGELOG.md` v0.67.4) |
| `--system-prompt <text>` | Replace default prompt. Context files and skills are **still appended** (`README.md`) |
| `--append-system-prompt <text>` | Append text to the system prompt (`README.md`) |

The `--no-context-files` flag is specifically for "a clean run without project context injection" (`CHANGELOG.md`).

---

## 5. Hot Reload

Context files are **hot-reloadable** via the `/reload` command:

> "`/reload` - Reload keybindings, extensions, skills, prompts, and context files" (`README.md#commands`)

And from `CHANGELOG.md` v0.50.0:
> "Hot reload (`/reload`) of resources including AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md, prompt templates, skills, themes, and extensions."

This implies that editing an `AGENTS.md` or `CLAUDE.md` file and then running `/reload` in interactive mode will pick up the changes without restarting pi.

---

## 6. SDK / Programmatic API

### 6.1 DefaultResourceLoader

`DefaultResourceLoader` is the standard discovery mechanism. It discovers context files as part of its resource loading (`docs/sdk.md`).

Key configurable properties:
- `cwd` — controls project-level discovery (walking up from cwd)
- `agentDir` — controls global discovery (`~/.pi/agent/`)

### 6.2 agentsFilesOverride

Extensions and SDK users can override the discovered context files via `agentsFilesOverride`:

```typescript
const loader = new DefaultResourceLoader({
  agentsFilesOverride: (current) => ({
    agentsFiles: [
      ...current.agentsFiles,
      { path: "/virtual/AGENTS.md", content: "# Guidelines\n\n- Be concise" },
    ],
  }),
});
```

(`docs/sdk.md#context-files` and `examples/sdk/07-context-files.ts`)

The override callback receives `current` (the currently discovered list) and returns a new list. The example shows **appending** virtual files to the discovered list.

### 6.3 loadProjectContextFiles()

A standalone utility is exported for extensions that need to inspect the same resolution order without instantiating a full `DefaultResourceLoader`:

> "`loadProjectContextFiles()` is now exported as a standalone utility for extensions and SDK-style integrations that need to inspect the same context-file resolution order used by the CLI." (`CHANGELOG.md` v0.67.4)

> "Exported `loadProjectContextFiles()` as a standalone utility so extensions can discover project context files without instantiating a full `DefaultResourceLoader`." (`CHANGELOG.md` v0.67.4)

### 6.4 Resource Loader API

After reloading, you can inspect discovered files:

```typescript
const discovered = loader.getAgentsFiles().agentsFiles;
```

(`examples/sdk/07-context-files.ts`)

---

## 7. Extension Integration

### 7.1 systemPromptOptions.contextFiles

Extensions that hook into `before_agent_start` receive structured system-prompt options:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.systemPromptOptions includes:
  //   .contextFiles - AGENTS.md files and other loaded context files
});
```

(`docs/extensions.md#before_agent_start`)

This lets extensions inspect "what Pi has loaded — custom prompts, guidelines, tool snippets, context files, skills — without re-discovering resources or re-parsing flags."

### 7.2 Extension Context Files Property

The `.contextFiles` field is described as "AGENTS.md files and **other loaded context files**", which implies that extensions or the loader may introduce additional context file types beyond the standard `AGENTS.md` / `CLAUDE.md`.

---

## 8. Startup Header Display

In interactive mode, the startup header shows loaded context files among other resources:

> "**Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions" (`README.md`)

As of v0.67.6, this is displayed in a **compact, comma-separated view**:
> "Compact interactive startup header with a comma-separated view of loaded AGENTS.md files, prompt templates, skills, and extensions. Press `Ctrl+O` to toggle the expanded listing." (`CHANGELOG.md`)

Earlier it was an expanded listing; the compact view was introduced with `Ctrl+O` to toggle.

---

## 9. @ Mention / Macro Expansion

### 9.1 Absence in Documentation

**The documentation does NOT describe any `@AGENTS.md` or `@CLAUDE.md` macro expansion mechanism.**

However, the repository's own `AGENTS.md` file (at `/home/jan/src/pi-mono/AGENTS.md`) contains the literal line:

```markdown
@CLAUDE.md
```

This appears at the very end of the file under the heading "Additional Instructions for this Fork". There is **no explanation in any markdown file** of what `@CLAUDE.md` means, how it is parsed, or whether pi performs any macro expansion on `@` mentions inside context files.

The only `@` mention mechanism documented is **editor file references** (`README.md` interactive mode editor section):
> "File reference - Type `@` to fuzzy-search project files"

This is described as an *editor* feature for user input, not as a context-file preprocessing feature.

**Ground truth:** The docs are silent on `@CLAUDE.md` macro expansion inside context files. Any such behavior would be undocumented or inferred from code.

---

## 10. Historical Changes (CHANGELOG Timeline)

| Version | Change |
|---------|--------|
| v0.22.0 | Support `APPEND_SYSTEM.md` to append instructions to the system prompt |
| v0.24.1 | **Fixed**: Global AGENTS.md loaded twice when present in both `~/.pi/agent/` and current directory |
| v0.29.1 | **Automatic SYSTEM.md loading**: Pi auto-loads `SYSTEM.md` files. Project-local `.pi/SYSTEM.md` takes precedence over global `~/.pi/agent/SYSTEM.md`. CLI `--system-prompt` flag overrides both. |
| v0.30.1 | **Fixed**: Custom system prompts missing context — when using a custom system prompt string, project context files (AGENTS.md), skills, date/time, and working directory were not appended. |
| v0.37.0 | **Fixed**: String `systemPrompt` in `createAgentSession()` now works as a full replacement instead of having context files and skills appended, matching documented behavior. |
| v0.50.0 | Hot reload (`/reload`) of resources including AGENTS.md, SYSTEM.md, APPEND_SYSTEM.md, prompt templates, skills, themes, and extensions. |
| v0.67.4 | Added `--no-context-files` (`-nc`) to disable AGENTS.md and CLAUDE.md context file discovery and loading. Exported `loadProjectContextFiles()` as a standalone utility. |
| v0.67.6 | Compact interactive startup header shows loaded AGENTS.md files in a comma-separated view; `Ctrl+O` toggles expanded listing. |

---

## 11. Other Documented References

### 11.1 CONTRIBUTING.md

> "If you use an agent, run it from the `pi-mono` root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file."

This confirms that `AGENTS.md` is expected to be picked up automatically when running from the project root.

### 11.2 Termux Guide

The Termux documentation (`docs/termux.md`) includes an example `~/.pi/agent/AGENTS.md` for helping the agent understand the Termux Android environment. This demonstrates the intended use of the global context file for environment-specific instructions.

### 11.3 Root README

The root `README.md` of the monorepo links to `AGENTS.md` for "project-specific rules (for both humans and agents)."

### 11.4 PR Prompt Template

The `.pi/prompts/pr.md` template references `AGENTS.md` for changelog format rules:
> "Follow the changelog format rules in AGENTS.md."

This shows that `AGENTS.md` is treated as the authoritative source for project conventions that even prompt templates should reference.

---

## 12. What Is NOT Documented

The following behaviors are **absent from all markdown documentation** and would need to be verified against code:

1. **Whether `CLAUDE.md` and `AGENTS.md` in the same directory are both loaded or if one takes precedence.** The docs say "`AGENTS.md` (or `CLAUDE.md`)" which suggests they are alternatives, but does not specify what happens if both exist in the same directory.

2. **The exact concatenation order** when both `AGENTS.md` and `CLAUDE.md` exist in different directories along the walk-up path. The docs say "All matching files are concatenated" but do not specify whether files are sorted by directory depth, filename, or discovery order.

3. **@ macro expansion** inside context files (e.g., `@CLAUDE.md`). No docs explain this.

4. **Whether context files are parsed as Markdown or treated as plain text.** The docs describe them as Markdown files (`.md` extension, containing headings and bullet lists) but do not specify if pi parses frontmatter, strips HTML, or performs any other preprocessing.

5. **Whether context files are injected as a system message, appended to the system prompt string, or sent as a separate message.** The docs say "loaded into the system prompt" but do not specify the LLM-level representation.

6. **The exact path format for `agentsFilesOverride` virtual paths.** The example uses `/virtual/AGENTS.md` but does not document whether this has semantic meaning.

7. **Interaction with `--session-dir` or `-c` / `-r` flags.** No docs mention whether context files are re-discovered when resuming a session in a different directory.

---

## 13. Summary of Documented Behavior

| Aspect | Documented Behavior |
|--------|---------------------|
| **Filenames** | `AGENTS.md` or `CLAUDE.md` (interchangeable alternatives) |
| **Global file** | `~/.pi/agent/AGENTS.md` |
| **Project files** | Current directory + all parent directories walking up from cwd |
| **Concatenation** | All matching files concatenated together |
| **Disabling** | `--no-context-files` / `-nc` |
| **System prompt replacement** | `.pi/SYSTEM.md` or `~/.pi/agent/SYSTEM.md` or `--system-prompt` |
| **System prompt append** | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| **Context files with custom system prompt** | Still appended after the custom system prompt |
| **Hot reload** | Supported via `/reload` |
| **SDK override** | `agentsFilesOverride` callback on `DefaultResourceLoader` |
| **Standalone discovery** | `loadProjectContextFiles()` utility |
| **Extension access** | `event.systemPromptOptions.contextFiles` in `before_agent_start` |
| **Startup display** | Listed in compact startup header; `Ctrl+O` toggles expanded view |
| **@ macro expansion** | **Not documented** |
| **Double-loading guard** | Fixed in v0.24.1 (global file no longer loaded twice when cwd is agent dir) |

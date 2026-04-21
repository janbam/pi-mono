# JANBAM's Pi Notes ☕

## Core Philosophy
Pi follows a **minimal core, maximum extensibility** philosophy. The core provides only essential infrastructure, while features are built *on top of* pi rather than baked *into* it. The core ships with just four built-in tools: `read`, `write`, `edit`, and `bash`, plus optionally `grep`, `find`, and `ls`. Every other capability must be added via extensions, skills, prompt templates, or packages. This design intentionally avoids feature bloat by pushing workflow-specific functionality to the extension layer.

## Session System (The Brain) 🧠
Sessions are stored as **JSONL files** containing a tree structure where each entry has an `id` and `parentId`, enabling branching conversations without creating separate files. Sessions are automatically saved to `~/.pi/agent/sessions/` and organized by the current working directory. The branching system allows you to use `/tree` to navigate to any point in the conversation history and continue from there in-place, or `/fork` to create a new session file starting from a specific branch point. When conversations grow too long for the model's context window, **compaction** automatically summarizes older messages while keeping recent ones intact. Importantly, the full un-compacted history is always preserved in the JSONL file, so you can use `/tree` to revisit any original message even after compaction has occurred.

## 4 Modes
Pi can run in four different modes depending on your use case:
1. **interactive** - The default TUI chat interface with full editor, history, and command support
2. **print** - One-shot mode that outputs the response and exits immediately, useful for scripts
3. **json** - Outputs all events as structured JSON lines for programmatic consumption
4. **rpc** - A protocol over stdin/stdout for integrating pi into non-Node.js applications

## Customization Layers (Low → High effort)
Pi offers four layers of customization, ranging from simple configuration to full TypeScript development:

| Layer | What | Where |
|-------|------|-------|
| Themes | UI color schemes that hot-reload on change | `~/.pi/agent/themes/` |
| Prompt Templates | Reusable prompts invoked via `/name` commands | `~/.pi/agent/prompts/` |
| Skills | Markdown-based capability packages following the Agent Skills standard | `~/.pi/agent/skills/` |
| Extensions | Full TypeScript modules with access to the complete Extension API | `~/.pi/agent/extensions/` |

## What the Extension API Enables
The Extension API is powerful enough to build virtually any workflow feature you might need. Using extensions, you can: add custom tools or completely replace the built-in ones; register custom slash commands; hook into events like `tool_call` to intercept and modify behavior; add UI widgets including status lines, custom footers, and overlays; replace or augment the editor component; and build complex features like sub-agents, plan mode, permission gates, git checkpointing, or even games. None of these are built into pi core - they are all implemented as extensions that you can write yourself or install from others.

## Context Files
Pi automatically loads context files at startup to provide project-specific instructions. `AGENTS.md` or `CLAUDE.md` files are loaded from the global config directory (`~/.pi/agent/`), from the current directory, and from all parent directories walking up the tree. All matching files are concatenated together. You can replace the default system prompt entirely by creating `.pi/SYSTEM.md` (project-level) or `~/.pi/agent/SYSTEM.md` (global), or append to it using `APPEND_SYSTEM.md`.

## Package System
Pi packages allow you to bundle and share extensions, skills, prompts, and themes via npm or git repositories. Install packages using commands like `pi install npm:@foo/pi-tools` or `pi install git:github.com/user/repo`. To create a package, add a `pi` key to your `package.json` specifying which directories contain extensions, skills, prompts, and themes. Alternatively, pi will auto-discover content from conventional directory names (`extensions/`, `skills/`, `prompts/`, `themes/`).

## Commands Worth Remembering
- `/tree` - Opens an interactive tree view to navigate session branches
- `/fork` - Creates a new session file starting from the current conversation branch
- `/compact` - Manually triggers context compaction with optional custom instructions
- `/reload` - Hot-reloads all extensions, skills, and prompts without restarting pi
- `@file` in the editor - Fuzzy-searches and references project files in your message
- `!command` in the editor - Runs a bash command and sends its output to the LLM

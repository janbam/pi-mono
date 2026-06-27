# TODO: Expose Registered Tool Execution for Controlled Integrations

## Goal

Expose a narrow public API that can execute any registered Pi tool by name with explicit input, while preserving Pi's existing validation, extension hooks, result hooks, event emission, and source metadata.

This is needed for controlled integrations such as `pi-eval`/Psion that may need to call known Pi extension tools from deterministic code without letting an LLM invent arbitrary private calls.

## Current State

Pi already exposes registered tool metadata and input schemas:

- `pi.getAllTools()` / `ctx.getAllTools()` returns each tool's `name`, `description`, `parameters`, `promptGuidelines`, and `sourceInfo`.
- `AgentSession.getAllTools()` builds that metadata from `_toolDefinitions`.
- Executable tool instances live in `AgentSession._toolRegistry`.
- Tool definitions live in `AgentSession._toolDefinitions`.
- Tool argument validation and execution already happen inside the agent loop.

So the missing surface is execution, not schema discovery.

## Proposed API

Add an `AgentSession.executeTool()` method with a contract like:

```ts
export interface ExecuteToolOptions {
  toolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
}

export interface ExecuteToolResult {
  toolName: string;
  toolCallId: string;
  content: Array<TextContent | ImageContent>;
  details: unknown;
  isError: boolean;
  terminate?: boolean;
}

async executeTool(
  toolName: string,
  input: Record<string, unknown>,
  options?: ExecuteToolOptions,
): Promise<ExecuteToolResult>
```

The method should:

1. Look up the executable `AgentTool` in `_toolRegistry`.
2. Look up the `ToolDefinition`/metadata in `_toolDefinitions` for diagnostics and source information.
3. Run `prepareArguments` if present.
4. Validate arguments against the tool's `parameters` schema.
5. Emit the same extension/tool lifecycle hooks used by normal agent-driven tool calls:
   - `tool_execution_start`
   - `tool_call`
   - `tool_execution_update`
   - `tool_result`
   - `tool_execution_end`
6. Execute the tool with the same `ExtensionContext` behavior as normal registered tools.
7. Return structured content/details/error state to the caller.

## Important Semantics

- Unknown tool names must fail loudly.
- Validation failures must fail before execution.
- `tool_call` handlers must be able to block execution.
- `tool_result` handlers must be able to modify content/details/error state.
- The method should not append tool result messages to the conversation by default.
- The method should not start an agent turn.
- Execution should use the current session cwd and current extension runtime context.
- The caller is responsible for deciding whether direct tool execution is permitted.

## Public Exposure Options

After `AgentSession.executeTool()` exists, decide how much to expose:

- SDK-level only: exported on `AgentSession` for embedding hosts.
- Extension-level: add `pi.executeTool(name, input, options?)` to `ExtensionAPI`.
- RPC-level: add a JSONL RPC command only if external non-extension clients need it.

Prefer SDK-level first. Extension-level exposure is powerful and should be explicit because extensions run with full local permissions and tools may mutate state.

## Why This Is Viable

This does not require a Pi architecture rewrite. The registry and schema metadata already exist:

- `_toolDefinitions` has the schemas and source metadata.
- `_toolRegistry` has executable tools.
- `AgentSession` already owns extension hook wiring.
- `agent-core` already has the validation/execution policy, though some helper logic is currently private to `agent-loop.ts`.

The clean implementation may either:

- factor shared execution helpers out of `agent-loop.ts`, or
- implement the small execution sequence directly in `AgentSession`.

Factoring is preferable if it avoids duplicating validation/hook/error semantics.

## Risks

- A generic execution API can let one extension invoke tools whose side effects it does not understand.
- Some tools may assume they are called during an agent turn.
- Tool result events without corresponding assistant/tool-result messages may surprise existing extensions.
- Mutating `tool_call` handlers are currently not revalidated after mutation; preserve existing behavior or deliberately fix it in a separate breaking change.

## Done When

- `AgentSession.executeTool()` exists and is documented.
- It executes built-in and extension-registered tools.
- It exposes schemas through the existing `getAllTools()` path.
- It preserves existing tool lifecycle hooks.
- Tests cover success, unknown tool, validation failure, blocked tool call, result mutation, and extension-registered tool execution.
- No generic private executor internals are exposed without an explicit public contract.
- New interface is well documented in all relevant places and is clearly marked as fork-owned
- Has been live tested through small test extension that executes anothers extension tool and an agent running in pi has succesfully used this

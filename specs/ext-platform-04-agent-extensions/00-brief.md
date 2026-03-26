---
slug: ext-platform-04-agent-extensions
number: 184
created: 2026-03-26
status: brief
project: extensibility-platform
phase: 4
---

# Phase 4: Agent-Built Extensions

**Project:** Extensibility Platform
**Phase:** 4 of 4
**Depends on:** Phase 3 (Extension System Core), Phase 1 (Agent tool infrastructure)
**Enables:** The core DorkOS differentiator — agents that extend their own environment

---

## Scope

Enable DorkOS agents to build, install, and manage extensions autonomously. The agent writes TypeScript files to the extensions directory, triggers a reload, and the user sees the result immediately. This is the unique DorkOS advantage — no other agent platform lets the AI extend its own host application's UI at runtime.

## The Workflow

```
1. User: "Build me a dashboard card that shows my GitHub PR review queue"
2. Agent: writes extension.json + index.ts to ~/.dork/extensions/github-prs/
3. Agent: calls reload_extensions MCP tool
4. Host: compiles TS, loads extension, registers dashboard section
5. User: sees new dashboard card with PR data
6. User: "Add review status badges and filter by repo"
7. Agent: edits index.ts, triggers reload
8. Host: recompiles, re-activates, user sees updated card
```

The loop between "agent writes code" and "user sees result" must be tight — seconds, not minutes.

## Deliverables

### 1. MCP Tools for Extension Management

**Problem:** External agents (Claude Code, Cursor, Windsurf) need programmatic access to the extension system.

**Solution:** Add tools to the existing DorkOS MCP server (`apps/server/src/services/core/mcp-server.ts`):

- `list_extensions` — Returns all discovered extensions with status, source (global/local), and last error
- `create_extension` — Scaffolds a new extension directory with `extension.json` and a starter `index.ts`
  - Parameters: `name`, `description`, `slots` (which extension points to target), `scope` (`'global' | 'local'`)
  - The agent gets a working starting point, not an empty directory
- `reload_extensions` — Re-scans, recompiles, and reloads all extensions. Returns success/failure per extension with structured errors.
- `get_extension_errors` — Returns compilation or runtime errors for a specific extension (agent reads these to fix issues)

**Key source files:**

- `apps/server/src/services/core/mcp-server.ts` — Existing MCP tool registration
- `apps/server/src/routes/mcp.ts` — MCP route setup

### 2. ExtensionAPI Types as Agent Context

**Problem:** The agent needs to know the ExtensionAPI surface to write correct extension code. Without type information in context, the agent will hallucinate API calls.

**Solution:**

- Expose `packages/extension-api/` type definitions as an MCP resource
- When an agent starts building an extension, the types are automatically available in context
- The `create_extension` tool includes a brief API reference in the generated `index.ts` comments
- Optionally: a `get_extension_api_reference` MCP tool that returns the full typed interface

### 3. Structured Error Feedback Loop

**Problem:** When the agent writes an extension that fails to compile or activate, it needs structured error information to fix the issue — not a vague "extension failed" message.

**Solution:**

- Compilation errors from esbuild include: file, line, column, message, source snippet
- Runtime errors during activation include: error type, message, stack trace
- `reload_extensions` returns per-extension results:
  ```json
  {
    "github-prs": {
      "status": "error",
      "phase": "compilation",
      "errors": [
        {
          "file": "index.ts",
          "line": 15,
          "column": 8,
          "message": "Property 'registerWidget' does not exist on type 'ExtensionAPI'"
        }
      ]
    }
  }
  ```
- The agent reads this, fixes the code, and retries. The loop is: write → reload → read errors → fix → reload.

### 4. File Watcher (Optional)

**Problem:** The `reload_extensions` tool requires the agent to explicitly trigger a reload after every edit. A file watcher could make this automatic.

**Solution:**

- Watch `{dorkHome}/extensions/` and `{cwd}/.dork/extensions/` for file changes
- On change: debounce (500ms), recompile affected extension, re-activate
- Notify connected clients via existing SSE channel (new event type: `extension_reloaded`)
- This is optional — the explicit `reload_extensions` tool is sufficient for v1. The watcher is a DX improvement.

### 5. Scope Inference

**Problem:** When the agent builds an extension, should it go in global or local? The agent needs to make a reasonable default choice.

**Solution:**

- Default to **local** (`.dork/extensions/` in the active CWD) — safer, more conservative
- If the agent determines the extension is universally useful (no project-specific data, general utility), it can use `scope: 'global'`
- The `create_extension` tool accepts an explicit `scope` parameter
- The agent can ask the user if ambiguous: "Should this extension be available in all your projects or just this one?"

## Key Decisions (Settled)

1. **MCP tools, not HTTP endpoints** — Extension management is exposed via the existing DorkOS MCP server, not new REST endpoints. This keeps the agent-facing API consistent with other DorkOS tools.
2. **Structured errors are mandatory** — Vague error messages break the agent feedback loop. Every failure must include enough information for the agent to fix the issue autonomously.
3. **Default to local scope** — Safer. The agent can promote to global explicitly. Better to be conservative with filesystem writes.
4. **`create_extension` scaffolds a working starter** — Not an empty directory. The agent gets a minimal extension that compiles and activates, then iterates from there.
5. **File watcher is optional for v1** — Nice DX improvement, but `reload_extensions` is sufficient. Don't block on this.

## Open Questions (For /ideate)

1. **How does the agent get ExtensionAPI types in context?** — MCP resource? Injected into the CLAUDE.md context? A reference file the agent reads? What's the most reliable way to ensure the agent knows the API?
2. **Agent iteration speed** — How fast is the write → compile → reload → render cycle? esbuild compilation is ~10ms. What's the total latency? Is it fast enough for the agent to iterate without the user noticing?
3. **Extension templates** — Should `create_extension` offer templates? "Dashboard card", "Command palette command", "Settings tab", "Canvas renderer"? Or is a generic starter sufficient?
4. **Security considerations** — The agent writes arbitrary TypeScript that runs in-process. In v1, the audience is developers who trust their agents. But what guardrails (if any) should exist? A confirmation prompt before activating agent-written extensions?
5. **Extension testing** — Can the agent verify its extension works? Should there be a `test_extension` MCP tool that activates the extension in a sandboxed context and returns a success/failure?
6. **Hot reload vs full reload** — When the agent edits an extension, does the host re-activate just that extension (hot) or all extensions (full)? Hot is faster but more complex.
7. **Agent awareness of existing extensions** — Should the agent see what extensions are already installed? Could it modify existing extensions, not just create new ones?

## Reference Material

### Existing ideation docs

- `specs/plugin-extension-system/01-ideation.md` (spec #173) — Agent-built plugin workflow, key enablers, P3 priority items

### Research

- `research/20260323_plugin_extension_ui_architecture_patterns.md` — Obsidian's full-trust model, VSCode's Extension Host

### Architecture docs

- `contributing/architecture.md` — Hexagonal architecture, MCP server integration
- `apps/server/src/services/core/mcp-server.ts` — Existing MCP tool registration patterns

## Acceptance Criteria

- [ ] `list_extensions` MCP tool returns all extensions with status and source
- [ ] `create_extension` MCP tool scaffolds a working extension that compiles and activates
- [ ] `create_extension` supports `scope: 'global' | 'local'` parameter
- [ ] `reload_extensions` MCP tool recompiles and reloads, returns per-extension structured results
- [ ] Compilation errors include file, line, column, message — enough for the agent to fix
- [ ] Runtime activation errors include error type, message, stack trace
- [ ] ExtensionAPI type definitions accessible to the agent (via MCP resource or reference tool)
- [ ] End-to-end workflow works: agent writes extension → reload → extension renders in correct slot
- [ ] Agent can iterate: edit extension → reload → see updated rendering
- [ ] Default scope is local (`.dork/extensions/` in active CWD)
- [ ] Agent can create a global extension by passing `scope: 'global'`
- [ ] Scaffolded extension includes ExtensionAPI usage examples in comments
- [ ] No new tools registered outside the MCP server boundary (no direct HTTP endpoints for agent use)

/**
 * Static capability configuration for the Codex runtime. Values are the task
 * 2.2 verification verdicts (NOTES.md), live-verified against the pinned CLI
 * and SDK.
 *
 * @module services/runtimes/codex/runtime-constants
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/**
 * Static Codex capabilities (NOTES.md Verdicts 1 & 2).
 *
 * - `supportsToolApproval: false` — `codex exec` has NO interactive approval
 *   channel (stdin closes after the prompt; approval-needing calls
 *   auto-cancel). Permission posture is upfront sandbox selection, and the
 *   approval UI is capability-gated off.
 * - `supportsCostTracking: false` — turn usage reports tokens (mapped to
 *   `session_status`), but Codex exposes no dollar-cost accounting, so the
 *   cost strip stays gated off.
 * - `supportsMcp: false` — DorkOS still cannot inject an in-process MCP tool
 *   server or apply per-agent tool-group filtering. The one exception is a
 *   single hard-wired stub: DorkOS registers one internal `dorkos_ui` MCP
 *   server via `CodexOptions.config` solely to expose `control_ui`, which the
 *   event-mapper translates into a `ui_command` StreamEvent (canvas parity
 *   with Claude Code). That narrow, non-configurable bridge does not amount to
 *   general MCP support, so this flag stays honestly `false`. User-configured
 *   servers in `~/.codex/config.toml` still stream as `mcp_tool_call` items
 *   and render as tool events.
 * - `supportsManagedMcpServers: true` — Codex DOES accept an agent's own
 *   managed MCP servers (the `mcp.*` verbs, spec `mcp-server-management`),
 *   injected per-turn as `--config mcp_servers.*` overrides through
 *   `CodexOptions.config` (stdio and streamable-HTTP; SSE has no Codex
 *   transport and is skipped). This is orthogonal to `supportsMcp` above:
 *   external managed servers work without the in-process DorkOS tool server
 *   (DOR-892). See {@link ./mcp-server-config}.
 * - Permission-mode ids reuse existing `PermissionModeSchema` members so the
 *   PATCH persistence path validates them (NOTES.md Verdict 2 enum decision).
 */
export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  type: 'codex',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: true,
  supportsMcp: false,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  // Every turn is a fresh subprocess (ADR-0309), and the only interrupt
  // primitive is an `AbortSignal` — there is no live session to steer into or
  // stage onto. The SDK has no mid-turn input at 0.154.0, so `false` stays the
  // honest answer until a future live probe says otherwise (spec
  // `persistent-session-runtime` §2.6).
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  // History reconstructs from the DorkOS EventLog (no thread-read API), so the
  // platform persists it to the durable session-event store (DOR-189).
  logBackedHistory: true,
  // The FLOOR, not the answer: `CodexRuntime.getCapabilities` overrides it to
  // `'attachments'` whenever the composition root handed the runtime a
  // `SessionAttachmentStore`. Wired without one there is nowhere to put a
  // picture, and `'none'` is then the truth.
  //
  // Half of the gap was never fixable here and still is not.
  // `@openai/codex-sdk@0.154.0`'s `ThreadItem` union carries no image OUTPUT
  // item at all, so Codex cannot stream a generated picture through this SDK
  // however the adapter is written (`local_image` appears only on `UserInput` —
  // the input direction). An MCP tool result is its ONE media path, and that
  // half now works: `media-capture.ts` reads MCP `ImageContent` blocks that
  // `extractMcpResultText` used to filter away (ADR 260901-135657, DOR-1664).
  mediaOutput: 'none',
  permissionModes: {
    supported: true,
    // Matches `codex exec`'s own default posture (read-only sandbox).
    default: 'default',
    values: [
      {
        // Read-only, so it never has anything to ask about: `asks: 'never'` here
        // means "cannot ask", not "will not stop" — which is why the warning
        // tier reads `reach` too, and leaves a read-only mode alone.
        id: 'default',
        label: 'Read only',
        description:
          'Sandboxed reads — Codex can read files and answer questions, but not edit files, run mutating commands, or access the network.',
        stop: 'ask',
        asks: 'never',
        reach: 'read',
        promise: 'Reads files and answers questions. Nothing on your machine changes.',
        native: 'read-only',
      },
      {
        // THE divergent stop. `workspace-write` sits where the middle stop sits,
        // but Codex has no approval channel at all — it cannot pause mid-turn to
        // ask, so it runs shell commands unprompted. The promise says so in the
        // words a person would use, because the surface's whole job here is to
        // stop this being a surprise (spec `trust-dial`, decision 2).
        id: 'acceptEdits',
        label: 'Workspace write',
        description:
          'Codex can read, edit, and run commands inside the workspace. Network access stays off.',
        stop: 'act',
        asks: 'never',
        reach: 'workspace',
        promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
        native: 'workspace-write',
      },
      {
        id: 'bypassPermissions',
        label: 'Full access',
        description:
          'No sandbox — full file and network access. Use only in trusted or externally-sandboxed environments.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise:
          "Acts without approval prompts, anywhere on your machine, network included — and can't pause to ask.",
        native: 'danger-full-access',
      },
    ],
  },
  // Effort is reported per model by app-server model discovery. No bespoke
  // section: Codex's settings card is the common execution defaults and
  // nothing else.
  settings: { configSection: 'codex', supportsEffort: true, sections: [] },
  // Codex has no compaction/summarize API (`Thread.run` only, verified at the
  // 0.154.0 pin), so this stays honestly `false` (DOR-109 task 2.3).
  commandIntents: { compact: { supported: false } },
  features: {},
};

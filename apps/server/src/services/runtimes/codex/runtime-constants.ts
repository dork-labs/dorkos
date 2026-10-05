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
  supportsAccounts: false,
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
        //
        // The promise says the refusal out loud (DOR-2019). It used to stop at
        // "nothing on your machine changes", which is true and still left the
        // dead end to be discovered: the stop is called "Ask first", Codex has
        // no approval channel, so a request to edit a file is not a card to
        // answer — it is turned down by the sandbox and reported as the agent
        // saying it cannot. Naming that here is the whole of option 1.
        id: 'default',
        label: 'Read only',
        description:
          'Codex can read files and answer questions. It cannot change files, run commands that change things, or reach the network.',
        stop: 'ask',
        asks: 'never',
        reach: 'read',
        promise:
          'Codex can read files but not change them. Asking it to make a change gets a no, not a prompt.',
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
        // "inside the workspace" is narrower than the sandbox actually is, and
        // the copy used to inherit that: `WorkspaceWrite` grants READ over the
        // whole disk, and its writable roots include `/tmp` and `$TMPDIR`
        // alongside the project (codex-rs `protocol.rs`, SandboxPolicy). Say
        // both, or a person picking this stop is told it is more contained than
        // it is.
        description:
          'Codex can read anything on this machine, and change files and run commands in this project and in the temporary folders the sandbox allows. It cannot reach the network.',
        stop: 'act',
        asks: 'never',
        reach: 'workspace',
        promise:
          'Codex can read anything on this machine, and change files and run commands in this project and in temporary folders. It cannot stop to ask you first.',
        native: 'workspace-write',
      },
      {
        id: 'bypassPermissions',
        label: 'Full access',
        description:
          'No sandbox. Codex can change anything on this machine and reach the network. Use it only where you trust everything it might do.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        // No softening clause, for the reason claude-code's own bypass promise
        // gives (DOR-1754): this sentence is what the consent dialog reads out.
        promise:
          'Codex can change anything on this machine, network included. It cannot stop to ask you first.',
        native: 'danger-full-access',
      },
    ],
  },
  // Effort is reported per model by app-server model discovery. The one bespoke
  // section is `runtime-usage`: the account's usage windows, drawn from its
  // usage ledger (spec `claude-account-ui` §6.5).
  settings: {
    configSection: 'codex',
    supportsEffort: true,
    // `credits-runs-on` draws only while the server reports Codex as wired
    // for credits; until then the card is exactly what it was.
    sections: [{ kind: 'credits-runs-on' }, { kind: 'runtime-usage' }],
  },
  // Codex has no compaction/summarize API (`Thread.run` only, verified at the
  // 0.154.0 pin), so this stays honestly `false` (DOR-109 task 2.3).
  commandIntents: { compact: { supported: false } },
  // DorkOS credits (ADR 261001-000811): a new thread set to credits runs in a
  // DorkOS-owned Codex home with a `dorkos-credits` model provider DorkOS
  // supplies per turn (`credits-launch.ts`). Codex speaks only the responses
  // format, so credits reach it only once the endpoint serves that format;
  // until then it is reported as not wired and nothing offers it.
  // Web search is the vendor's own billed tool, which the credits endpoint
  // cannot carry, so it is off on credits turns (`credits-launch.ts`).
  credits: {
    protocol: 'openai-responses',
    scope: 'conversation',
    caveat: "Codex can't search the web on DorkOS credits.",
  },
  features: {},
};

/**
 * The permission modes on the app-server transport (spec
 * `codex-app-server-transport` §10). Same ids as exec, so stored sessions and
 * the descriptor-based ceiling comparisons keep working; what changes is that
 * Codex can now stop and ask, so the first two modes say so.
 *
 * - `default` — read-only sandbox, `on-request`: every change escalates to a
 *   card, so it asks `always`.
 * - `acceptEdits` — Codex's own "Auto" preset: edits and commands inside the
 *   project and temp folders run; reaching outside them or the network asks.
 * - `bypassPermissions` — no sandbox and `never`: nothing is asked.
 *
 * `denyReason: false`: Codex's decisions carry no reason text, so the box is
 * hidden rather than typed into a void. Copy follows `writing-app-copy`
 * (15 words a block at most).
 */
export const CODEX_APP_SERVER_PERMISSION_MODES: RuntimeCapabilities['permissionModes'] = {
  supported: true,
  default: 'default',
  denyReason: false,
  values: [
    {
      id: 'default',
      label: 'Ask first',
      description: 'Codex reads files freely. It asks before it changes anything.',
      stop: 'ask',
      asks: 'always',
      reach: 'workspace',
      promise: 'Codex can read files and run read-only commands. It asks before anything else.',
      native: 'read-only, asks first',
    },
    {
      id: 'acceptEdits',
      label: 'Workspace write',
      description:
        'Codex can read anything on this machine and change this project without asking.',
      stop: 'act',
      asks: 'when-risky',
      reach: 'workspace',
      promise:
        'Codex changes this project and temporary folders freely. It asks before going further or online.',
      native: 'workspace-write, asks for more',
    },
    {
      id: 'bypassPermissions',
      label: 'Full access',
      description: 'No sandbox. Codex can change anything on this machine and go online.',
      stop: 'autonomy',
      asks: 'never',
      reach: 'everything',
      // No softening clause (DOR-1754): the consent dialog reads this out.
      promise:
        'Codex can change anything on this machine, network included. It never stops to ask.',
      native: 'danger-full-access',
    },
  ],
};

/**
 * Capability overrides for the app-server transport, merged over
 * {@link CODEX_CAPABILITIES} (spec §14, phase P2). A thread stays loaded
 * between turns; Codex can stop to ask, put a question to the person, and take
 * a message into a running turn.
 */
export const CODEX_APP_SERVER_CAPABILITIES: Partial<RuntimeCapabilities> = {
  supportsPersistentSession: true,
  supportsToolApproval: true,
  supportsQuestionPrompt: true,
  permissionModes: CODEX_APP_SERVER_PERMISSION_MODES,
};

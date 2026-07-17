/**
 * Static configuration for the OpenCode runtime — capability flags and turn
 * timing. Values are the task 3.2 verification verdicts (NOTES.md §2),
 * derived from the pinned `@opencode-ai/sdk@1.17.13` and the upstream server
 * source at that tag.
 *
 * @module services/runtimes/opencode/runtime-constants
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/**
 * Static OpenCode capabilities (NOTES.md §2).
 *
 * - `supportsToolApproval: true` — the sidecar's conservative ask-ruleset
 *   raises `permission.updated` for every edit/bash/webfetch, mapped to
 *   `approval_required` and answered through
 *   `POST /session/{id}/permissions/{permissionID}` (`once`/`reject` only —
 *   never `always`, so OpenCode-side rule state cannot diverge from DorkOS).
 * - `supportsCostTracking: true` — completed assistant messages carry real
 *   `cost` (USD) + token usage, which the event mapper emits as
 *   `session_status`.
 * - `supportsResume: true` — sessions live in OpenCode's durable store and
 *   are re-listable/promptable across DorkOS and sidecar restarts.
 * - `supportsMcp: false` — DorkOS cannot inject its MCP tool server into the
 *   sidecar; user-configured OpenCode MCP servers still surface as tool parts.
 * - `supportsQuestionPrompt: false` — no AskUserQuestion-equivalent surface
 *   on the v1 API.
 * - `supportsPlugins: false` — OpenCode plugins are its own ecosystem, not
 *   DorkOS-loadable.
 * - Permission-mode ids reuse existing `PermissionModeSchema` members so the
 *   PATCH persistence path validates them (NOTES.md §2 descriptor decision).
 *   `plan` (an OpenCode agent, not a mode) and `auto` (process-wide flag) are
 *   deliberately omitted.
 */
export const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'opencode',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  nativeContext: [],
  // The EventLog is the fallback history source when the native sidecar read
  // fails/unbinds, so the platform persists it durably (DOR-189).
  logBackedHistory: true,
  permissionModes: {
    supported: true,
    // Conservative: approval-required (matches the sidecar ask-ruleset).
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        description: 'Ask before edits, shell commands, and web fetches.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        description: 'Auto-accept file edits; still prompt for other tools.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        description: 'Skip all tool approval prompts — use only in trusted contexts.',
      },
    ],
  },
  // Phase-1 placeholder — Phase 2 (DOR-109 task 2.2) flips this to true once the
  // `client.session.summarize` fulfillment body lands.
  commandIntents: { compact: { supported: false } },
  features: {},
};

/**
 * How long `sendMessage` waits for the global event stream to become
 * observably live before triggering the turn anyway. The sidecar sends
 * `server.connected` on stream open, so this normally resolves in
 * milliseconds; the timeout keeps turns live if that event ever disappears
 * upstream (at worst, cumulative part snapshots self-heal missed deltas).
 */
export const STREAM_LIVE_TIMEOUT_MS = 2_000;

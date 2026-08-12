/**
 * Static configuration for the OpenCode runtime — capability flags, turn
 * timing, and the session-listing ceiling. Values are the task 3.2
 * verification verdicts (NOTES.md §2), derived from the pinned
 * `@opencode-ai/sdk@1.17.13` and the upstream server source at that tag —
 * except the approval claims, which were re-verified live against the shipped
 * 1.18.15 sidecar after its permission surface moved (NOTES.md §2, DOR-1147).
 *
 * @module services/runtimes/opencode/runtime-constants
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/**
 * Static OpenCode capabilities (NOTES.md §2).
 *
 * - `supportsToolApproval: true` — the sidecar's conservative ask-ruleset
 *   raises `permission.asked` for every edit/bash/webfetch, mapped to
 *   `approval_required` and answered through
 *   `POST /session/{id}/permissions/{permissionID}` (`once`/`reject` only —
 *   never `always`, so OpenCode-side rule state cannot diverge from DorkOS).
 *   Both the event name and the reply route are live-verified against the
 *   shipped 1.18.15 sidecar (2026-08-11, DOR-1147); the SDK's generated types
 *   still describe an older permission surface the server no longer speaks.
 * - `supportsCostTracking: true` — completed assistant messages carry real
 *   `cost` (USD) + token usage, which the event mapper emits as
 *   `session_status`.
 * - `supportsResume: true` — sessions live in OpenCode's durable store and
 *   are re-listable/promptable across DorkOS and sidecar restarts.
 * - `supportsMcp: false` — DorkOS does not inject its own in-process `dorkos`
 *   tool server into OpenCode. User-configured OpenCode MCP servers are SURFACED
 *   read-only via {@link OpenCodeRuntime.getMcpStatus} (DOR-893), which reads the
 *   sidecar's `GET /mcp`. Distinct from managed servers below.
 * - `supportsManagedMcpServers: true` — DorkOS registers an agent's ENABLED
 *   managed MCP servers into the live sidecar per turn via `client.mcp.add`
 *   (DOR-893). The sidecar's add/connect/disconnect mutate only its in-memory
 *   per-directory registry (no `opencode.json` write, verified against the pin —
 *   NOTES.md §6), so injection is ephemeral, exactly like claude's inline
 *   servers. `sse` is withheld — OpenCode has no SSE transport (mirrors codex).
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
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  // The sidecar (ADR-0308) offers no mid-turn delivery: its only interrupt is
  // `POST /session/{id}/abort`, and OpenCode's own message queue lives in its
  // TUI rather than its server (DOR-82 survey). Nothing to steer into or stage
  // onto (spec `persistent-session-runtime` §2.6).
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
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
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file, runs a command, or fetches a page.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        description: 'Auto-accept file edits; still prompt for other tools.',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        description: 'Skip all tool approval prompts — use only in trusted contexts.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
    ],
  },
  // `supportsEffort: false` because OpenCode's prompt body carries no effort
  // field in either the pinned or the current SDK — effort exists there only as
  // config-file variants with no API selection. The `opencode-power-source`
  // section is the provider picker; the current provider is dynamic and stays
  // on `GET /api/config`.
  settings: {
    configSection: 'opencode',
    supportsEffort: false,
    sections: [{ kind: 'opencode-power-source' }],
  },
  // OpenCode fulfills `compact` via its native sidecar compaction
  // (`client.session.summarize`; DOR-109 task 2.2, ADR-0273) —
  // `executeCommandIntent` carries that body.
  commandIntents: { compact: { supported: true } },
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

/**
 * How many ROOT sessions one `GET /session` may return before the adapter
 * treats the read as truncated.
 *
 * Sent with no `limit`, the sidecar answers with its own default page — 100
 * most-recently-updated at v1.17.13 — dropping the rest silently, with no
 * error and no marker. Sending an explicit `limit` lifts that; the server
 * applies no clamp of its own (verified live: 1,000,000 is accepted, and a
 * request for 1001 against 1001 sessions returns all 1001). That default is
 * deliberately NOT encoded here: it belongs to the sidecar and can move
 * between builds, so the adapter proves `limit` is honoured by behaviour
 * instead of recognising any particular page size (`assertLimitHonoured` in
 * `session-mapper.ts`).
 *
 * 1000 is high enough that no real project reaches it — the busiest measured
 * here holds 49 — while still bounding the work one listing can ask of the
 * sidecar inside the 2s per-runtime aggregation budget
 * (`aggregate-session-list.ts`).
 *
 * The adapter requests one MORE than this and treats only a genuine overflow
 * as truncation, so a project holding exactly this many is served normally
 * rather than rejected — see `listSessions` in `session-mapper.ts`.
 */
export const SESSION_LIST_LIMIT = 1000;

/**
 * The same ceiling for the id-binding rebuild in `getMessageHistory`, which
 * lists roots AND children (it must be able to bind a child session's id).
 *
 * Doubled deliberately: {@link SESSION_LIST_LIMIT} is a budget of ROOTS, and
 * child (subtask) sessions measured ~50% of rows in a driven project, so an
 * equal number here would cover only about half as many roots as the list
 * itself shows. A session visible in the list must stay openable.
 */
export const SESSION_REBUILD_LIMIT = SESSION_LIST_LIMIT * 2;

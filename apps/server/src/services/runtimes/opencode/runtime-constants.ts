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
  // The BASE declaration, for a runtime wired without an attachment store.
  // `OpenCodeRuntime.getCapabilities` upgrades it to `'attachments'` when one
  // is wired, because a runtime with nowhere to put an image cannot honestly
  // claim to carry one (`RuntimeCapabilities.mediaOutput`).
  mediaOutput: 'none',
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
        // No softening clause, for the reason claude-code's own bypass mode
        // carries (DOR-1754): the consent dialog reads this sentence out, and
        // "Still asks when it needs your call" contradicted `asks: 'never'`.
        promise:
          'Acts without approval prompts, including outside this project. It will not stop to ask you.',
      },
    ],
    // `POST /session/{id}/permissions/{permissionID}` takes `once`/`reject`
    // only — no free-text field the sidecar forwards to the agent. A reason
    // typed into DorkOS's deny UI would go nowhere (DOR-825, PR #693/DOR-809's
    // review), so the client hides that field on this runtime instead of
    // offering it silently.
    denyReason: false,
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
 * How long `interruptQuery`'s `session.abort` call may go unanswered before
 * OpenCode gives up on it and answers Stop honestly instead of hanging it
 * (DOR-1299).
 *
 * The wedge this guards against is the same shape as claude-code's
 * `STOP_ACK_TIMEOUT_MS` (`sessions/bounded-control.ts`, DOR-1244): a promise
 * that only a backend ack settles, raced against nothing, on a wire that can
 * drop a request in silence with a sidecar that never crashes and never
 * answers. 3s to match — the same person-facing complaint applies (a Stop
 * that visibly does nothing reads as broken) and `POST /session/{id}/abort`
 * is a control call a healthy sidecar acks in milliseconds, so this is
 * budget for a genuinely stuck one, not for a slow one.
 *
 * Unlike claude-code there is no escalation on expiry. Claude-code's bound
 * closes the CLI SUBPROCESS behind the stuck query — one process, one
 * session. OpenCode has no per-session process to close: `apps/server`
 * manages exactly ONE `opencode serve` child for its own lifetime, spawned
 * lazily on first use and shared by every session across every project this
 * server instance has open (ADR-0308 — "a single instance suffices", per-
 * request `directory` routing rather than a per-cwd pool). Killing IT to
 * unstick a single wedged interrupt would cut every other session's turn on
 * the whole server, workspace-unrelated ones included. Expiry here is
 * therefore a plain, honest `false` — the same answer a refused interrupt
 * gets — rather than an escalation with no session-scoped target to aim at.
 */
export const INTERRUPT_ACK_TIMEOUT_MS = 3_000;

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
 * **Raised 1000 → 5000 for DOR-674**, because the budget stopped being a
 * per-project number. The read is now widened with `scope=project` so sessions
 * in a project's SUBFOLDERS are visible, and on the pinned sidecar every
 * worktree reports `projectID: "global"`, which makes that read effectively
 * machine-wide (NOTES.md §8). At 1000 a machine holding a thousand OpenCode
 * sessions across all its projects would degrade EVERY project's OpenCode list
 * to a warning — a cliff the old per-project 1000 could not reach, since the
 * busiest project measured here holds 49.
 *
 * 5000 costs nothing worth counting: a 5001-row page measures 1.34 MB and
 * 2.2 ms to parse, filter and map (10,000 rows: 2.69 MB, 4.3 ms) against the 2s
 * per-runtime aggregation budget (`aggregate-session-list.ts`), and it travels
 * over loopback from a sidecar on the same machine. The ceiling exists to bound
 * an unbounded read, not because the rows are expensive.
 *
 * The adapter requests one MORE than this and treats only a genuine overflow
 * as truncation, so a machine holding exactly this many is served normally
 * rather than rejected — see `listSessions` in `session-mapper.ts`.
 */
export const SESSION_LIST_LIMIT = 5000;

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

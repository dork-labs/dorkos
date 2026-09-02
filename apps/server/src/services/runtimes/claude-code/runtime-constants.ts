/**
 * Static configuration for the Claude Code runtime — capability flags.
 *
 * @module services/runtimes/claude-code/runtime-constants
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/**
 * Static Claude Code capabilities.
 *
 * `permissionModes.values[].id` mirrors the Claude Agent SDK's `PermissionMode`
 * union (`'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'`). The SDK
 * also exposes a fifth `'dontAsk'` mode, which DorkOS deliberately does not
 * surface yet — see research/20260315_agent_runtime_permission_modes.md for
 * rationale. When the SDK upgrade adopts `'dontAsk'`, add a descriptor here.
 *
 * `features` is the typed extension point for Claude-specific UI metadata.
 * Only keys with an actual consumer (current or planned in task #12 —
 * `ChatStatusSection` and friends) belong here; see ADR 0256.
 */
export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  // This adapter CAN hold one process across many turns: `SessionPump` owns it,
  // `SessionTurnWindows` cuts the turns out of its output, and
  // `PersistentDispatch` is the path a message takes to reach it (spec
  // `persistent-session-runtime` §P3).
  //
  // The capability says the adapter is able to, not that every session does.
  // Whether a given session holds its process is the operator's setting
  // `runtimes.claudeCode.persistentSession`, which ships ON since it graduated
  // (spec `full-power-defaults`, D1) — so on a default install sessions DO go
  // warm, and `getSessionWarmth` reports the real thing rather than a uniform
  // `cold`. It is still per session and still readable as `false`: a chat keeps
  // the path it started on, so a `cold` answer stays a normal one.
  //
  // Two consequences of how that opt-in is read, both deliberate, both spelled
  // out in `sessions/persistent-dispatch.ts`: turning it ON takes effect at a
  // session's next message, and turning it OFF does not take a session that is
  // already warm back — it keeps its process until the idle reap, an eviction, a
  // warm-ceiling reclaim, or a restart. A measurement run that flips the flag
  // off must reap or restart before it can claim it is measuring the other path.
  supportsPersistentSession: true,
  // Both land in P4: `deliverIntoTurn(mode: 'steer')` rides the persistent pump's
  // held `streamInput` (task 4.1), and `deliverIntoTurn(mode: 'stage')` reaches
  // the transcript with `shouldQuery: false` (task 4.2). A capability is what this
  // adapter DOES, and it now does both.
  supportsSteer: true,
  supportsContextStaging: true,
  // Honest, and currently WRONG in the sense that matters: claude-code CAN meet
  // media, and throws it away. `extractToolResultContent`
  // (`sessions/transcript-parser.ts`) filters a tool result down to
  // `b.type === 'text'`, so a `Read` of a PNG is discarded without a word —
  // the most ordinary media case of all three runtimes, on the DEFAULT runtime.
  // The seam it needs now exists (`services/session/attachments/`); until the
  // adapter is taught to use it, saying `'none'` is what keeps the gap visible
  // instead of silent (ADR 260901-135657).
  mediaOutput: 'none',
  // Native git is suppressed via `excludeDynamicSections` (ADR-0273 A2), so the
  // server injects all context kinds from the bag — none are runtime-native.
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        description: 'Prompt on tool use and respect project permission settings.',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
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
        // The one mode that is not a trust level: `axis: 'working'` takes it off
        // the dial and puts it beside the composer, where a person switches it on
        // for a stretch of work rather than leaving a session parked at it (spec
        // `trust-dial`, decision 1). `stop: 'ask'` stays honest for the surfaces
        // that still have to place it — plan changes nothing until the person
        // approves the plan it hands back.
        id: 'plan',
        label: 'Plan',
        description: 'Read-only planning mode — the agent cannot execute tools.',
        stop: 'ask',
        axis: 'working',
        asks: 'always',
        reach: 'read',
        promise: 'Reads and plans only. Nothing changes until you approve the plan.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        description: 'Skip all tool approval prompts — use only in trusted contexts.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise:
          'Acts without approval prompts — including outside this project. Still asks when it needs your call.',
      },
      {
        // Research preview, and the middle stop's intelligence rather than a
        // stop of its own (spec `trust-dial`, decision 1). `asks: 'when-risky'`
        // is measured, not assumed: under `auto` the classifier resolves most
        // calls, and DorkOS still raises an approval card for the ones it
        // escalates (`resolveModeDecision` in `messaging/interactive-handlers`).
        id: 'auto',
        label: 'Auto',
        description:
          'A safety classifier approves or denies tool calls automatically — fewer interruptions on long autonomous runs. Research preview.',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own and weighs each command, asking you about the risky ones.',
      },
    ],
    // The SDK's deny tool result carries a free-text reason the agent receives
    // verbatim (DOR-825). Declared explicitly, though it also happens to be
    // the default, so the capability is documented rather than implied.
    denyReason: true,
  },
  // Effort is real at the API here, and the per-model rungs come from the model
  // catalog (`ModelOption.supportedEffortLevels`) — both gates apply. The
  // `claude-accounts` section is the relocated billing-account feature, which
  // reads its live account list from `GET /api/config`, not from here.
  settings: {
    configSection: 'claudeCode',
    supportsEffort: true,
    sections: [{ kind: 'claude-accounts' }],
  },
  // Claude fulfills `compact` by sending the bare `/compact` prompt through its
  // existing send path (DOR-109 task 2.1, ADR-0273); `executeCommandIntent`
  // carries that body.
  commandIntents: { compact: { supported: true } },
  features: {
    /** Claude loads named skills from `.claude/skills/` (SDK `Options.skills`). */
    claudeSkills: true,
    /** Claude's pre/post/session hook events stream through tool call cards. */
    claudeHooks: true,
    /** Claude scans `.claude/commands/` and the SDK's slash-command registry. */
    claudeSlashCommands: true,
  },
};

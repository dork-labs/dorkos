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
  supportsQuestionPrompt: true,
  supportsPlugins: true,
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
        promise: 'Runs everything without asking, including outside this project.',
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

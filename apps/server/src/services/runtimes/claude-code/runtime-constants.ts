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
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        description: 'Auto-accept file edits; still prompt for other tools.',
      },
      {
        id: 'plan',
        label: 'Plan',
        description: 'Read-only planning mode — the agent cannot execute tools.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        description: 'Skip all tool approval prompts — use only in trusted contexts.',
      },
      {
        id: 'auto',
        label: 'Auto',
        description:
          'A safety classifier approves or denies tool calls automatically — fewer interruptions on long autonomous runs. Research preview.',
      },
    ],
  },
  // Phase-1 placeholder — Phase 2 (DOR-109 task 2.1) flips this to true once the
  // bare `/compact` fulfillment body lands.
  commandIntents: { compact: { supported: false } },
  features: {
    /** Claude loads named skills from `.claude/skills/` (SDK `Options.skills`). */
    claudeSkills: true,
    /** Claude's pre/post/session hook events stream through tool call cards. */
    claudeHooks: true,
    /** Claude scans `.claude/commands/` and the SDK's slash-command registry. */
    claudeSlashCommands: true,
  },
};

/**
 * Static configuration for the Claude Code runtime — capability flags.
 *
 * @module services/runtimes/claude-code/runtime-constants
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/** Static Claude Code capabilities — all features are supported. */
export const CLAUDE_CODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsPermissionModes: true,
  supportedPermissionModes: [
    'default',
    'plan',
    'acceptEdits',
    'dontAsk',
    'bypassPermissions',
    'auto',
  ],
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsQuestionPrompt: true,
};

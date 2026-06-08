/**
 * Static configuration for the Test-Mode runtime — capability flags.
 *
 * Deliberately DIFFERENT from `CLAUDE_CODE_CAPABILITIES` (different
 * permission-mode ids, different `features` payload, more `false` booleans).
 * The divergence exists to catch client code that hardcodes Claude-shaped
 * assumptions instead of reading capabilities descriptors — see ADR 0256.
 *
 * @module services/runtimes/test-mode/runtime-constants
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/**
 * Static Test-Mode capabilities.
 *
 * Permission-mode ids (`always-allow`, `always-deny`, `scripted`) do NOT
 * overlap with Claude's ids — any UI that still renders a hardcoded Claude
 * permission-mode list will fail visibly when a test-mode session is active.
 *
 * `features.testModeScenarios` lists the scenario keys that the built-in
 * scenario store actually serves (see `scenario-store.ts`). Keep these in
 * sync with `BUILT_IN_SCENARIOS` — adding a scenario there should extend
 * this list, and removing one should remove it here.
 */
export const TEST_MODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'test-mode',
  // Emulates session resume so round-trip integration tests can exercise it.
  supportsResume: true,
  supportsMcp: false,
  supportsCostTracking: false,
  // Test-mode uses approval events to drive deterministic scenario scripts.
  supportsToolApproval: true,
  supportsQuestionPrompt: false,
  // Capability-gated: asClaudePluginTransport() returns null for this runtime.
  supportsPlugins: false,
  permissionModes: {
    supported: true,
    default: 'always-allow',
    values: [
      {
        id: 'always-allow',
        label: 'Always allow',
        description: 'Deterministic allow for integration tests.',
      },
      {
        id: 'always-deny',
        label: 'Always deny',
        description: 'Deterministic deny for integration tests.',
      },
      {
        id: 'scripted',
        label: 'Scripted',
        description: 'Follow a test-scenario script for approvals.',
      },
    ],
  },
  features: {
    /**
     * Scenario keys served by the built-in `scenario-store`. Keys here MUST
     * match `BUILT_IN_SCENARIOS` entries — do not invent names.
     */
    testModeScenarios: ['simple-text', 'tool-call', 'todo-write', 'error'],
    /** Artificial per-event latency used by the fake stream generators. */
    deterministicLatencyMs: 0,
  },
};

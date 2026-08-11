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
  supportsManagedMcpServers: false,
  supportsCostTracking: false,
  // Test-mode uses approval events to drive deterministic scenario scripts.
  supportsToolApproval: true,
  supportsQuestionPrompt: false,
  // Capability-gated: asClaudePluginTransport() returns null for this runtime.
  supportsPlugins: false,
  // `false` while the contract is types only (spec `persistent-session-runtime`
  // P2). Test-mode exists to exercise the contract deterministically, so it is
  // the runtime that flips these first once there is behavior to exercise.
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  // Test-mode injects nothing natively; the assembler bag is rendered verbatim.
  nativeContext: [],
  // Stateless: completed history lives only in the DorkOS EventLog, so the
  // platform persists it durably (DOR-189) — the conformance/e2e vehicle.
  logBackedHistory: true,
  permissionModes: {
    supported: true,
    default: 'always-allow',
    // These three ids are deliberately outside `PermissionModeSchema` — that is
    // the point of them (see the module note above), and they are settable:
    // `PATCH /api/sessions/:id` takes any well-formed id and asks the session's
    // OWN runtime whether it declares it (DOR-811), so this list is what makes
    // these modes real. `PermissionModeSchema` remains the narrower shared enum
    // for everything that still speaks in Claude-shaped names.
    values: [
      {
        id: 'always-allow',
        label: 'Always allow',
        description: 'Deterministic allow for integration tests.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Approves every request without asking. For tests only.',
      },
      {
        id: 'always-deny',
        label: 'Always deny',
        description: 'Deterministic deny for integration tests.',
        stop: 'ask',
        asks: 'always',
        reach: 'read',
        promise: 'Refuses every request. For tests only.',
      },
      {
        id: 'scripted',
        label: 'Scripted',
        description: 'Follow a test-scenario script for approvals.',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: "Answers each request the way the test scenario's script says. For tests only.",
      },
    ],
  },
  // `configSection: null` because test-mode is a real runtime with NO section
  // under `runtimes.*` in user config — which is why it must stay absent from
  // `executionDefaults.perRuntime[]`. No effort, no bespoke sections.
  settings: { configSection: null, supportsEffort: false, sections: [] },
  // Test-mode fulfills `compact` by yielding a synthetic `compact_boundary`
  // (DOR-109 task 2.3) — the deterministic e2e/conformance vehicle for
  // per-runtime intent gating.
  commandIntents: { compact: { supported: true } },
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

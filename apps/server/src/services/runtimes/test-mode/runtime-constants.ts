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
  // True since DOR-1214: the `question-prompt` scenario emits a real
  // `question_prompt` and PARKS on the answer, which `submitAnswers` delivers.
  // It was `false` while `submitAnswers` was a stub returning `false`, and that
  // was the honest declaration then — a runtime must not claim an interaction it
  // cannot complete. Now it can, so it says so.
  supportsQuestionPrompt: true,
  // Capability-gated: asClaudePluginTransport() returns null for this runtime.
  supportsPlugins: false,
  // `true` since DOR-1326: test-mode can hold a scripted process across a
  // session's turns (`held-process.ts`), which is all this flag denotes — the
  // ADAPTER's ability, never a claim that every session does. Whether a given
  // session does is its own opt-in, exactly as claude-code's is the operator's
  // `runtimes.claudeCode.persistentSession`; here it is `POST /api/test/persistent`,
  // named per session so one Playwright project cannot warm a neighbour's.
  //
  // It was `false`, and honestly so while nothing here held anything. What that
  // cost was the one shape the persistent path keeps getting wrong: a capable
  // RUNTIME paired with an INCAPABLE session (DOR-1268, DOR-1307). No browser
  // test could stage it, because the only free runtime declared the whole idea
  // away — so `getSessionWarmth`, `canSteerSession` and `canStageSession` now
  // answer per session and vary, which is what makes that pairing reachable.
  supportsPersistentSession: true,
  // Both `true` (spec `persistent-session-runtime` P4). The per-runtime flags say
  // the adapter can do each; `canSteerSession` / `canStageSession` say whether
  // the mechanism is under a GIVEN session, and for test-mode both ride the held
  // process — a session on the resume path is neither steerable nor stageable,
  // and degrades exactly as claude-code's does. `deliverIntoTurn` returns a
  // truthful receipt for each; the dispatcher mints the `turn_input` /
  // `context_staged` that surface them (task 4.4).
  supportsSteer: true,
  supportsContextStaging: true,
  // Test-mode injects nothing natively; the assembler bag is rendered verbatim.
  nativeContext: [],
  // Stateless: completed history lives only in the DorkOS EventLog, so the
  // platform persists it durably (DOR-189) — the conformance/e2e vehicle.
  logBackedHistory: true,
  // Scripted turns carry no media, so there is none to keep. Not a gap — an
  // accurate description of a runtime that exists to drive e2e scenarios.
  mediaOutput: 'none',
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
    // The simulator has no real transport constraint to mirror — declared
    // explicitly (true, also the default) so a conformance/e2e run can exercise
    // the deny-reason field the same way a real runtime with one does (DOR-825).
    denyReason: true,
  },
  // `configSection: null` because test-mode is a real runtime with NO section
  // under `runtimes.*` in user config — which is why it must stay absent from
  // `executionDefaults.perRuntime[]`. No effort, no bespoke sections.
  settings: { configSection: null, supportsEffort: false, sections: [] },
  // Test-mode fulfills `compact` by yielding a synthetic compaction in the
  // Claude adapter's shape — progress `started`, a `compact_boundary` carrying
  // real token readings, progress `done` (DOR-109 task 2.3, DOR-1215) — the
  // deterministic e2e/conformance vehicle for per-runtime intent gating.
  commandIntents: { compact: { supported: true } },
  features: {
    /**
     * Scenario keys served by the built-in `scenario-store`. Keys here MUST
     * match `BUILT_IN_SCENARIOS` entries — do not invent names.
     *
     * This is the ADVERTISED list, not the whole registry. The `demo-*`,
     * `q3-*`, `long-turn` and interactive (DOR-1214) families are all served and
     * all deliberately absent: each is a fixture a specific harness names
     * explicitly via `POST /api/test/scenario`, never something a reader picks
     * from a list.
     *
     * **The test for adding one is whether a chooser could be left stranded by
     * it, not which family it belongs to.** A scenario that BLOCKS — parked on
     * an approval, an answer, or a step barrier only its own test releases —
     * must stay out: offered as a general-purpose choice it would hang whoever
     * picked it, with no affordance in the list to say so. A scenario that runs
     * to completion on its own is safe to advertise on its merits, whatever file
     * it lives in. So a new self-contained scenario may be added here; a new
     * gated one may not.
     */
    testModeScenarios: [
      'simple-text',
      'tool-call',
      'todo-write',
      'error',
      'long-turn',
      'compacting',
      'compacting-hold',
    ],
    /** Artificial per-event latency used by the fake stream generators. */
    deterministicLatencyMs: 0,
  },
};

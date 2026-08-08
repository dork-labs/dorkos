import { afterEach } from 'vitest';
import { runtimeConformance } from '@dorkos/test-utils';
import { scenarioStore } from '../scenario-store.js';
import { TestModeRuntime } from '../test-mode-runtime.js';
import {
  driveDurableTurn,
  drivePresenceTurn,
} from '../../../session/__tests__/durable-turn-harness.js';

// The failing factory below flips the module-level scenario store's DEFAULT,
// so restore it after every test: the passing tests rely on 'simple-text'.
afterEach(() => {
  scenarioStore.reset();
});

// Purpose: TestModeRuntime is the reference "passing" runtime for the shared
// AgentRuntime conformance suite (spec additional-agent-runtimes, task 1.5).
// The adapter is stateless and EventLog-backed, so green here proves the suite
// itself bakes in no JSONL/file assumptions — the same assertions must also
// pass against the JSONL-backed ClaudeCodeRuntime (see its conformance.test.ts).
runtimeConformance(() => new TestModeRuntime(), {
  name: 'TestModeRuntime — AgentRuntime conformance',
  // Stateless by design: native history is [] — completed messages live in the
  // DorkOS-owned EventLog, not the runtime (ADR-0263).
  expectHistory: false,
  // The one runtime allowed to default to autonomy: `always-allow` IS the
  // fixture. Nothing a person drives runs on it — it exists so e2e and
  // conformance runs never wait on an approval card.
  autonomyDefaultReason:
    'test-mode exists to answer every approval deterministically; always-allow is its whole purpose',
  // Turn failure rides the scenario store: the built-in 'error' scenario is
  // the runtime's production failing turn (typed error, then terminal done).
  makeFailingRuntime: () => {
    scenarioStore.setDefault('error');
    return new TestModeRuntime();
  },
  // DOR-189: a completed turn must survive a restart via the durable store.
  durableHistory: (runtime, sessionId, content) =>
    driveDurableTurn(runtime, sessionId, content, '/projects/conformance'),
  // Presence is only assertable against a turn that really runs: drive one
  // through the same projector the trigger path feeds.
  presenceTurn: (runtime, sessionId, content, probes) =>
    drivePresenceTurn(runtime, sessionId, content, '/projects/conformance', probes),
});

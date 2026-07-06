import { afterEach } from 'vitest';
import { runtimeConformance } from '@dorkos/test-utils';
import { scenarioStore } from '../scenario-store.js';
import { TestModeRuntime } from '../test-mode-runtime.js';

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
  // Turn failure rides the scenario store: the built-in 'error' scenario is
  // the runtime's production failing turn (typed error, then terminal done).
  makeFailingRuntime: () => {
    scenarioStore.setDefault('error');
    return new TestModeRuntime();
  },
});

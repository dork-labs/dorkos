import { afterEach, expect, vi } from 'vitest';
import { runtimeConformance } from '@dorkos/test-utils';
import { scenarioStore, requestFinishTurn } from '../scenario-store.js';
import { interactionGate } from '../interaction-gate.js';
import { TestModeRuntime } from '../test-mode-runtime.js';
import {
  driveDurableTurn,
  drivePresenceTurn,
  driveDispositionTurn,
  driveTerminalOnce,
  driveQueueDurability,
} from '../../../session/__tests__/durable-turn-harness.js';

// The failing and compacting factories below each flip the module-level
// scenario store's DEFAULT, so restore it after every test: the passing tests
// rely on 'simple-text'.
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
  // Compaction rides the scenario store too: the built-in 'compacting'
  // scenario is a turn that compacts instead of answering, which is what an
  // AUTO compaction looks like. Wiring it activates the suite's
  // operation_progress block (DOR-110), which had no runtime driving it here —
  // test-mode is the only adapter that can reach it without a real model.
  makeCompactingRuntime: () => {
    scenarioStore.setDefault('compacting');
    return new TestModeRuntime();
  },
  // DOR-189: a completed turn must survive a restart via the durable store.
  durableHistory: (runtime, sessionId, content) =>
    driveDurableTurn(runtime, sessionId, content, '/projects/conformance'),
  // Presence is only assertable against a turn that really runs: drive one
  // through the same projector the trigger path feeds.
  presenceTurn: (runtime, sessionId, content, probes) =>
    drivePresenceTurn(runtime, sessionId, content, '/projects/conformance', probes),
  // C1 declared arm: test-mode declares BOTH steer and stage, so it owes the
  // suite a turn held open to deliver into. The `long-turn` scenario streams a
  // heartbeat and stays `streaming` with no pending interaction — which keeps
  // `interactionGate.isOpen` true, the exact gate deliverIntoTurn(steer) reads —
  // and `requestFinishTurn` ends it. The default is restored by the afterEach.
  dispositionTurn: (runtime, sessionId, content, probes) => {
    scenarioStore.setDefault('long-turn');
    return driveDispositionTurn(runtime, sessionId, content, '/projects/conformance', probes, {
      awaitOpen: () => vi.waitFor(() => expect(interactionGate.isOpen(sessionId)).toBe(true)),
      endTurn: () => requestFinishTurn(),
    });
  },
  // C2/C3 are server-owned invariants every runtime inherits by construction,
  // driven through the shared machinery rather than test-mode itself.
  terminalOnce: () => driveTerminalOnce('/projects/conformance'),
  queueDurability: () => driveQueueDurability(),
  // BC-16: test-mode keeps session metadata in memory for one process lifetime
  // and writes no transcript, so it has nothing durable to read a person's last
  // message back out of — and being the fixture that omits the field is what
  // keeps the omission half of this contract exercised.
  userLastMessageAtOmittedReason:
    'test-mode holds session metadata in memory for a single process lifetime and keeps no transcript, so there is nothing durable to derive the person’s last message from',
});

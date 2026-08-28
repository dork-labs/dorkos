import { afterEach, expect, vi } from 'vitest';
import { runtimeConformance } from '@dorkos/test-utils';
import { scenarioStore, requestFinishTurn } from '../scenario-store.js';
import { heldProcesses } from '../held-process.js';
import { interactionGate } from '../interaction-gate.js';
import { TestModeRuntime } from '../test-mode-runtime.js';
import {
  driveDurableTurn,
  driveExpiredQuestionTurn,
  drivePresenceTurn,
  driveDispositionTurn,
  driveTerminalOnce,
  driveQueueDurability,
} from '../../../session/__tests__/durable-turn-harness.js';

// The failing and compacting factories below each flip the module-level
// scenario store's DEFAULT, so restore it after every test: the passing tests
// rely on 'simple-text'. The warmth and disposition drivers put their session on
// the held-process path, which is per-session module state for the same reason —
// give every process back so no case inherits another's warm session.
afterEach(() => {
  scenarioStore.reset();
  heldProcesses.reset();
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
  // The `project-rooms` §3.3 gate has nothing to grip here, and that is the
  // fixture's nature rather than a gap: a scripted scenario answers from a
  // table, so there is no model a system prompt could reach and no backend
  // input to read the append off. The three production runtimes prove the
  // property; saying so beats a case that quietly asserts nothing.
  systemPromptAppendUnprovenReason:
    'test-mode answers from a scripted scenario table — there is no model to give a system prompt to, and no backend input a caller’s append could be read off',
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
  // DOR-1293: a question NOBODY answers. The `question-expires` scenario parks
  // on a step barrier standing in for the ten-minute clock, then fires the same
  // `interaction_cancelled`/`timeout` the real handler does — so what the suite
  // reads back is the production fold, not a hand-written outcome. Polling
  // rather than firing blind: `interactionGate.step` answers false until the
  // scenario has actually parked, and a dropped step hangs the turn forever.
  expiredQuestionHistory: (runtime, sessionId, content) => {
    scenarioStore.setForSession(sessionId, 'question-expires');
    return driveExpiredQuestionTurn(runtime, sessionId, content, '/projects/conformance', () =>
      vi.waitFor(() => expect(interactionGate.step(sessionId)).toBe(true))
    );
  },
  // Presence is only assertable against a turn that really runs: drive one
  // through the same projector the trigger path feeds.
  presenceTurn: (runtime, sessionId, content, probes) =>
    drivePresenceTurn(runtime, sessionId, content, '/projects/conformance', probes),
  // Test-mode declares `supportsPersistentSession`, so it owes the suite a way
  // to reach WARM (C4/C5/C8). Turning the per-session opt-in on is the driver's
  // job — the capability says this adapter CAN hold a process across turns, and
  // whether a given session does is its own switch (`POST /api/test/persistent`
  // in the browser leg, this call here).
  //
  // One drained turn is all it takes: the process is booted at the turn's start
  // and handed back WARM when the generator finishes, so unlike claude-code
  // there is no long-lived double to swap in.
  warmSession: async (runtime, sessionId) => {
    heldProcesses.setEnabled(sessionId, true);
    for await (const _event of runtime.sendMessage(sessionId, 'conformance ping', {
      cwd: '/projects/conformance',
    })) {
      // Drained rather than inspected: this driver's job is to LEAVE the session
      // warm, and the suite makes its own assertions afterwards.
    }
  },
  // C1 declared arm: test-mode declares BOTH steer and stage, so it owes the
  // suite a turn held open to deliver into. Two things have to be true at once,
  // and the driver arranges both: the session must be on the held-process path
  // (a steer pushes into the process, and a session holding none refuses exactly
  // as claude-code's resume path does), and a turn must genuinely be open. The
  // `long-turn` scenario streams a heartbeat and stays `streaming` with no
  // pending interaction — which keeps `interactionGate.isOpen` true, the second
  // gate deliverIntoTurn(steer) reads — and `requestFinishTurn` ends it. Both
  // module-level switches are restored by the afterEach.
  dispositionTurn: (runtime, sessionId, content, probes) => {
    scenarioStore.setDefault('long-turn');
    heldProcesses.setEnabled(sessionId, true);
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

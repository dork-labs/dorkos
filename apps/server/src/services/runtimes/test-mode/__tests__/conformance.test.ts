import {
  DOC_VISIBLE_TRIGGER,
  DOC_PRIVATE_MARKER,
  docBoundaryEntry,
  assertDocBoundary,
} from '../../__tests__/doc-events-boundary-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { runtimeConformance } from '@dorkos/test-utils';
import { scenarioStore, requestFinishTurn } from '../scenario-store.js';
import { heldProcesses } from '../held-process.js';
import { interactionGate } from '../interaction-gate.js';
import { TestModeRuntime } from '../test-mode-runtime.js';
import {
  driveDurableTurn,
  driveExpiredQuestionTurn,
  driveRoomCanvasTurn,
  drivePresenceTurn,
  driveDispositionTurn,
  driveApprovalTurn,
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
  // The `agent-home-desk` §4.6 gate, for the same reason: no backend holds a
  // file tool, so there is nothing a folder grant could be handed to.
  directoryGrantsUnprovenReason:
    'test-mode answers from a scripted scenario table — it has no file tools and no backend a folder grant could be handed to',
  // ADR 261001-000811's credits negatives, for the same reason: test-mode
  // declares no credits and starts no backend, so there is no environment or
  // request a token could reach.
  creditsUnprovenReason:
    'test-mode answers from a scripted scenario table — it starts no backend and has no environment or request a credits token could reach',
  // The one runtime allowed to repeat its trigger: `simple-text` answers
  // `Echo: <content>`, and that determinism is the fixture's entire job — the
  // browser suite asserts on it (`apps/e2e/tests/chat-mock.spec.ts`). Only the
  // trigger half is waived; test-mode must still never stream an injected
  // context block back, and it does not.
  echoesTriggerReason:
    'test-mode answers `Echo: <content>` by design — a scripted fixture whose determinism the browser tests assert on, with no model that could have been prompted',
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
  // DOR-2732: the `context-reading` scenario reports tokens and window.
  contextReadingTurn: async () => {
    scenarioStore.setDefault('context-reading');
    const runtime = new TestModeRuntime();
    const sessionId = 'context-reading-conformance';
    runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/conformance' });
    const events = [];
    for await (const event of runtime.sendMessage(sessionId, 'conformance ping', {
      cwd: '/projects/conformance',
    })) {
      events.push(event);
    }
    return events;
  },
  // DOR-2732: a summary somebody asked for. test-mode's compact intent is the
  // fake that records the request and answers with a synthetic boundary.
  compactIntentTurn: async (observe) => {
    const runtime = new TestModeRuntime();
    const sessionId = 'compact-intent-conformance';
    runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/conformance' });
    for await (const _event of runtime.sendMessage(sessionId, 'conformance ping', {
      cwd: '/projects/conformance',
    })) {
      // the conversation the summary runs on
    }
    const events = [];
    for await (const event of runtime.executeCommandIntent(sessionId, 'compact', {
      cwd: '/projects/conformance',
    })) {
      events.push(event);
      observe?.(runtime, sessionId);
    }
    return events;
  },
  // A room turn that puts a document on the room's shared canvas (spec
  // `room-canvas`). Test-mode is the runtime that makes this case FREE: the
  // scenario yields an ordinary, unstamped `ui_command`, which is exactly the
  // set the room turn's collector owns — so the whole path from a turn's event
  // to a row, a frame and one line in the log runs with no model and no
  // credential.
  roomCanvasTurn: () => {
    scenarioStore.setDefault('rooms-open-canvas');
    return driveRoomCanvasTurn({
      runtime: 'claude-code',
      testMode: true,
      createRuntime: ({ principals }) => new TestModeRuntime('claude-code', principals),
    });
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
  // A card answered, denied or stopped (spec `codex-app-server-transport`
  // §17): the `approval-gated` scenario parks on its approval and runs its
  // tool only when approved, ending it `error` when denied.
  approvalTurn: (runtime, sessionId, content, probes) => {
    scenarioStore.setForSession(sessionId, 'approval-gated');
    // Answerable once the scenario has parked on the card, a step after it.
    return driveApprovalTurn(runtime, sessionId, content, '/projects/conformance', probes, (card) =>
      vi.waitFor(() =>
        expect(interactionGate.pendingInteractionIds(sessionId)).toContain(card.toolCallId)
      )
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

it('doc SDK boundary: test-mode passes original structured context and fenced data to its scenario', async () => {
  const requests: Array<{ content: string; prompt: string; structured: unknown }> = [];
  const spy = vi
    .spyOn(scenarioStore, 'getScenario')
    .mockReturnValue(async function* (content, ctx, opts) {
      requests.push({
        content,
        prompt: ctx.docEventsPrompt ?? '',
        structured: opts?.additionalContext,
      });
      yield { type: 'done', data: {} };
    });
  try {
    const runtime = new TestModeRuntime();
    runtime.ensureSession('doc-sdk-boundary', {
      cwd: '/projects/conformance',
      permissionMode: 'default',
    });
    for (let turn = 0; turn < 2; turn++) {
      for await (const _event of runtime.sendMessage('doc-sdk-boundary', DOC_VISIBLE_TRIGGER, {
        additionalContext: [docBoundaryEntry],
      })) {
        /* Drain actual scenario invocation. */
      }
    }
    expect(requests).toHaveLength(2);
    const nonces = requests.map((request) => {
      expect(request.content).toBe(DOC_VISIBLE_TRIGGER);
      expect(request.content).not.toContain(DOC_PRIVATE_MARKER);
      expect(request.structured).toEqual([docBoundaryEntry]);
      return assertDocBoundary(request.prompt);
    });
    expect(nonces[0]).not.toBe(nonces[1]);
  } finally {
    spy.mockRestore();
  }
});

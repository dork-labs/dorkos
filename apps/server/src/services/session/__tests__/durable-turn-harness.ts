/**
 * Shared conformance support: drive ONE real turn of a runtime through the
 * ACTUAL trigger path — `getOrCreateProjector` → `feedProjector` — the way
 * `POST /api/sessions/:id/messages` does, and let a conformance suite observe
 * the result.
 *
 * Two harnesses, both injected into `runtimeConformance` as opts because
 * `packages/test-utils` cannot import server internals:
 *
 * - {@link driveDurableTurn} (`durableHistory`) proves history survives a
 *   restart for a log-backed runtime (DOR-189).
 * - {@link drivePresenceTurn} (`presenceTurn`) opens a turn, hands control back
 *   while it is OPEN, and again once it has closed — the only way the presence
 *   assertions can watch a lifecycle actually transition. A runtime's own
 *   `sendMessage` generator moves no projector by itself (it is a pure event
 *   producer), so a presence case driven off `sendMessage` alone reads `idle`
 *   for every runtime at every moment and asserts nothing.
 *
 * Not a test file (no `.test.ts` suffix) — a test-support module only.
 *
 * @module services/session/__tests__/durable-turn-harness
 */
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { HistoryMessage, StreamEvent } from '@dorkos/shared/types';
import {
  SessionEventStore,
  setSessionEventStore,
  getOrCreateProjector,
  disposeProjector,
  feedProjector,
  readLogBackedHistory,
} from '../index.js';

/**
 * Run one complete turn of `runtime` through a persistence-enabled projector
 * backed by a fresh in-memory store, drop the live projector (the server-restart
 * analog), and return the history reconstructed durably from the store.
 *
 * @param runtime - The log-backed runtime under test (its real `sendMessage`)
 * @param sessionId - A unique session id for this turn
 * @param content - The user message to send
 * @param cwd - The working directory for the turn
 */
export async function driveDurableTurn(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  cwd: string
): Promise<HistoryMessage[]> {
  const store = new SessionEventStore(createTestDb());
  setSessionEventStore(store);
  try {
    const projector = getOrCreateProjector(sessionId, cwd, { persist: 'history' });
    await feedProjector(projector, runtime.sendMessage(sessionId, content, { cwd }), {
      userMessage: content,
    });
    // Restart analog: the live projector is gone; history must read durably.
    disposeProjector(sessionId);
    return readLogBackedHistory(sessionId);
  } finally {
    setSessionEventStore(undefined);
  }
}

/**
 * Yield every event of `source`, calling `probe` exactly once while the turn is
 * still OPEN.
 *
 * The probe fires after the consumer has ingested the first event — a `yield`
 * resumes only when the consumer asks for the next item, so by then
 * `feedProjector` has projected both its synthesized `turn_start` and that
 * event. The `done` case is special: it CLOSES the turn, so the probe runs
 * before it is handed over. A stream that ends without yielding anything is
 * probed after the loop, still ahead of `feedProjector`'s closing `finally`.
 *
 * @param source - The runtime's own StreamEvent generator for one turn.
 * @param probe - Called once, with the turn open.
 */
async function* probeWhileOpen(
  source: AsyncIterable<StreamEvent>,
  probe: () => Promise<void>
): AsyncGenerator<StreamEvent> {
  let probed = false;
  for await (const event of source) {
    if (!probed && event.type === 'done') {
      await probe();
      probed = true;
    }
    yield event;
    if (!probed) {
      await probe();
      probed = true;
    }
  }
  if (!probed) await probe();
}

/**
 * Run one complete turn of `runtime` through the projector the trigger path
 * feeds, pausing to let the caller read the runtime's presence twice: once
 * with the turn OPEN, once after it has closed.
 *
 * The projector is created here — the same module-global registry entry the
 * runtime's own `getSessionSnapshot` resolves — so what the caller reads is the
 * adapter answering about a turn that is genuinely running. Disposed at the end
 * so no live projection outlives the test.
 *
 * @param runtime - The runtime under test (its real `sendMessage`).
 * @param sessionId - A unique session id for this turn.
 * @param content - The user message to send.
 * @param cwd - The working directory for the turn.
 * @param probes.midTurn - Called once with the turn open.
 * @param probes.afterTurn - Called once after the turn has closed.
 */
export async function drivePresenceTurn(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  cwd: string,
  probes: { midTurn: () => Promise<void>; afterTurn: () => Promise<void> }
): Promise<void> {
  const projector = getOrCreateProjector(sessionId, cwd);
  try {
    await feedProjector(
      projector,
      probeWhileOpen(runtime.sendMessage(sessionId, content, { cwd }), probes.midTurn),
      { userMessage: content }
    );
    await probes.afterTurn();
  } finally {
    disposeProjector(sessionId);
  }
}

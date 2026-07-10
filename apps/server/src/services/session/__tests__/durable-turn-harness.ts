/**
 * Shared conformance support: drive ONE real turn of a log-backed runtime
 * through the actual projector → durable store → read-back path, then return
 * the reconstructed history (DOR-189). Used by the codex/opencode/test-mode
 * conformance suites via `runtimeConformance({ durableHistory })` so each
 * proves the durability contract through its own real `sendMessage`.
 *
 * Not a test file (no `.test.ts` suffix) — a test-support module only.
 *
 * @module services/session/__tests__/durable-turn-harness
 */
import { createTestDb } from '@dorkos/test-utils/db';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { HistoryMessage } from '@dorkos/shared/types';
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
    const projector = getOrCreateProjector(sessionId, cwd, { persist: true });
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

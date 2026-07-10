import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  SessionEventStore,
  setSessionEventStore,
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
  readLogBackedHistory,
} from '../index.js';
import type { RawSessionEvent } from '../session-state-projector.js';

/**
 * Restart-simulation integration test — the executable form of the DOR-189
 * acceptance criterion ("start a session → restart the server → history still
 * opens"). Dropping a projector from the module-global registry is the restart
 * analog: a real restart re-creates that registry empty. Because all log-backed
 * runtimes share this one projector + store mechanism, proving it here proves
 * it for codex, opencode, and test-mode alike.
 */

let sessionSeq = 0;
function nextId(): string {
  sessionSeq += 1;
  return `durable-restart-${sessionSeq}`;
}

function driveTurn(sessionId: string, userMessage: string, text: string): void {
  const p = getOrCreateProjector(sessionId, '/projects/x', { persist: true });
  p.ingest({ type: 'turn_start', userMessage } as RawSessionEvent);
  p.ingest({ type: 'text_delta', text } as RawSessionEvent);
  p.ingest({ type: 'turn_end' } as RawSessionEvent);
}

describe('durable session history survives a restart (DOR-189)', () => {
  beforeEach(() => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
  });
  afterEach(() => {
    setSessionEventStore(undefined);
  });

  it('reconstructs completed history from the store with NO live projector', () => {
    const id = nextId();
    driveTurn(id, 'first question', 'first answer');
    driveTurn(id, 'second question', 'second answer');

    // Pre-restart, history is already durable (read from the store).
    expect(readLogBackedHistory(id)).toHaveLength(4);

    // Restart analog: drop the projector. The registry is now empty for this id.
    disposeProjector(id);
    expect(peekProjector(id)).toBeUndefined();

    // The bug this fixes: history used to be [] here (peekProjector → []).
    const history = readLogBackedHistory(id);
    expect(history.map((m) => m.id)).toEqual(['user-1', 'assistant-1', 'user-4', 'assistant-4']);
    expect(history[0]!.content).toBe('first question');
    expect(history[1]!.content).toBe('first answer');
  });

  it('a revived projector hydrates with stable seq continuity after the restart', () => {
    const id = nextId();
    driveTurn(id, 'q', 'a');
    disposeProjector(id); // restart

    // A fresh /events subscribe or snapshot re-mints the projector with persist.
    const revived = getOrCreateProjector(id, '/projects/x', { persist: true });
    expect(revived.replayFrom(0).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(revived.getCursor()).toBe(3);
    // The next turn continues monotonically — ids never collide with pre-restart ones.
    const next = revived.ingest({ type: 'turn_start', userMessage: 'q2' } as RawSessionEvent);
    expect(next.seq).toBe(4);
    disposeProjector(id);
  });

  it('a NON-persisted (claude-code-style) projector writes nothing durable', () => {
    const id = nextId();
    const p = getOrCreateProjector(id, '/projects/x'); // no persist flag
    p.ingest({ type: 'turn_start', userMessage: 'q' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);
    disposeProjector(id); // restart

    // Nothing was persisted, so after the restart there is no durable history.
    expect(readLogBackedHistory(id)).toEqual([]);
  });
});

/**
 * A turn in an agent's Direct chat carries what reached the chat outside it
 * (rule S12, DOR-2997), and a room turn never does: it reads its room through
 * its own context.
 *
 * Driven through the real `triggerTurn`, with a runtime that only records what
 * it was handed, because the claim is about the bag a runtime receives.
 *
 * @module server/services/session/__tests__/trigger-turn-direct-notes
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdditionalContext, DirectNotesData } from '@dorkos/shared/additional-context';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';
import { triggerTurn, type TriggerTurnOpts } from '../trigger-turn.js';
import { setDirectNotesSource } from '../context-assembler.js';

const SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const NOTES: DirectNotesData = {
  withName: 'Dorian',
  notes: [{ at: '2026-10-17T12:00:00.000Z', from: 'Ana', fromYou: true, text: 'need your OK' }],
  omitted: 0,
};

/** Run one turn and answer the context bag the runtime was handed. */
async function bagFor(extra: Partial<TriggerTurnOpts> = {}): Promise<AdditionalContext> {
  const seen: AdditionalContext[] = [];
  const projector = getOrCreateProjector(SESSION, '/projects/test');
  const result = await triggerTurn({
    sessionId: SESSION,
    clientId: 'test-client',
    content: 'yes, go ahead',
    cwd: '/projects/test',
    projector,
    ...extra,
    deps: {
      acquireLock: () => true,
      releaseLock: () => {},
      sendMessage: (_sid, _text, opts) => {
        seen.push(opts?.additionalContext ?? []);
        return (async function* () {})();
      },
      interruptQuery: async () => ({ outcome: 'not-running', runtime: 'fake' }),
      getInternalSessionId: () => undefined,
      rekeyProjector: () => {},
      getCapabilities: () => ({ nativeContext: [] }) as never,
    },
  });
  expect(result.accepted).toBe(true);
  await vi.waitFor(() => expect(seen).toHaveLength(1));
  return seen[0];
}

afterEach(() => {
  setDirectNotesSource(undefined);
  disposeProjector(SESSION);
});

describe('a turn in a Direct chat', () => {
  it('carries the notes the chat holds for it', async () => {
    const asked: string[] = [];
    setDirectNotesSource((id) => {
      asked.push(id);
      return NOTES;
    });

    const bag = await bagFor();

    expect(bag.find((entry) => entry.kind === 'direct_notes')?.data).toEqual(NOTES);
    expect(asked).toContain(SESSION);
  });

  it('carries nothing when the chat holds nothing, or the source fails', async () => {
    setDirectNotesSource(() => {
      throw new Error('database is locked');
    });

    const bag = await bagFor();

    expect(bag.some((entry) => entry.kind === 'direct_notes')).toBe(false);
  });

  it('never takes notes for a room turn, which reads its room itself', async () => {
    const source = vi.fn(() => NOTES);
    setDirectNotesSource(source);

    const bag = await bagFor({ roomContext: { room: { id: 'room-1' } } as RoomContextData });

    expect(source).not.toHaveBeenCalled();
    expect(bag.some((entry) => entry.kind === 'direct_notes')).toBe(false);
  });
});

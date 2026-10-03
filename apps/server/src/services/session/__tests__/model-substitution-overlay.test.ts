/**
 * A turn that ran on another model than its session names (DOR-2636) comes
 * back as a lasting notice when the conversation is reopened: recorded durably
 * the instant it is ingested, overlaid onto the runtime's own history.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { HistoryMessage } from '@dorkos/shared/types';
import {
  applyModelSubstitutions,
  overlayModelSubstitutions,
} from '../overlays/model-substitution-overlay.js';
import { SessionEventStore } from '../session-event-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  setSessionEventStore,
  type RawSessionEvent,
} from '../session-state-projector.js';
import { toRawSessionEvent } from '../session-event-normalizer.js';

let currentStore: SessionEventStore | undefined;
afterEach(() => {
  setSessionEventStore(undefined);
  currentStore = undefined;
  disposeProjector('sess');
});

/** The store the case under test installed. */
function getSessionEventStoreForTest(): SessionEventStore {
  if (!currentStore) throw new Error('no store installed');
  return currentStore;
}

const SWAP = {
  type: 'model_substituted',
  from: 'opus',
  fromName: 'Opus',
  to: 'md_suggested',
  toName: 'Suggested',
  reason: 'credits-not-covered',
} as const;

function message(
  id: string,
  role: 'user' | 'assistant',
  timestamp: string,
  content = 'text'
): HistoryMessage {
  return { id, role, content, timestamp } as HistoryMessage;
}

describe('the model substitution notice', () => {
  it('survives a reload, in the turn it opened: after the person’s message, before the reply', () => {
    currentStore = new SessionEventStore(createTestDb());
    setSessionEventStore(currentStore);
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    // An earlier turn on its own.
    projector.ingest({ type: 'turn_start', userMessage: 'first' } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    projector.ingest({ type: 'turn_start', userMessage: 'go on' } as RawSessionEvent);
    projector.ingest(SWAP as unknown as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    disposeProjector('sess');

    // The record is written at launch, a few hundred ms BEFORE the CLI dates
    // the person's message: a clock would put the notice above it.
    const recordedAt = Date.parse(
      getSessionEventStoreForTest().readModelSubstitutions('sess')[0]!.createdAt
    );
    const at = (ms: number) => new Date(recordedAt + ms).toISOString();
    const out = overlayModelSubstitutions('sess', [
      message('u-0', 'user', at(-60_000), 'first'),
      message('a-0', 'assistant', at(-59_000)),
      message('u-1', 'user', at(300), 'go on'),
      message('a-1', 'assistant', at(5_000)),
    ]);

    expect(out.map((m) => m.id)).toEqual([
      'u-0',
      'a-0',
      'u-1',
      expect.stringMatching(/^model-substituted-/),
      'a-1',
    ]);
    expect(out[3]!.parts).toEqual([
      {
        type: 'model_substituted',
        from: 'opus',
        fromName: 'Opus',
        to: 'md_suggested',
        toName: 'Suggested',
        reason: 'credits-not-covered',
      },
    ]);
  });

  it('finds the right turn when the person sent the same words twice', () => {
    const swapAt = (seq: number) => ({
      event: { ...SWAP, seq } as never,
      createdAt: '2026-10-01T10:00:00.000Z',
    });
    const out = applyModelSubstitutions(
      [
        message('u-1', 'user', '2026-10-01T09:00:00.000Z', 'continue'),
        message('a-1', 'assistant', '2026-10-01T09:00:01.000Z'),
        message('u-2', 'user', '2026-10-01T09:30:00.000Z', 'continue'),
        message('a-2', 'assistant', '2026-10-01T09:30:01.000Z'),
      ],
      [swapAt(5)],
      [
        { seq: 1, userMessage: 'continue' },
        { seq: 4, userMessage: 'continue' },
      ]
    );
    expect(out.map((m) => m.id)).toEqual([
      'u-1',
      'a-1',
      'u-2',
      expect.stringMatching(/^model-substituted-/),
      'a-2',
    ]);
  });

  it('falls back to the first message dated after it when its turn was never recorded', () => {
    const out = applyModelSubstitutions(
      [
        message('u-1', 'user', '2026-10-01T09:59:00.000Z'),
        message('a-1', 'assistant', '2026-10-01T09:59:01.000Z'),
        message('u-2', 'user', '2026-10-01T10:00:00.300Z'),
      ],
      [{ event: { ...SWAP, seq: 9 } as never, createdAt: '2026-10-01T10:00:00.000Z' }],
      []
    );
    expect(out.map((m) => m.id)).toEqual([
      'u-1',
      'a-1',
      'u-2',
      expect.stringMatching(/^model-substituted-/),
    ]);
  });

  it('survives a turn that never ends, and is not drawn twice while its turn is open', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'go' } as RawSessionEvent);
    projector.ingest(SWAP as unknown as RawSessionEvent);
    // Still open: the live stream draws it, so the overlay does not.
    expect(overlayModelSubstitutions('sess', [])).toEqual([]);
    // The process dies with the turn still open.
    disposeProjector('sess');
    expect(overlayModelSubstitutions('sess', [])).toHaveLength(1);
  });

  it('returns history by reference when there is nothing to add', () => {
    const messages = [message('a-1', 'assistant', '2026-10-01T10:00:00.000Z')];
    expect(applyModelSubstitutions(messages, [])).toBe(messages);
  });

  it('is forwarded whole from the runtime’s stream event', () => {
    expect(
      toRawSessionEvent({
        type: 'model_substituted',
        data: {
          from: 'opus',
          fromName: 'Opus',
          to: 'md_suggested',
          toName: 'Suggested',
          reason: 'credits-not-covered',
        },
      })
    ).toMatchObject(SWAP);
  });
});

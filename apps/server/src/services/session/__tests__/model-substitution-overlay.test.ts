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

afterEach(() => {
  setSessionEventStore(undefined);
  disposeProjector('sess');
});

const SWAP = {
  type: 'model_substituted',
  from: 'opus',
  fromName: 'Opus',
  to: 'md_suggested',
  toName: 'Suggested',
  reason: 'credits-not-covered',
} as const;

function message(id: string, role: 'user' | 'assistant', timestamp: string): HistoryMessage {
  return { id, role, content: 'text', timestamp } as HistoryMessage;
}

describe('the model substitution notice', () => {
  it('survives a reload, between the person’s message and the reply', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'go' } as RawSessionEvent);
    projector.ingest(SWAP as unknown as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    disposeProjector('sess');

    const now = Date.now();
    const out = overlayModelSubstitutions('sess', [
      message('u-1', 'user', new Date(now - 60_000).toISOString()),
      message('a-1', 'assistant', new Date(now + 60_000).toISOString()),
    ]);

    expect(out.map((m) => m.id)).toEqual([
      'u-1',
      expect.stringMatching(/^model-substituted-/),
      'a-1',
    ]);
    expect(out[1]!.parts).toEqual([
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

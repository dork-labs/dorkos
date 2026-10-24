/**
 * A log-backed runtime's rebuilt history carries real times (DOR-3074): a
 * person's message the moment its turn opened, a reply the moment its turn
 * finished, both from what the server recorded and never from when the history
 * happened to be read. Test-mode, Codex and OpenCode all rebuild through here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import {
  SessionEventStore,
  setSessionEventStore,
  getOrCreateProjector,
  disposeProjector,
  readLogBackedHistory,
} from '../index.js';
import { reconstructHistoryFromEvents } from '../event-log-history.js';
import { feedProjector } from '../session-event-normalizer.js';
import type { RawSessionEvent } from '../session-state-projector.js';

const SENT = Date.parse('2026-10-20T07:23:00.000Z');
const FINISHED = Date.parse('2026-10-20T07:23:40.000Z');
const READ = Date.parse('2026-10-20T08:13:00.000Z');

let n = 0;
const nextId = () => `history-times-${++n}`;

describe('log-backed history times', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    setSessionEventStore(new SessionEventStore(createTestDb()));
  });
  afterEach(() => {
    setSessionEventStore(undefined);
    vi.useRealTimers();
  });

  it('dates the message by when it was sent and the reply by when it finished, read later', () => {
    const id = nextId();
    const projector = getOrCreateProjector(id, '/projects/x', { persist: 'history' });
    vi.setSystemTime(SENT);
    projector.ingest({ type: 'turn_start', userMessage: 'ship it?', at: SENT } as RawSessionEvent);
    projector.ingest({ type: 'text_delta', text: 'shipped' } as RawSessionEvent);
    vi.setSystemTime(FINISHED);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);

    // Read back long after, as a reload does, with no live projector.
    disposeProjector(id);
    vi.setSystemTime(READ);
    const history = readLogBackedHistory(id);

    expect(history.map((m) => [m.role, m.timestamp])).toEqual([
      ['user', new Date(SENT).toISOString()],
      ['assistant', new Date(FINISHED).toISOString()],
    ]);
  });

  it('dates a turn recorded before turns carried their start by when it was saved', () => {
    const id = nextId();
    const projector = getOrCreateProjector(id, '/projects/x', { persist: 'history' });
    projector.ingest({ type: 'turn_start', userMessage: 'old turn' } as RawSessionEvent);
    projector.ingest({ type: 'text_delta', text: 'old reply' } as RawSessionEvent);
    vi.setSystemTime(FINISHED);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);

    vi.setSystemTime(READ);
    const history = readLogBackedHistory(id);

    expect(history.map((m) => m.timestamp)).toEqual([
      new Date(FINISHED).toISOString(),
      new Date(FINISHED).toISOString(),
    ]);
  });

  it('stamps every turn it opens with the moment it opened', async () => {
    const id = nextId();
    const projector = getOrCreateProjector(id, '/projects/x', { persist: 'history' });
    vi.setSystemTime(SENT);
    await feedProjector(projector, (async function* () {})(), { userMessage: 'hello' });

    const start = projector.replayFrom(0).find((event) => event.type === 'turn_start');
    expect(start).toMatchObject({ type: 'turn_start', userMessage: 'hello', at: SENT });
  });
});

describe('reconstructHistoryFromEvents and times', () => {
  const events = [
    { seq: 1, type: 'turn_start', userMessage: 'first', at: SENT },
    { seq: 2, type: 'turn_input', content: 'and also', disposition: 'steer', messageId: 'm1' },
    { seq: 3, type: 'text_delta', text: 'done' },
    { seq: 4, type: 'turn_end' },
  ] as SessionEvent[];

  it('dates nothing it has no record for, and never a steer', () => {
    const saved = new Date(FINISHED).toISOString();
    const dated = reconstructHistoryFromEvents(events, () => saved);
    expect(dated.map((m) => [m.id, m.timestamp])).toEqual([
      ['user-1', new Date(SENT).toISOString()],
      ['steer-m1', undefined],
      ['assistant-1', saved],
    ]);

    // An in-memory log keeps no save times: only the turn's own start is known.
    const undated = reconstructHistoryFromEvents(events);
    expect(undated.map((m) => m.timestamp)).toEqual([
      new Date(SENT).toISOString(),
      undefined,
      undefined,
    ]);
  });
});

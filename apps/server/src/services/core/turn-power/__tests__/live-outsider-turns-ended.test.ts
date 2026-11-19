/**
 * A marked turn that has ended still counts for a reader asking "since when" (DOR-4528): path
 * trust holds an edit when any marked turn of its author ran in the window, a turn that read
 * outside text through a tool (DOR-3969) included.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  countWhileRunning,
  endReadMark,
  marksEndedSince,
  noteReadMark,
  resetLiveOutsiderTurns,
} from '../live-outsider-turns.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const WREN = '/agents/wren';
const OTTO = '/agents/otto';

describe('marksEndedSince', () => {
  beforeEach(() => {
    resetLiveOutsiderTurns();
    registerTestHomes([WREN, OTTO]);
  });
  afterEach(() => {
    resetLiveOutsiderTurns();
    clearTestHomes();
  });

  it('counts a tool-read mark once its turn has ended', () => {
    const since = Date.now();
    noteReadMark('chat-1', WREN);
    expect(marksEndedSince(WREN, since)).toEqual([]);
    endReadMark('chat-1');
    expect(marksEndedSince(WREN, since).some((m) => m.outsider === true)).toBe(true);
    // Another agent's window is untouched.
    expect(marksEndedSince(OTTO, since)).toEqual([]);
  });

  it('counts a marked turn of the author once its stream ends, and only from that moment', async () => {
    async function* events(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} } as StreamEvent;
    }
    const before = Date.now();
    for await (const _ of countWhileRunning({ cwd: WREN }, { outsider: true }, events())) void _;
    expect(marksEndedSince(WREN, before).some((m) => m.outsider === true)).toBe(true);
    expect(marksEndedSince(WREN, Date.now() + 1_000)).toEqual([]);
    expect(marksEndedSince(OTTO, before)).toEqual([]);
  });
});

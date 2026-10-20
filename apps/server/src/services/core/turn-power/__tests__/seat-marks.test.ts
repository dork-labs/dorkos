/**
 * Security Must 2 for re-seating (spec: `.temp` brief "Re-seat P0"): a room
 * seat moved onto a fresh session keeps every mark the old session carried,
 * BEFORE the new one runs a turn. Marks are keyed by session id, so a fresh id
 * that started unmarked would launder a stranger's words through the move
 * (the hole DOR-3107 closed for chats).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  markedBoundOf,
  marksOf,
  passedOnLevelOf,
  postLevelFor,
  recordTurnLevels,
} from '../turn-levels.js';
import { carrySessionMarks } from '../seat-marks.js';
import {
  chatHeardOutsider,
  noteChatHeardOutsider,
  resetOutsiderTurns,
} from '../../../session/origin/outsider-turns.js';

const DEFAULT = { asks: 'always', reach: 'edit' } as const;
const TEAMMATE = [{ roomId: 'space-room', authorId: 'priya' }] as const;

/** A runtime that answers every send with one `done`, wrapped the way the registry wraps it. */
function wrapped(): AgentRuntime {
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return recordTurnLevels(runtime, () => 'bypassPermissions');
}

async function send(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

afterEach(() => resetOutsiderTurns());

describe('carrySessionMarks', () => {
  it('carries the outsider and teammate marks of a capped turn to the new seat', async () => {
    const runtime = wrapped();
    await send(runtime, 'old-a', {
      permissionCeiling: { ...DEFAULT, outsider: true, teammate: TEAMMATE },
    });

    carrySessionMarks('old-a', 'new-a');

    const marks = marksOf('new-a', undefined);
    expect(marks.outsider).toBe(true);
    expect(marks.teammate).toEqual(TEAMMATE);
    // What the new seat's post hands on is still capped, so the agent it wakes is capped.
    expect(passedOnLevelOf('new-a')?.outsider).toBe(true);
    expect(postLevelFor(['new-a'])?.asks).toBe('always');
    expect(markedBoundOf('new-a', undefined)).toBeDefined();
  });

  it('carries a stranger heard in the old chat even with no turn recorded in this process', () => {
    noteChatHeardOutsider('old-b');

    carrySessionMarks('old-b', 'new-b');

    expect(chatHeardOutsider('new-b')).toBe(true);
  });

  it('adds nothing to the new seat when the old one carried no mark', async () => {
    const runtime = wrapped();
    await send(runtime, 'old-c');

    carrySessionMarks('old-c', 'new-c');

    expect(chatHeardOutsider('new-c')).toBe(false);
    expect(marksOf('new-c', undefined)).toEqual({});
  });

  it('never takes a mark away from the new seat', async () => {
    const runtime = wrapped();
    await send(runtime, 'new-d', { permissionCeiling: { ...DEFAULT, outsider: true } });
    await send(runtime, 'old-d');

    carrySessionMarks('old-d', 'new-d');

    expect(marksOf('new-d', undefined).outsider).toBe(true);
  });

  it('keeps the old seat marked after the move', async () => {
    const runtime = wrapped();
    await send(runtime, 'old-e', { permissionCeiling: { ...DEFAULT, outsider: true } });

    carrySessionMarks('old-e', 'new-e');

    expect(marksOf('old-e', undefined).outsider).toBe(true);
  });
});

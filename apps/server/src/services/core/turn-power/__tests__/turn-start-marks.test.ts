/**
 * A turn's outsider mark says where it came from (DOR-4693): a turn that started marked, or one a
 * read marked partway through. The browser handoff lets a page the agent read through, never a turn
 * somebody outside started. Driven through the real level seam.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { markRunningTurnOutsider, marksOf, recordTurnLevels } from '../turn-levels.js';
import { turnStartedMarked } from '../turn-start-marks.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { liveOutsideTurnCheck } from '../../../session/local-browser/outside-turn.js';

let counter = 0;
const fresh = () => `turn-start-${(counter += 1)}`;

/** Start and finish one turn on `sessionId` through the real level seam. */
async function turn(sessionId: string, opts?: MessageOpts): Promise<void> {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

const check = liveOutsideTurnCheck({
  agentPathOf: async () => null,
  launchOriginOf: () => 'interactive',
});

afterEach(() => resetLiveOutsiderTurns());

describe('where a turn’s outsider mark came from', () => {
  it('names a read during a clean turn as a read, never as the turn’s start', async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat);
    expect(marksOf(chat, undefined).outsider).toBe(true);
    expect(turnStartedMarked(chat)).toBe(false);
    await expect(check(chat)).resolves.toBe('read_outside_text');
  });

  it('names a turn that started marked as the turn’s own, even after a read', async () => {
    const chat = fresh();
    await turn(chat, { carriedMarks: { outsider: true } });
    markRunningTurnOutsider(chat);
    expect(turnStartedMarked(chat)).toBe(true);
    await expect(check(chat)).resolves.toBe('outsider_turn');
  });

  it('starts the next clean turn clean', async () => {
    const chat = fresh();
    await turn(chat, { carriedMarks: { outsider: true } });
    await turn(chat);
    expect(turnStartedMarked(chat)).toBe(false);
    await expect(check(chat)).resolves.toBeNull();
  });
});

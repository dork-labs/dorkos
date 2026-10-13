/**
 * A turn that read a stranger's words may send a few posts and notes, and no
 * more; every other turn is never counted (DOR-2739, ADR 261006-225605).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../turn-levels.js';
import { countWhileRunning, resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import {
  chargeOutsiderOutput,
  OUTSIDER_TURN_LIMIT,
  resetOutsiderOutput,
} from '../outsider-output.js';

/** A runtime that answers every send with one `done`, wrapped the way the registry wraps it. */
const runtime = recordTurnLevels(
  {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime,
  () => null
);

async function send(sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** A stranger's message carries the runtime default as its ceiling. */
const STRANGER: MessageOpts = { permissionCeiling: 'runtime-default' };

/** Charge `kind` until refused; how many landed. */
function spendAll(kind: 'post' | 'note', sessionId?: string, agentPath?: string): number {
  let landed = 0;
  while (chargeOutsiderOutput(kind, sessionId, agentPath) && landed < 50) landed += 1;
  return landed;
}

describe('chargeOutsiderOutput', () => {
  beforeEach(() => {
    resetOutsiderOutput();
    resetLiveOutsiderTurns();
  });

  it('never counts a turn that read no stranger’s words', async () => {
    await send('own-1');
    expect(spendAll('post', 'own-1')).toBe(50);
    expect(spendAll('note', 'own-1')).toBe(50);
  });

  it('lets a stranger’s turn post a few times, then refuses', async () => {
    await send('stranger-1', STRANGER);
    expect(spendAll('post', 'stranger-1')).toBe(OUTSIDER_TURN_LIMIT);
    expect(chargeOutsiderOutput('post', 'stranger-1', undefined)).toBe(false);
  });

  it('counts posts and notes separately', async () => {
    await send('stranger-2', STRANGER);
    expect(spendAll('post', 'stranger-2')).toBe(OUTSIDER_TURN_LIMIT);
    expect(spendAll('note', 'stranger-2')).toBe(OUTSIDER_TURN_LIMIT);
  });

  it('starts over on the next turn, and stops counting once a person is talking', async () => {
    await send('mixed-1', STRANGER);
    expect(spendAll('post', 'mixed-1')).toBe(OUTSIDER_TURN_LIMIT);
    await send('mixed-1', STRANGER);
    expect(spendAll('post', 'mixed-1')).toBe(OUTSIDER_TURN_LIMIT);
    await send('mixed-1');
    expect(spendAll('post', 'mixed-1')).toBe(50);
  });

  it('gives each conversation’s stranger turn its own count', async () => {
    await send('a', STRANGER);
    await send('b', STRANGER);
    expect(spendAll('post', 'a')).toBe(OUTSIDER_TURN_LIMIT);
    // Another conversation's stranger turn has its own count.
    expect(spendAll('post', 'b')).toBe(OUTSIDER_TURN_LIMIT);
  });

  it('counts a caller with no session through its agent, while a stranger’s turn runs', async () => {
    const agentPath = '/tmp/dorkos-outsider-output/agent';
    // Nothing running: an agent with no outsider turn is never counted.
    expect(spendAll('note', undefined, agentPath)).toBe(50);

    async function* forever(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: {} } as StreamEvent;
      await new Promise(() => {});
    }
    const running = countWhileRunning({ cwd: agentPath }, forever());
    await running.next();
    expect(spendAll('note', undefined, agentPath)).toBe(OUTSIDER_TURN_LIMIT);
    await running.return(undefined);

    // The stretch ended; the next one starts over.
    const again = countWhileRunning({ cwd: agentPath }, forever());
    await again.next();
    expect(spendAll('note', undefined, agentPath)).toBe(OUTSIDER_TURN_LIMIT);
    await again.return(undefined);
  });
});

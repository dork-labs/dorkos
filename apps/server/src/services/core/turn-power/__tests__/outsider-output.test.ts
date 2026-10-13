/**
 * A turn a stranger started may send a few posts and notes, and no more; every
 * other turn is never counted (DOR-2739, ADR 261006-225605).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { aliasTurnLevel, recordTurnLevels } from '../turn-levels.js';
import { noteTurnOrigin, resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import type { TurnOrigin } from '../../../session/origin/turn-origin.js';
import {
  linkSessionId,
  resetSessionKeys,
} from '../../../session/resolution/session-key-registry.js';
import {
  OUTSIDER_TURN_LIMIT,
  outsiderOutputAllowed,
  recordOutsiderOutput,
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

const STRANGER: TurnOrigin = { kind: 'relay-binding' };
const OWN: TurnOrigin = { kind: 'interactive' };

/** Start a turn on `sessionId`, noting what started it, as the binding call does. */
async function turn(sessionId: string, origin: TurnOrigin) {
  noteTurnOrigin(sessionId, origin);
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

/** Send `kind` until refused, counting each; how many went out. */
function sendAll(kind: 'post' | 'note', sessionId: string): number {
  let sent = 0;
  while (outsiderOutputAllowed(kind, sessionId) && sent < 50) {
    recordOutsiderOutput(kind, sessionId);
    sent += 1;
  }
  return sent;
}

describe('outsider output', () => {
  beforeEach(() => {
    resetOutsiderOutput();
    resetOutsiderTurns();
    resetSessionKeys();
  });

  it('never counts a turn its own people started', async () => {
    await turn('own-1', OWN);
    expect(sendAll('post', 'own-1')).toBe(50);
    expect(sendAll('note', 'own-1')).toBe(50);
  });

  it('never counts a turn of ours that merely read a stranger’s words', async () => {
    noteTurnOrigin('room-own', { kind: 'room', externalAuthor: false });
    for await (const _event of runtime.sendMessage('room-own', 'hi', {
      permissionCeiling: 'runtime-default',
    })) {
      // drain
    }
    expect(sendAll('post', 'room-own')).toBe(50);
  });

  it('lets a stranger’s turn send a few, then refuses', async () => {
    await turn('stranger-1', STRANGER);
    expect(sendAll('post', 'stranger-1')).toBe(OUTSIDER_TURN_LIMIT);
    expect(outsiderOutputAllowed('post', 'stranger-1')).toBe(false);
  });

  it('counts a bridged room turn an outside author started', async () => {
    await turn('room-stranger', { kind: 'room', externalAuthor: true });
    expect(sendAll('post', 'room-stranger')).toBe(OUTSIDER_TURN_LIMIT);
  });

  it('counts posts and notes separately', async () => {
    await turn('stranger-2', STRANGER);
    expect(sendAll('post', 'stranger-2')).toBe(OUTSIDER_TURN_LIMIT);
    expect(sendAll('note', 'stranger-2')).toBe(OUTSIDER_TURN_LIMIT);
  });

  it('spends nothing until a send is recorded', async () => {
    await turn('stranger-3', STRANGER);
    for (let n = 0; n < 10; n += 1) expect(outsiderOutputAllowed('post', 'stranger-3')).toBe(true);
    expect(sendAll('post', 'stranger-3')).toBe(OUTSIDER_TURN_LIMIT);
  });

  it('starts over on the next turn, and stops counting once a person is talking', async () => {
    await turn('mixed-1', STRANGER);
    expect(sendAll('post', 'mixed-1')).toBe(OUTSIDER_TURN_LIMIT);
    await turn('mixed-1', STRANGER);
    expect(sendAll('post', 'mixed-1')).toBe(OUTSIDER_TURN_LIMIT);
    await turn('mixed-1', OWN);
    expect(sendAll('post', 'mixed-1')).toBe(50);
  });

  it('counts one turn under both ids a renamed conversation is known by', async () => {
    await turn('born-id', STRANGER);
    linkSessionId('born-id', 'sdk-id');
    aliasTurnLevel('born-id', 'sdk-id');
    expect(sendAll('post', 'sdk-id')).toBe(OUTSIDER_TURN_LIMIT);
    expect(outsiderOutputAllowed('post', 'born-id')).toBe(false);
  });

  it('never counts a caller that names no session', () => {
    expect(sendAll('note', '')).toBe(50);
  });
});

/**
 * `shouldAsk` for `connector.write.marked-same-source` (DOR-4794), called directly: a write back
 * to connection C is allowed only when every outsider mark on the turn came from a recorded read
 * of C, the action is `write` class and the person's switch is on. Anything else asks, and a key
 * the registry doesn't hold asks too.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { PromptKindKey } from '../prompt-kinds.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { resolveCallPermission } from '../../capabilities/permission-enforcement.js';
import { resetChosenTurns } from '../../turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { markRunningTurnOutsider, recordTurnLevels } from '../../turn-power/turn-levels.js';
import { noteTurnStart } from '../../turn-power/turn-start-marks.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import { setShouldAskActivity, shouldAsk, type SameSourceWriteFacts } from '../should-ask.js';

const KIND = 'connector.write.marked-same-source';
const WREN = { agentPath: '/agents/wren', displayName: 'Wren', createdAt: '2026-11-19T12:00:00Z' };
const C = 'connection-tracker';
const OTHER = 'connection-mail';

let counter = 0;
const fresh = () => `should-ask-${(counter += 1)}`;
const lines: { eventType: string }[] = [];

/** Run one clean turn on `sessionId`, below Full, through the real turn recorder. */
async function cleanTurn(sessionId: string) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'acceptEdits'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

/** A write back to C from `sessionId`, with these preflight facts. */
function facts(
  sessionId: string,
  sameSource: Partial<NonNullable<SameSourceWriteFacts['sameSource']>> = {}
): SameSourceWriteFacts {
  return {
    action: { id: 'connectors.execute_write' },
    identity: WREN,
    sessionId,
    sameSource: {
      connectionId: C,
      toolkit: 'linear',
      classification: 'write',
      writesBackUnasked: true,
      ...sameSource,
    },
  };
}

/** A chat whose clean turn read C. */
async function readC() {
  const chat = fresh();
  await cleanTurn(chat);
  markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
  return chat;
}

beforeEach(() => {
  lines.length = 0;
  resetLiveOutsiderTurns();
  resetChosenTurns();
  registerTestHomes([WREN.agentPath]);
  setShouldAskActivity({
    emit: async (event) => {
      lines.push(event);
    },
  });
});
afterEach(() => {
  setShouldAskActivity(undefined);
  resetLiveOutsiderTurns();
  resetChosenTurns();
  clearTestHomes();
});

describe('shouldAsk: connector.write.marked-same-source', () => {
  it('allows a write class write back to C when every mark came from C and the switch is on', async () => {
    const chat = await readC();
    expect(shouldAsk(KIND, facts(chat))).toEqual({ decision: 'allow', why: 'only-this-app' });
    expect(lines).toEqual([expect.objectContaining({ eventType: 'agent.same_source_write' })]);
  });

  it('asks when the switch is off', async () => {
    const chat = await readC();
    expect(shouldAsk(KIND, facts(chat, { writesBackUnasked: false }))).toEqual({
      decision: 'ask',
      why: 'switch-off',
    });
    expect(lines).toEqual([]);
  });

  // Security Must 1, checked in the decider too: a mail app's writes are sends. Red without the
  // list check here, since every other fact (switch on, only that app read) says allow.
  it('asks for an app off the list, whatever the switch fact says', async () => {
    const chat = await readC();
    expect(shouldAsk(KIND, facts(chat, { toolkit: 'gmail' }))).toEqual({
      decision: 'ask',
      why: 'unsupported-app',
    });
    expect(lines).toEqual([]);
  });

  it('asks for a destructive action', async () => {
    const chat = await readC();
    expect(shouldAsk(KIND, facts(chat, { classification: 'destructive' }))).toEqual({
      decision: 'ask',
      why: 'not-write-class',
    });
  });

  it('asks once the turn also read another connection', async () => {
    const chat = await readC();
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: OTHER });
    expect(shouldAsk(KIND, facts(chat))).toEqual({
      decision: 'ask',
      why: 'marked-by-something-else',
    });
  });

  it('asks for a write to another connection than the one read', async () => {
    const chat = await readC();
    expect(shouldAsk(KIND, facts(chat, { connectionId: OTHER })).decision).toBe('ask');
  });

  it('asks when a mark with no source joins the read of C', async () => {
    const chat = await readC();
    markRunningTurnOutsider(chat, WREN.agentPath);
    expect(shouldAsk(KIND, facts(chat))).toEqual({
      decision: 'ask',
      why: 'marked-by-something-else',
    });
  });

  it('asks for a call that names no turn', async () => {
    const { sessionId: _none, ...noTurn } = facts(await readC());
    expect(shouldAsk(KIND, noTurn)).toEqual({ decision: 'ask', why: 'no-verified-turn' });
  });

  // The gate calls it only where a marked turn's card would show. An unmarked turn has no card, and
  // the gate lets the write through without asking it; asked anyway, it keeps the default.
  it('keeps the default for a turn nothing marked; the gate never asks it there', async () => {
    const chat = fresh();
    await cleanTurn(chat);
    expect(shouldAsk(KIND, facts(chat))).toEqual({ decision: 'ask', why: 'not-marked' });
    expect(lines).toEqual([]);
    expect(
      await resolveCallPermission({
        action: { id: 'connectors.execute_write', tier: 'act', area: null },
        identity: WREN,
        sessionId: chat,
      })
    ).toBeNull();
  });

  // Security Should 1: the gate is marked through the agent's other running chat, but the turn
  // the call names is clean. Red if `not-marked` allowed: the write ran with no line at all.
  it('asks when the gate is marked through the agent but the named turn is clean', async () => {
    const stranger = fresh();
    const clean = fresh();
    await cleanTurn(stranger);
    await cleanTurn(clean);
    markRunningTurnOutsider(stranger, WREN.agentPath, { kind: 'room' });
    const call = {
      action: { id: 'connectors.execute_write', tier: 'act' as const, area: null },
      identity: WREN,
      principalTurn: { sessionId: clean, agentPath: WREN.agentPath },
      sameSource: {
        connectionId: C,
        toolkit: 'linear',
        classification: 'write' as const,
        writesBackUnasked: true,
      },
    };
    expect(await resolveCallPermission(call)).toMatchObject({ state: 'ask' });
    expect(lines).toEqual([]);
  });

  // Mutation M11 (`every` → `some`): the session's turn read only C, the principal's turn read a
  // room post. Red if one explained turn were enough.
  it('asks when the session and the principal turn differ and only one is explained', async () => {
    const chat = await readC();
    const other = fresh();
    await cleanTurn(other);
    markRunningTurnOutsider(other, WREN.agentPath, { kind: 'room' });
    expect(
      shouldAsk(KIND, {
        ...facts(chat),
        principalTurn: { sessionId: other, agentPath: WREN.agentPath },
      })
    ).toEqual({ decision: 'ask', why: 'marked-by-something-else' });
  });

  // Mutation M3: the action id is checked on its own, not only through the class.
  it('asks for any other action, even with write-class facts', async () => {
    const chat = await readC();
    expect(
      shouldAsk(KIND, { ...facts(chat), action: { id: 'connectors.execute_destructive' } })
    ).toEqual({ decision: 'ask', why: 'not-this-kind' });
  });

  // Mutation M5: an id with a clean start and a read of C, but no level of its own, would read its
  // marks from the agent's other turns. Red without the level check.
  it('asks for an id with no level of its own', () => {
    const chat = fresh();
    noteTurnStart(chat, false);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    expect(shouldAsk(KIND, facts(chat))).toEqual({
      decision: 'ask',
      why: 'marked-by-something-else',
    });
  });

  it('asks for a key the registry does not hold: fails closed', async () => {
    const chat = await readC();
    expect(shouldAsk('connector.write.not-a-kind' as PromptKindKey, facts(chat))).toEqual({
      decision: 'ask',
      why: 'unknown-kind',
    });
    expect(lines).toEqual([]);
  });
});

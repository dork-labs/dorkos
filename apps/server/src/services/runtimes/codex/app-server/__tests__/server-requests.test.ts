/**
 * Codex's server → client requests as DorkOS cards (spec
 * `codex-app-server-transport` §10): every row of the mapping table, and the
 * lifecycle over the fake app-server — answered only by a person, declined at
 * the park ceiling, cancelled before a stop, withdrawn when Codex clears it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { ApprovalEventSchema, StreamEventSchema } from '@dorkos/shared/schemas';
import { makeAppServerHarness, PERSON_HOME } from '../../__tests__/app-server-harness.js';
import { approvalTurn, REPLY, type FakeTurnScript } from '../../__tests__/fake-app-server.js';
import { mapServerRequest, type ServerRequestTurnView } from '../server-requests.js';

type Harness = ReturnType<typeof makeAppServerHarness>;
const harnesses: Harness[] = [];
function harness(options?: Parameters<typeof makeAppServerHarness>[0]): Harness {
  const h = makeAppServerHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
});

const noTurn: ServerRequestTurnView = {
  inputOf: () => undefined,
  runningMcpCalls: () => [],
};

/** Read a running turn until an event of `type`, keeping what was read. */
async function until(
  gen: AsyncGenerator<StreamEvent>,
  type: StreamEvent['type'],
  seen: StreamEvent[] = []
): Promise<StreamEvent> {
  for (;;) {
    const next = await gen.next();
    if (next.done) throw new Error(`the turn ended before ${type}: ${JSON.stringify(seen)}`);
    seen.push(next.value);
    if (next.value.type === type) return next.value;
  }
}
async function rest(gen: AsyncGenerator<StreamEvent>, seen: StreamEvent[] = []) {
  for await (const event of gen) seen.push(event);
  return seen;
}
const dones = (events: StreamEvent[]) => events.filter((event) => event.type === 'done');

describe('mapServerRequest (spec §10)', () => {
  it('maps a command approval to a Shell card with its reason and network host', () => {
    const mapped = mapServerRequest(
      {
        id: 0,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 't',
          turnId: 'u',
          itemId: 'call_1',
          command: 'curl example.com',
          cwd: '/p',
          reason: 'Fetch the page?',
          networkApprovalContext: { host: 'example.com', protocol: 'https' },
          availableDecisions: ['accept', 'cancel'],
        },
      },
      noTurn
    );
    expect(mapped).toMatchObject({
      kind: 'approval',
      interactionId: 'call_1',
      card: {
        type: 'approval_required',
        data: {
          toolName: 'Shell',
          input: JSON.stringify({ command: 'curl example.com', cwd: '/p' }),
          decisionReason: 'Fetch the page?',
          description: 'Codex wants to reach example.com.',
          // Codex did not offer "for this session", so neither does the card.
          hasSuggestions: false,
        },
      },
    });
    if (!('kind' in mapped)) throw new Error('refused');
    expect(mapped.replies.approve!(true)).toEqual({ decision: 'accept' });
    expect(mapped.replies.deny).toEqual({ decision: 'decline' });
    expect(mapped.replies.expired).toEqual({ decision: 'decline' });
    expect(mapped.replies.cancelled).toEqual({ decision: 'cancel' });
  });

  it('prefers approvalId, and offers "for this session" when Codex lists it', () => {
    const mapped = mapServerRequest(
      {
        id: 1,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'call_1', approvalId: 'net-1', command: 'x' },
      },
      noTurn
    );
    if (!('kind' in mapped)) throw new Error('refused');
    expect(mapped.interactionId).toBe('net-1');
    expect(mapped.card.data).toMatchObject({ hasSuggestions: true, alwaysAllowScope: 'session' });
    expect(mapped.replies.approve!(true)).toEqual({ decision: 'acceptForSession' });
    expect(mapped.replies.approve!(false)).toEqual({ decision: 'accept' });
  });

  it('maps a file change to an ApplyPatch card carrying the item’s changes and grant root', () => {
    const changes = JSON.stringify({ changes: [{ path: 'a.ts' }] });
    const mapped = mapServerRequest(
      {
        id: 2,
        method: 'item/fileChange/requestApproval',
        params: { itemId: 'p1', grantRoot: '/outside', reason: 'Write outside?' },
      },
      { ...noTurn, inputOf: (id) => (id === 'p1' ? changes : undefined) }
    );
    expect(mapped).toMatchObject({
      interactionId: 'p1',
      card: {
        data: {
          toolName: 'ApplyPatch',
          input: changes,
          blockedPath: '/outside',
          decisionReason: 'Write outside?',
        },
      },
    });
  });

  it('grants exactly the permissions asked for, and nothing on a denial', () => {
    const permissions = { network: { enabled: true }, fileSystem: null };
    const mapped = mapServerRequest(
      {
        id: 3,
        method: 'item/permissions/requestApproval',
        params: { itemId: 'i', permissions, cwd: '/p' },
      },
      noTurn
    );
    if (!('kind' in mapped)) throw new Error('refused');
    expect(mapped.card.data).toMatchObject({ toolName: 'Permissions' });
    expect(mapped.replies.approve!(false)).toEqual({ permissions, scope: 'turn' });
    expect(mapped.replies.approve!(true)).toEqual({ permissions, scope: 'session' });
    expect(mapped.replies.deny).toEqual({ permissions: {}, scope: 'turn' });
  });

  it('draws form and url elicitations, and cancels modes it cannot draw', () => {
    const form = mapServerRequest(
      {
        id: 5,
        method: 'mcpServer/elicitation/request',
        params: {
          serverName: 's',
          mode: 'form',
          message: 'Name?',
          requestedSchema: { type: 'object' },
        },
      },
      noTurn
    );
    expect(form).toMatchObject({
      kind: 'elicitation',
      interactionId: 'codex-elicitation-5',
      card: {
        type: 'elicitation_prompt',
        data: {
          serverName: 's',
          message: 'Name?',
          mode: 'form',
          requestedSchema: { type: 'object' },
        },
      },
    });
    if (!('kind' in form)) throw new Error('refused');
    expect(form.replies.elicit!('accept', { name: 'a' })).toEqual({
      action: 'accept',
      content: { name: 'a' },
      _meta: null,
    });
    expect(form.replies.elicit!('decline')).toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });

    const url = mapServerRequest(
      {
        id: 6,
        method: 'mcpServer/elicitation/request',
        params: {
          serverName: 's',
          mode: 'url',
          message: 'Sign in',
          url: 'https://x',
          elicitationId: 'e1',
        },
      },
      noTurn
    );
    expect(url).toMatchObject({
      interactionId: 'e1',
      card: { data: { mode: 'url', url: 'https://x', elicitationId: 'e1' } },
    });

    for (const mode of ['openai/form', 'openai/userVerification']) {
      expect(
        mapServerRequest(
          { id: 7, method: 'mcpServer/elicitation/request', params: { serverName: 's', mode } },
          noTurn
        )
      ).toMatchObject({ refuse: { action: 'cancel', content: null, _meta: null } });
    }
  });

  it('asks a question in order and answers by question id from index-keyed answers', () => {
    const mapped = mapServerRequest(
      {
        id: 8,
        method: 'item/tool/requestUserInput',
        params: {
          itemId: 'q1',
          isBlocking: true,
          questions: [
            {
              id: 'color',
              header: 'Colour',
              question: 'Which?',
              options: [{ label: 'Red', description: 'warm' }],
            },
            { id: 'why', header: '', question: 'Why?', isOther: true },
          ],
        },
      },
      noTurn
    );
    expect(mapped).toMatchObject({
      kind: 'question',
      interactionId: 'q1',
      card: {
        type: 'question_prompt',
        data: {
          questions: [
            {
              header: 'Colour',
              question: 'Which?',
              options: [{ label: 'Red', description: 'warm' }],
              multiSelect: false,
            },
            { header: '', question: 'Why?', options: [], multiSelect: false },
          ],
        },
      },
    });
    if (!('kind' in mapped)) throw new Error('refused');
    expect(mapped.replies.answer!({ '0': 'Red', '1': 'because' })).toEqual({
      answers: { color: { answers: ['Red'] }, why: { answers: ['because'] } },
    });
  });

  it('refuses the requests DorkOS takes no part in with the method’s own no', () => {
    for (const [method, refusal] of [
      ['item/tool/call', { contentItems: [], success: false }],
      [
        'execCommandApproval',
        { decision: { denied: { rejection: 'DorkOS declined this request.' } } },
      ],
      [
        'applyPatchApproval',
        { decision: { denied: { rejection: 'DorkOS declined this request.' } } },
      ],
      ['account/chatgptAuthTokens/refresh', undefined],
      ['attestation/generate', undefined],
      ['currentTime/read', undefined],
    ] as const) {
      expect(mapServerRequest({ id: 9, method, params: {} }, noTurn)).toMatchObject({
        refuse: refusal,
      });
    }
  });
});

describe('approvals over the fake app-server', () => {
  it('RT-TOOL-01: draws the card after its tool start, and runs the command once a person approves', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(approvalTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    const seen: StreamEvent[] = [];
    const card = await until(gen, 'approval_required', seen);
    const approval = ApprovalEventSchema.parse(card.data);
    expect(approval).toMatchObject({
      toolCallId: 'cmd-approval',
      toolName: 'Shell',
      hasSuggestions: true,
    });
    expect(seen.findIndex((e) => e.type === 'tool_call_start')).toBeLessThan(seen.indexOf(card));

    expect(h.transport.answerApproval('s1', 'cmd-approval', true)).toBe(true);
    const after = await rest(gen, seen);
    for (const event of after) StreamEventSchema.parse(event);
    expect(dones(after)).toHaveLength(1);
    expect(after.find((e) => e.type === 'tool_call_end')).toMatchObject({
      data: { toolCallId: 'cmd-approval', status: 'complete' },
    });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect([...fake.replies.values()]).toEqual([{ decision: 'accept' }]);
    // Answered once: a second answer (or an answer after Codex cleared it) is false.
    expect(h.transport.answerApproval('s1', 'cmd-approval', true)).toBe(false);
  });

  it('declines the command when a person denies it', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(approvalTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'approval_required');
    expect(h.transport.answerApproval('s1', 'cmd-approval', false)).toBe(true);
    const after = await rest(gen);
    expect(after.find((e) => e.type === 'tool_call_end')).toMatchObject({
      data: { toolCallId: 'cmd-approval', status: 'error' },
    });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect([...fake.replies.values()]).toEqual([{ decision: 'decline' }]);
  });

  it('approves for the session when asked and offered', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(approvalTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'approval_required');
    h.transport.answerApproval('s1', 'cmd-approval', true, true);
    await rest(gen);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect([...fake.replies.values()]).toEqual([{ decision: 'acceptForSession' }]);
  });

  it('answers false for an id nothing is waiting on, and for the wrong kind of card', async () => {
    const h = harness();
    expect(h.transport.answerApproval('s1', 'nope', true)).toBe(false);
    h.host.home(PERSON_HOME).nextTurn(approvalTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'approval_required');
    expect(h.transport.answerQuestion('s1', 'cmd-approval', { '0': 'x' })).toBe(false);
    expect(h.transport.answerElicitation('s1', 'cmd-approval', 'accept')).toBe(false);
    expect(h.transport.answerApproval('s2', 'cmd-approval', true)).toBe(false);
    h.transport.answerApproval('s1', 'cmd-approval', true);
    await rest(gen);
  });

  it('declines at the park ceiling, withdraws the card as timed out, and the agent carries on', async () => {
    const h = harness({ interactionExpireMs: 30 });
    h.host.home(PERSON_HOME).nextTurn(approvalTurn);
    const events = await h.run(h.request({ sessionId: 's1' }));
    expect(events.find((e) => e.type === 'interaction_cancelled')).toEqual({
      type: 'interaction_cancelled',
      data: { interactionId: 'cmd-approval', reason: 'timeout' },
    });
    expect(dones(events)).toHaveLength(1);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect([...fake.replies.values()]).toEqual([{ decision: 'decline' }]);
  });

  it('cancels a pending request before interrupting, and withdraws its card', async () => {
    const h = harness();
    h.host.home(PERSON_HOME).nextTurn(approvalTurn);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'approval_required');
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    const receipt = h.transport.interrupt('s1');
    const after = await rest(gen);
    await expect(receipt).resolves.toEqual({ outcome: 'acked', runtime: 'codex' });
    expect(after[0]).toEqual({
      type: 'interaction_cancelled',
      data: { interactionId: 'cmd-approval', reason: 'aborted' },
    });
    expect(dones(after)).toHaveLength(1);
    // The cancel reply went out before the interrupt.
    expect([...fake.replies.values()]).toEqual([{ decision: 'cancel' }]);
    const order = fake.received.map((m) => m.method);
    expect(order.indexOf(REPLY)).toBeGreaterThan(-1);
    expect(order.indexOf(REPLY)).toBeLessThan(order.indexOf('turn/interrupt'));
    expect(h.transport.answerApproval('s1', 'cmd-approval', true)).toBe(false);
  });

  it('withdraws a card Codex cleared (serverRequest/resolved), and refuses a late answer', async () => {
    const h = harness();
    let clear!: () => void;
    const script: FakeTurnScript = async (ctx) => {
      ctx.emit('item/started', {
        item: { type: 'commandExecution', id: 'c1', command: 'ls', status: 'inProgress' },
      });
      void ctx.serverRequest('item/commandExecution/requestApproval', {
        itemId: 'c1',
        command: 'ls',
      });
      await new Promise<void>((resolve) => (clear = resolve));
      // Another client answered it: Codex clears DorkOS's copy.
      ctx.server.send({
        method: 'serverRequest/resolved',
        params: { threadId: ctx.turn.threadId, requestId: ctx.server.lastServerRequestId },
      });
      await ctx.tick();
      ctx.agentMessage('ok');
      ctx.complete('completed');
    };
    h.host.home(PERSON_HOME).nextTurn(script);
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    await until(gen, 'approval_required');
    clear();
    const after = await rest(gen);
    expect(after).toContainEqual({
      type: 'interaction_cancelled',
      data: { interactionId: 'c1', reason: 'aborted' },
    });
    expect(h.transport.answerApproval('s1', 'c1', true)).toBe(false);
    expect(dones(after)).toHaveLength(1);
  });

  it('refuses a request on a thread with no DorkOS turn open; nothing is accepted on anyone’s behalf', async () => {
    const h = harness();
    await h.run(h.request({ sessionId: 's1' }));
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    const threadId = h.bindings[0]!.threadId;
    fake.send({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId, turnId: 'gone', itemId: 'x', command: 'rm -rf /' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.replies.get(77)).toEqual({ decision: 'decline' });
  });

  it('asks a question and answers it by question id', async () => {
    const h = harness();
    let reply: unknown;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      reply = await ctx.serverRequest('item/tool/requestUserInput', {
        itemId: 'ask-1',
        isBlocking: true,
        questions: [{ id: 'name', header: 'Name', question: 'What name?', options: null }],
      });
      ctx.complete('completed');
    });
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    const card = await until(gen, 'question_prompt');
    expect(card.data).toMatchObject({
      toolCallId: 'ask-1',
      questions: [{ question: 'What name?' }],
    });
    expect(h.transport.answerQuestion('s1', 'ask-1', { '0': 'Ada' })).toBe(true);
    await rest(gen);
    expect(reply).toEqual({ answers: { name: { answers: ['Ada'] } } });
  });

  it('draws a form elicitation and returns what the person filled in', async () => {
    const h = harness();
    let reply: unknown;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      reply = await ctx.serverRequest('mcpServer/elicitation/request', {
        serverName: 'crm',
        mode: 'form',
        message: 'Which account?',
        requestedSchema: { type: 'object', properties: {} },
      });
      ctx.complete('completed');
    });
    const gen = h.transport.runTurn(h.request({ sessionId: 's1' }));
    const card = await until(gen, 'elicitation_prompt');
    const id = (card.data as { interactionId: string }).interactionId;
    expect(card.data).toMatchObject({ serverName: 'crm', mode: 'form', message: 'Which account?' });
    expect(h.transport.answerElicitation('s1', id, 'accept', { account: 'acme' })).toBe(true);
    await rest(gen);
    expect(reply).toEqual({ action: 'accept', content: { account: 'acme' }, _meta: null });
  });
});

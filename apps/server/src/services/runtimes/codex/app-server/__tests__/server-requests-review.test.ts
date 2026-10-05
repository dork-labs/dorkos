/**
 * The DOR-2719 phase-2 review fixes to Codex's server requests: an MCP tool
 * approval is drawn only on the call it is about, a labelled elicitation is
 * trusted only when it matches a running call and asks for nothing, a secret
 * question is never drawn, answers are keyed by index only, and a replaced
 * request is declined rather than cancelled.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeAppServerHarness, PERSON_HOME } from '../../__tests__/app-server-harness.js';
import {
  CodexServerRequestBroker,
  mapServerRequest,
  SECRET_QUESTION_NOTICE,
  type ServerRequestTurnView,
} from '../server-requests.js';

const harnesses: Array<ReturnType<typeof makeAppServerHarness>> = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
});

const noTurn: ServerRequestTurnView = { inputOf: () => undefined, runningMcpCalls: () => [] };
const running = (
  ...calls: Array<{ id: string; tool: string; arguments: unknown }>
): ServerRequestTurnView => ({
  ...noTurn,
  runningMcpCalls: (server) => (server === 'repo' ? calls : []),
});

/** An MCP tool approval exactly as 0.154 sends it (verified on the binary). */
const mcpApproval = (overrides: Record<string, unknown> = {}) => ({
  id: 4,
  method: 'mcpServer/elicitation/request',
  params: {
    serverName: 'repo',
    mode: 'form',
    message: 'Allow the repo MCP server to run tool "delete_repo"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_params: { name: 'prod' },
    },
    ...overrides,
  },
});

describe('MCP tool approvals', () => {
  it('draw on the one running call of that tool, with its own input', () => {
    const mapped = mapServerRequest(
      mcpApproval(),
      running(
        { id: 'read-1', tool: 'read_file', arguments: { path: 'a' } },
        { id: 'del-1', tool: 'delete_repo', arguments: { name: 'prod' } }
      )
    );
    expect(mapped).toMatchObject({
      kind: 'approval',
      interactionId: 'del-1',
      card: {
        data: { toolName: 'mcp__repo__delete_repo', input: JSON.stringify({ name: 'prod' }) },
      },
    });
    if (!('kind' in mapped)) throw new Error('refused');
    expect(mapped.replies.approve!(false)).toEqual({
      action: 'accept',
      content: null,
      _meta: null,
    });
    expect(mapped.replies.deny).toEqual({ action: 'decline', content: null, _meta: null });
  });

  it('never borrow another call: several of that tool get a card of their own', () => {
    expect(
      mapServerRequest(
        mcpApproval(),
        running(
          { id: 'del-1', tool: 'delete_repo', arguments: { name: 'a' } },
          { id: 'del-2', tool: 'delete_repo', arguments: { name: 'b' } }
        )
      )
    ).toMatchObject({
      kind: 'approval',
      interactionId: 'codex-request-4',
      card: { data: { input: JSON.stringify({ name: 'prod' }) } },
    });
  });

  it('are trusted only when they ask nothing and match a running call of that tool', () => {
    const calls = running({ id: 'del-1', tool: 'delete_repo', arguments: {} });
    const fields = { type: 'object', properties: { token: { type: 'string' } } };
    expect(mapServerRequest(mcpApproval({ requestedSchema: fields }), calls)).toMatchObject({
      kind: 'elicitation',
    });
    expect(
      mapServerRequest(mcpApproval({ mode: 'url', url: 'https://x', elicitationId: 'e' }), calls)
    ).toMatchObject({ kind: 'elicitation' });
    expect(mapServerRequest(mcpApproval(), running())).toMatchObject({ kind: 'elicitation' });
    expect(
      mapServerRequest(mcpApproval(), running({ id: 'r', tool: 'read_file', arguments: {} }))
    ).toMatchObject({ kind: 'elicitation' });
  });
});

describe('questions', () => {
  const question = {
    id: 8,
    method: 'item/tool/requestUserInput',
    params: {
      itemId: 'q1',
      isBlocking: true,
      questions: [
        { id: 'color', header: 'Colour', question: 'Which?', options: [{ label: 'Red' }] },
        { id: 'why', header: '', question: 'Why?', isOther: true },
      ],
    },
  };

  it('answer by index only: never by question id, never by an inherited key', () => {
    const mapped = mapServerRequest(question, noTurn);
    if (!('kind' in mapped)) throw new Error('refused');
    expect(mapped.replies.answer!({ color: 'Blue', why: 'x' })).toEqual({ answers: {} });
    expect(mapped.replies.answer!(Object.create({ '0': 'Inherited' }))).toEqual({ answers: {} });
    // `isOther`: a typed answer goes through as written.
    expect(mapped.replies.answer!({ '1': 'my own words' })).toEqual({
      answers: { why: { answers: ['my own words'] } },
    });
  });

  it('asking for a secret is not drawn; Codex hears nothing and the person is told', async () => {
    const h = makeAppServerHarness();
    harnesses.push(h);
    let reply: unknown;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      reply = await ctx.serverRequest('item/tool/requestUserInput', {
        itemId: 'ask-pw',
        isBlocking: true,
        questions: [{ id: 'pw', header: '', question: 'Password?', isSecret: true }],
      });
      ctx.complete('completed');
    });
    const events = await h.run(h.request({ sessionId: 's1' }));
    expect(events.some((e) => e.type === 'question_prompt')).toBe(false);
    expect(events).toContainEqual({
      type: 'system_status',
      data: { message: SECRET_QUESTION_NOTICE },
    });
    expect(reply).toEqual({ answers: {} });
    expect(SECRET_QUESTION_NOTICE.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});

describe('the broker', () => {
  it('declines, never cancels, a held request a re-sent id replaces (a cancel stops the turn)', async () => {
    const broker = new CodexServerRequestBroker();
    const mapped = mapServerRequest(
      { id: 1, method: 'item/fileChange/requestApproval', params: { itemId: 'p1' } },
      noTurn
    );
    if (!('kind' in mapped)) throw new Error('refused');
    const entry = { sessionId: 's', processKey: 'k', mapped, emit: () => {} };
    const first = broker.open({ ...entry, jsonRpcId: 1 });
    void broker.open({ ...entry, jsonRpcId: 2 });
    await expect(first).resolves.toEqual({ decision: 'decline' });
    broker.dropSession('s');
  });
});

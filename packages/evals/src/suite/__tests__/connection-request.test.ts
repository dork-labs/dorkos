/**
 * Deterministic guard for the connection-request eval (DOR-2415): its tier
 * promise and its oracles, without a model. Each oracle has a real PASS and a
 * real FAIL, so an always-pass oracle is caught.
 */
import { describe, expect, it } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import { emptyApprovalLog, type OracleContext } from '../../types.js';
import { selectSuite } from '../index.js';
import {
  connectionRequestCases,
  connectionRequestFromChatCase,
  replyOffersBothWays,
  requestNamesGmail,
} from '../connection-request.js';

function ctx(frames: SseFrame[]): OracleContext {
  return {
    sandbox: { projectCwd: '/unused', dorkHome: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
    approvals: emptyApprovalLog(),
  } as OracleContext;
}

function call(toolName: string, input: unknown): SseFrame {
  return {
    event: 'tool_call',
    data: { type: 'tool_call', toolCallId: 't', toolName, input: JSON.stringify(input) },
  } as SseFrame;
}

const CALL_NAME = 'mcp__dorkos__connectors.request_connection';

const GMAIL_CALL = call(CALL_NAME, {
  version: 1,
  serviceSlug: 'gmail',
  reason: 'Read today’s mail to summarise it',
  access: 'read',
});

describe('connection-request eval', () => {
  it('is credentialed and quarantined, so a free run skips it and nothing gates on it', () => {
    for (const evalCase of connectionRequestCases) {
      expect(evalCase.runtimeTier).not.toBe('test-mode');
      expect(evalCase.quarantined).toBe(true);
    }
    expect(selectSuite('connector')).toContain(connectionRequestFromChatCase);
  });

  it('never mentions connecting in the prompt, which is the point of the case', () => {
    expect(connectionRequestFromChatCase.prompt).not.toMatch(/connect|access|request/i);
  });

  it('passes on a Gmail request and fails without one', async () => {
    const [invoked] = connectionRequestFromChatCase.oracles;
    expect((await invoked!(ctx([GMAIL_CALL]))).passed).toBe(true);
    expect((await invoked!(ctx([call('mcp__dorkos__Read', {})]))).passed).toBe(false);
    expect((await requestNamesGmail(ctx([GMAIL_CALL]))).passed).toBe(true);
  });

  it('reads a request whose arguments arrive in pieces, as Claude Code streams them', async () => {
    const text = JSON.stringify({
      serviceSlug: 'gmail',
      reason: 'Summarise today',
      access: 'read',
    });
    const piece = (input: string): SseFrame =>
      ({
        event: 'tool_call',
        data: { type: 'tool_call', toolCallId: 'p', toolName: CALL_NAME, input },
      }) as SseFrame;
    const frames = [piece(text.slice(0, 9)), piece(text.slice(9, 30)), piece(text.slice(30))];
    expect((await requestNamesGmail(ctx(frames))).passed).toBe(true);
  });

  it('answers the held request no, so the turn ends instead of timing out', () => {
    expect(connectionRequestFromChatCase.approvalPolicy?.connectionRequests).toBe('deny');
  });

  it('fails a request for the wrong app or with no reason', async () => {
    const slack = call('mcp__dorkos__connectors.request_connection', {
      serviceSlug: 'slack',
      reason: 'x',
    });
    const reasonless = call('mcp__dorkos__connectors.request_connection', {
      serviceSlug: 'gmail',
      reason: '',
    });
    expect((await requestNamesGmail(ctx([slack]))).passed).toBe(false);
    expect((await requestNamesGmail(ctx([reasonless]))).passed).toBe(false);
  });

  it('passes a reply that offers both ways in, and fails one that names only one (FB-57)', async () => {
    const say = (text: string) =>
      ({ event: 'text_delta', data: { type: 'text_delta', text } }) as SseFrame;
    const both = [
      GMAIL_CALL,
      say('You can sign in to a DorkOS account, '),
      say('or use a Composio key.'),
    ];
    expect((await replyOffersBothWays(ctx(both))).passed).toBe(true);
    expect(
      (await replyOffersBothWays(ctx([GMAIL_CALL, say('Link your DorkOS account.')]))).passed
    ).toBe(false);
    expect((await replyOffersBothWays(ctx([GMAIL_CALL]))).passed).toBe(false);
  });
});

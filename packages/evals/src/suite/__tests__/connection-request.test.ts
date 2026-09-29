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

const GMAIL_CALL = call('mcp__dorkos__connectors.request_connection', {
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
});

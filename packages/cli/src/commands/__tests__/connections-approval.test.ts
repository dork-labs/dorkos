/** Approval-response safety tests for `dorkos connections call`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    apiCall: vi.fn(),
    getServerBaseUrl: vi.fn(() => 'http://localhost:4242'),
  };
});

import { apiCall } from '../../lib/api-client.js';
import { runConnectionsDispatcher } from '../connections.js';

const apiCallMock = vi.mocked(apiCall);
const COMMAND = [
  'call',
  'connection/a',
  'revision/a',
  '--agent',
  'agent/a',
  '--input',
  '{"messageId":"m-1"}',
];

function approvalRequired() {
  return {
    status: 'approval_required' as const,
    capabilityId: 'connectors.execute_destructive' as const,
    capabilityTitle: 'Use connector account',
    tier: 'destructive' as const,
    approvalId: 'approval-1',
    approvalToken: 'token-1',
    expiresAt: '2026-09-06T12:15:00.000Z',
    reason: 'no_approval' as const,
    message: 'A person has to approve this first.',
    retry: {
      channel: 'http-header' as const,
      field: 'X-DorkOS-Approval' as const,
      instructions: 'Generic server guidance must not be printed.',
    },
  };
}

function writtenJson(): unknown {
  const value = vi.mocked(process.stdout.write).mock.calls[0]?.[0];
  if (typeof value !== 'string') throw new Error('Expected one JSON string on stdout.');
  return JSON.parse(value);
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('connections call approval response', () => {
  it.each([
    ['an extra success result', { result: { status: 'success', data: null } }],
    ['private owner context', { ownerContext: { ownerId: 'owner-private' } }],
    ['a private provider URL', { authorizeUrl: 'https://provider.example/private' }],
    ['a malformed expiry', { expiresAt: 'not-a-date' }],
    ['an unknown reason', { reason: 'invented_reason' }],
  ])('rejects approval_required with %s before printing', async (_label, extra) => {
    apiCallMock.mockResolvedValue({ ...approvalRequired(), ...extra });

    expect(await runConnectionsDispatcher(COMMAND)).toBe(1);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it('shell-quotes every unsafe retry value while preserving the exact arguments', async () => {
    apiCallMock.mockResolvedValue({
      ...approvalRequired(),
      approvalToken: "token ' $(not-run)",
    });

    expect(
      await runConnectionsDispatcher([
        'call',
        "connection '$(not-run)",
        'revision;one',
        '--agent',
        'agent one',
        '--input',
        '{"message":"it is $HOME; `not-run`"}',
      ])
    ).toBe(1);

    const output = writtenJson() as { retry: { instructions: string } };
    expect(output.retry.instructions).toContain('dorkos connections call');
    expect(output.retry.instructions).toContain("'connection '\"'\"'$(not-run)'");
    expect(output.retry.instructions).toContain("'revision;one'");
    expect(output.retry.instructions).toContain("--agent 'agent one'");
    expect(output.retry.instructions).toContain("--approval 'token '\"'\"' $(not-run)'");
    expect(output.retry.instructions).toContain(
      `--input '${JSON.stringify({ message: 'it is $HOME; `not-run`' })}'`
    );
    expect(output.retry.instructions).not.toContain('Generic server guidance');
  });
});

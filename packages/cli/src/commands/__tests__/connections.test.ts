/** Tests for the scoped `dorkos connections` command. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: string; code?: string }
    ) {
      super(body.error ?? `HTTP ${status}`);
    }
  }
  return {
    ApiError,
    apiCall: vi.fn(),
    getServerBaseUrl: vi.fn(() => 'http://localhost:4242'),
  };
});

import { ApiError, apiCall, getServerBaseUrl } from '../../lib/api-client.js';
import { CONNECTIONS_HELP, runConnectionsDispatcher } from '../connections.js';

const apiCallMock = vi.mocked(apiCall);
const serverBaseUrlMock = vi.mocked(getServerBaseUrl);

function writtenJson(): unknown {
  const value = vi.mocked(process.stdout.write).mock.calls[0]?.[0];
  if (typeof value !== 'string') throw new Error('Expected one JSON string on stdout.');
  return JSON.parse(value);
}

const CONNECTIONS = {
  connections: [
    {
      connectionId: 'connection/a',
      toolkit: 'GMAIL',
      label: 'Work mail',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
  ],
};

const OPERATIONS = {
  connectionId: 'connection/a',
  operations: [
    {
      operationRevisionId: 'revision/a',
      toolkit: 'GMAIL',
      operationSlug: 'GMAIL_FETCH_MESSAGE',
      toolkitVersion: '20260901_00',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: { type: 'object', required: ['messageId'] },
    },
  ],
};

const USAGE = {
  items: [
    {
      logicalOperationId: 'logical-1',
      attemptIndex: 1,
      surface: 'cli',
      actorKind: 'program',
      agentId: 'agent/a',
      connectionId: 'connection/a',
      toolkit: 'GMAIL',
      operationRevisionId: 'revision/a',
      operationSlug: 'GMAIL_FETCH_MESSAGE',
      payer: 'dorkos_managed',
      outcome: 'success',
      startedAt: '2026-09-06T12:00:00.000Z',
      completedAt: '2026-09-06T12:00:01.000Z',
    },
  ],
  nextCursor: 'cursor/next',
};

function pendingReview(reviewRequestId = 'review/one') {
  return {
    reviewRequestId,
    reviewUrl: `/connections?review=${encodeURIComponent(reviewRequestId)}`,
    state: 'pending',
    targetStatus: 'available',
    expiresAt: '2026-09-06T12:15:00.000Z',
  };
}

function resolvedReview(
  state: 'expired' | 'denied' | 'approved',
  outcome?: 'denied' | 'applied' | 'authentication_required' | 'outcome_unknown'
) {
  return {
    reviewRequestId: `review-${state}`,
    reviewUrl: `/connections?review=review-${state}`,
    state,
    targetStatus: 'available',
    expiresAt: '2026-09-06T12:15:00.000Z',
    resolvedAt: '2026-09-06T12:10:00.000Z',
    ...(outcome ? { outcome } : {}),
  };
}

function resolvingReview() {
  return {
    reviewRequestId: 'review-resolving',
    reviewUrl: '/connections?review=review-resolving',
    state: 'resolving' as const,
    targetStatus: 'available' as const,
    expiresAt: '2026-09-06T12:15:00.000Z',
    resolvedAt: '2026-09-06T12:10:00.000Z',
  };
}

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

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  serverBaseUrlMock.mockReturnValue('http://localhost:4242');
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('connections dispatcher', () => {
  it('shows help and rejects a missing or unknown subcommand', async () => {
    expect(await runConnectionsDispatcher([])).toBe(1);
    expect(await runConnectionsDispatcher(['--help'])).toBe(0);
    expect(await runConnectionsDispatcher(['frobnicate'])).toBe(1);
    expect(console.log).toHaveBeenCalledWith(CONNECTIONS_HELP);
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it.each([
    ['list'],
    ['schema', 'connection-a'],
    ['call', 'connection-a', 'revision-a'],
    ['usage'],
  ])('requires --agent before %s makes an HTTP call', async (...args) => {
    expect(await runConnectionsDispatcher(args)).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalled();
  });
});

describe('connections list and schema', () => {
  it('calls the agent-scoped list route and preserves the raw envelope for --json', async () => {
    apiCallMock.mockResolvedValue(CONNECTIONS);

    expect(await runConnectionsDispatcher(['list', '--agent', ' agent/a ', '--json'])).toBe(0);

    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/connectors/accessible?agentId=agent%2Fa');
    expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(CONNECTIONS, null, 2)}\n`);
  });

  it('renders a human connection table', async () => {
    apiCallMock.mockResolvedValue(CONNECTIONS);

    expect(await runConnectionsDispatcher(['list', '--agent', 'agent-a'])).toBe(0);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Work mail'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('RECONCILIATION'));
  });

  it('encodes the connection and agent and shows the exact revision schema in JSON', async () => {
    apiCallMock.mockResolvedValue(OPERATIONS);

    expect(
      await runConnectionsDispatcher(['schema', 'connection/a', '--agent', 'agent/a', '--json'])
    ).toBe(0);

    expect(apiCallMock).toHaveBeenCalledWith(
      'GET',
      '/api/connectors/accessible/connection%2Fa/operations?agentId=agent%2Fa'
    );
    expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(OPERATIONS, null, 2)}\n`);
  });

  it('rejects malformed success data instead of printing it as granted access', async () => {
    apiCallMock.mockResolvedValue({ connections: [{ connectionId: 'connection-a' }] });

    expect(await runConnectionsDispatcher(['list', '--agent', 'agent-a'])).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error:'));
  });
});

describe('connections call', () => {
  const command = [
    'call',
    'connection/a',
    'revision/a',
    '--agent',
    'agent/a',
    '--input',
    '{"messageId":"m-1"}',
  ];

  it('uses the CLI-attributed endpoint with exact stable ids and arguments', async () => {
    const response = {
      logicalOperationId: 'logical-1',
      attemptCount: 1,
      result: { status: 'success', data: { subject: 'Hello' } },
    };
    apiCallMock.mockResolvedValue(response);

    expect(await runConnectionsDispatcher(command)).toBe(0);

    expect(apiCallMock).toHaveBeenCalledWith(
      'POST',
      '/api/connectors/cli/executions',
      {
        agentId: 'agent/a',
        connectionId: 'connection/a',
        operationRevisionId: 'revision/a',
        arguments: { messageId: 'm-1' },
      },
      undefined
    );
    expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(response, null, 2)}\n`);
  });

  it('puts an approval token in the existing HTTP header without changing the body', async () => {
    apiCallMock.mockResolvedValue({
      logicalOperationId: 'logical-1',
      attemptCount: 1,
      result: { status: 'success', data: null },
    });

    expect(await runConnectionsDispatcher([...command, '--approval', ' token-1 '])).toBe(0);

    expect(apiCallMock).toHaveBeenCalledWith(
      'POST',
      '/api/connectors/cli/executions',
      expect.not.objectContaining({ approvalToken: expect.anything() }),
      { 'X-DorkOS-Approval': 'token-1' }
    );
  });

  it.each([
    { status: 'error', code: 'UPSTREAM', message: 'Provider refused the call.' },
    {
      status: 'cancelled',
      code: 'CANCELLED_BEFORE_DISPATCH',
      message: 'The call was cancelled.',
    },
    { status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN', message: 'Check before retrying.' },
    { status: 'unsupported', reason: 'This operation is unavailable.' },
  ])('prints %s and exits nonzero without retrying', async (result) => {
    apiCallMock.mockResolvedValue({ logicalOperationId: 'logical-1', attemptCount: 1, result });

    expect(await runConnectionsDispatcher(command)).toBe(1);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining(result.status));
  });

  it('preserves approval_required as structured output and does not retry', async () => {
    const approval = approvalRequired();
    apiCallMock.mockResolvedValue(approval);

    expect(await runConnectionsDispatcher(command)).toBe(1);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(writtenJson()).toEqual({
      ...approval,
      retry: {
        channel: 'http-header',
        field: 'X-DorkOS-Approval',
        instructions:
          `Once approved, retry exactly: dorkos connections call connection/a revision/a ` +
          `--agent agent/a --approval token-1 --input '{"messageId":"m-1"}'. ` +
          'Changing any value invalidates the approval.',
      },
    });
  });

  it.each([
    { args: [...command, '--input-file', 'arguments.json'] },
    { args: ['call', 'connection-a', 'revision-a', '--agent', 'agent-a', '--input', '[]'] },
    { args: ['call', 'connection-a', 'revision-a', '--agent', 'agent-a', '--input', '{bad'] },
    { args: ['call', 'connection-a', 'revision-a', 'extra', '--agent', 'agent-a'] },
  ])('rejects invalid arguments before HTTP: $args', async ({ args }) => {
    expect(await runConnectionsDispatcher(args)).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it('surfaces a server refusal and leaves stdout empty', async () => {
    apiCallMock.mockRejectedValue(
      new ApiError(403, {
        error: 'Connector program call refused.',
        code: 'CONNECTOR_PROGRAM_AGENT_IDENTITY_DENIED',
      })
    );

    expect(await runConnectionsDispatcher(command)).toBe(1);
    expect(console.error).toHaveBeenCalledWith('Error: Connector program call refused.');
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});

describe('connections usage', () => {
  it('forwards only the explicit agent and bounded pagination fields', async () => {
    apiCallMock.mockResolvedValue(USAGE);

    expect(
      await runConnectionsDispatcher([
        'usage',
        '--agent',
        'agent/a',
        '--cursor',
        'cursor/one',
        '--limit',
        '25',
        '--json',
      ])
    ).toBe(0);

    expect(apiCallMock).toHaveBeenCalledWith(
      'GET',
      '/api/connectors/usage/agent?agentId=agent%2Fa&cursor=cursor%2Fone&limit=25'
    );
    expect(process.stdout.write).toHaveBeenCalledWith(`${JSON.stringify(USAGE, null, 2)}\n`);
  });

  it.each(['0', '101', '1.5', 'many'])('rejects invalid limit %s before HTTP', async (limit) => {
    expect(await runConnectionsDispatcher(['usage', '--agent', 'agent-a', '--limit', limit])).toBe(
      1
    );
    expect(apiCallMock).not.toHaveBeenCalled();
  });
});

describe('connections management review handoff', () => {
  const request = [
    'request',
    '--action',
    '{"version":1,"kind":"pause","connectionId":"connection/a"}',
    '--idempotency-key',
    'pause-connection-a',
  ];

  it('creates the strict request and opens only the fixed DorkOS app route', async () => {
    apiCallMock.mockResolvedValue(pendingReview());
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher(request, { openUrl, isTty: true })).toBe(2);

    expect(apiCallMock).toHaveBeenCalledWith('POST', '/api/connectors/reviews', {
      action: { version: 1, kind: 'pause', connectionId: 'connection/a' },
      idempotencyKey: 'pause-connection-a',
    });
    expect(openUrl).toHaveBeenCalledWith('http://localhost:4242/connections?review=review%2Fone');
    expect(console.log).toHaveBeenCalledWith('Review: review/one');
    expect(console.log).toHaveBeenCalledWith('State: pending');
    expect(console.log).toHaveBeenCalledWith('Expires: 2026-09-06T12:15:00.000Z');
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });

  it('prints the safe URL without opening for --print or a non-interactive caller', async () => {
    apiCallMock.mockResolvedValue(pendingReview('review-two'));
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher([...request, '--print'], { openUrl, isTty: true })).toBe(
      2
    );
    expect(openUrl).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('http://localhost:4242/connections?review=review-two');

    vi.clearAllMocks();
    apiCallMock.mockResolvedValue(pendingReview('review-three'));
    expect(await runConnectionsDispatcher(request, { openUrl, isTty: false })).toBe(2);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('prints a machine-readable pending state and safe URL without opening', async () => {
    apiCallMock.mockResolvedValue(pendingReview());
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher([...request, '--json'], { openUrl, isTty: true })).toBe(
      2
    );
    expect(openUrl).not.toHaveBeenCalled();
    expect(writtenJson()).toEqual({
      reviewRequestId: 'review/one',
      state: 'pending',
      targetStatus: 'available',
      expiresAt: '2026-09-06T12:15:00.000Z',
      reviewUrl: 'http://localhost:4242/connections?review=review%2Fone',
    });
  });

  it('reports an already-resolved idempotent request without reopening it for a decision', async () => {
    apiCallMock.mockResolvedValue(resolvedReview('approved', 'applied'));
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher(request, { openUrl, isTty: true })).toBe(0);

    expect(openUrl).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('State: approved');
    expect(console.log).toHaveBeenCalledWith('Outcome: applied');
    expect(console.log).not.toHaveBeenCalledWith(
      'Nothing changes until the owner approves it there.'
    );
  });

  it.each([
    {
      args: ['request', '--action', '{"version":1,"kind":"pause"}', '--idempotency-key', 'key'],
    },
    {
      args: [
        'request',
        '--action',
        '{"version":1,"kind":"pause","connectionId":"c","ownerId":"owner"}',
        '--idempotency-key',
        'key',
      ],
    },
    {
      args: [
        'request',
        '--action',
        '{"version":1,"kind":"set_agent_access","connectionId":"c","agentId":"a","operationRevisionIds":["r","r"]}',
        '--idempotency-key',
        'key',
      ],
    },
    { args: ['request', '--action', '{"version":1,"kind":"pause","connectionId":"c"}'] },
    {
      args: [
        'request',
        '--action',
        '{"version":1,"kind":"pause","connectionId":"c"}',
        '--idempotency-key',
        'key',
        '--print',
        '--json',
      ],
    },
  ])('rejects an invalid management request before HTTP: $args', async ({ args }) => {
    expect(await runConnectionsDispatcher(args)).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalled();
  });

  it('does not open a URL when the server response is malformed', async () => {
    apiCallMock.mockResolvedValue({
      reviewRequestId: 'review-one',
      reviewUrl: 'https://evil.test',
    });
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher(request, { openUrl, isTty: true })).toBe(1);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('rejects a review link that does not canonically encode the returned id', async () => {
    apiCallMock.mockResolvedValue({
      ...pendingReview(),
      reviewUrl: '/connections?review=another-review',
    });
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher(request, { openUrl, isTty: true })).toBe(1);
    expect(openUrl).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Error: DorkOS returned an invalid connector review link.'
    );
  });

  it('refuses to construct a review link from a non-local server base', async () => {
    apiCallMock.mockResolvedValue(pendingReview());
    serverBaseUrlMock.mockReturnValue('https://example.test');
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher(request, { openUrl, isTty: true })).toBe(1);
    expect(openUrl).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Error: DorkOS refused to open a connector review outside the local app.'
    );
  });
});

describe('connections requester-safe review status', () => {
  it('encodes the review id, renders the safe status, and does not open a browser', async () => {
    apiCallMock.mockResolvedValue(pendingReview());
    const openUrl = vi.fn(() => true);

    expect(await runConnectionsDispatcher(['status', 'review/one'], { openUrl, isTty: true })).toBe(
      2
    );

    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/connectors/program/reviews/review%2Fone');
    expect(openUrl).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('Review: review/one');
    expect(console.log).toHaveBeenCalledWith('State: pending');
    expect(console.log).toHaveBeenCalledWith(
      'Open in the DorkOS app: http://localhost:4242/connections?review=review%2Fone'
    );
  });

  it.each([
    [resolvingReview(), 2],
    [resolvedReview('expired'), 5],
    [resolvedReview('denied', 'denied'), 3],
    [resolvedReview('approved', 'applied'), 0],
    [resolvedReview('approved', 'authentication_required'), 7],
    [resolvedReview('approved', 'outcome_unknown'), 6],
  ] as const)(
    'prints the typed $state/$outcome response with exit $1',
    async (review, exitCode) => {
      apiCallMock.mockResolvedValue(review);

      expect(await runConnectionsDispatcher(['status', review.reviewRequestId, '--json'])).toBe(
        exitCode
      );

      expect(writtenJson()).toEqual({
        ...review,
        reviewUrl: `http://localhost:4242${review.reviewUrl}`,
      });
    }
  );

  it('distinguishes an unavailable target from an awaiting review', async () => {
    apiCallMock.mockResolvedValue({
      ...pendingReview('review-unavailable'),
      targetStatus: 'unavailable',
    });

    expect(await runConnectionsDispatcher(['status', 'review-unavailable', '--json'])).toBe(4);
    expect(writtenJson()).toMatchObject({ state: 'pending', targetStatus: 'unavailable' });
  });

  it('distinguishes an indeterminate resolution from an upstream request failure', async () => {
    apiCallMock.mockRejectedValueOnce(
      new ApiError(409, { error: 'This review is still resolving.', code: 'review_resolving' })
    );
    expect(await runConnectionsDispatcher(['status', 'review-one'])).toBe(6);

    apiCallMock.mockRejectedValueOnce(new ApiError(503, { error: 'Provider unavailable.' }));
    expect(await runConnectionsDispatcher(['status', 'review-one'])).toBe(1);
  });

  it('rejects malformed or mismatched status before printing it', async () => {
    apiCallMock.mockResolvedValue({
      ...pendingReview('review-one'),
      reviewUrl: '/connections?review=review-two',
    });

    expect(await runConnectionsDispatcher(['status', 'review-one', '--json'])).toBe(1);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Error: DorkOS returned an invalid connector review link.'
    );
  });

  it('binds a status response to the exact requested review id before printing', async () => {
    apiCallMock.mockResolvedValue(pendingReview('review-two'));

    expect(await runConnectionsDispatcher(['status', 'review-one', '--json'])).toBe(1);
    expect(apiCallMock).toHaveBeenCalledWith('GET', '/api/connectors/program/reviews/review-one');
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'Error: DorkOS returned a connector review for a different request.'
    );
  });

  it.each([
    new ApiError(403, { error: 'Connector program review refused.' }),
    new ApiError(404, { error: 'Connector review request not found.' }),
  ])('returns nonzero for a requester refusal without retrying', async (error) => {
    apiCallMock.mockRejectedValue(error);

    expect(await runConnectionsDispatcher(['status', 'review-one'])).toBe(1);
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it('requires exactly one review id before making HTTP calls', async () => {
    expect(await runConnectionsDispatcher(['status'])).toBe(1);
    expect(await runConnectionsDispatcher(['status', 'one', 'two'])).toBe(1);
    expect(apiCallMock).not.toHaveBeenCalled();
  });
});

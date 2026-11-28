/** The approval reads and decisions send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApprovalMethods } from '../approval-methods';
import { answer, firstRequest } from './request-stub';

/** The first request, with `fetch`'s own GET default named. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const request = firstRequest(fetchMock);
  return { ...request, method: request.method ?? 'GET' };
}

afterEach(() => vi.unstubAllGlobals());

describe('createApprovalMethods', () => {
  const methods = createApprovalMethods('/api');

  it('reads approvals and decides them at the same paths and bodies', async () => {
    const calls: Array<[() => Promise<unknown>, ReturnType<typeof sent>]> = [
      [
        () => methods.listDeclinedHookApprovals(),
        { url: '/api/approvals/declined-hooks', method: 'GET', body: undefined },
      ],
      [
        () => methods.listPendingApprovals(),
        { url: '/api/approvals/pending', method: 'GET', body: undefined },
      ],
      [
        () => methods.getApprovalFullDetail('a 1/x'),
        { url: '/api/approvals/a%201%2Fx/full-detail', method: 'GET', body: undefined },
      ],
      [
        () => methods.denyApproval('a1', 'Not now'),
        { url: '/api/approvals/a1/deny', method: 'POST', body: '{"reason":"Not now"}' },
      ],
      [
        () => methods.denyApproval('a1'),
        { url: '/api/approvals/a1/deny', method: 'POST', body: '{}' },
      ],
      [
        () => methods.grantApproval('a 1/x'),
        { url: '/api/approvals/a%201%2Fx/grant', method: 'POST', body: undefined },
      ],
      [
        () => methods.grantApproval('a1', { answer: 'once' }),
        { url: '/api/approvals/a1/grant', method: 'POST', body: undefined },
      ],
      [
        () => methods.grantApproval('a1', { answer: 'always' }),
        { url: '/api/approvals/a1/grant', method: 'POST', body: '{"answer":"always"}' },
      ],
      [
        () => methods.askAgainHookApproval('a/1'),
        { url: '/api/approvals/a%2F1/ask-again', method: 'POST', body: undefined },
      ],
      [
        () => methods.dismissAlwaysSuggestion('a/1'),
        { url: '/api/approvals/a%2F1/dismiss-suggestion', method: 'POST', body: undefined },
      ],
    ];
    for (const [call, expected] of calls) {
      const fetchMock = answer({});
      await call();
      expect(sent(fetchMock)).toEqual(expected);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    }
  });
});

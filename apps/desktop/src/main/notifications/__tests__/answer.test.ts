import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron-log', () => import('../../__tests__/electron-log-mock'));

import log from 'electron-log';
import {
  approveTool,
  denyTool,
  submitReplyAnswer,
  resetAnswerLogGuard,
  type AnswerOutcome,
} from '../answer';
import { resetLogMock } from '../../__tests__/electron-log-mock';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetAnswerLogGuard();
  resetLogMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number): Response {
  return new Response(null, { status });
}

describe('approveTool', () => {
  it('POSTs the exact approve payload the cockpit sends', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    await approveTool(() => 4242, 'session-1', 'tool-1');

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4242/api/sessions/session-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-1' }),
    });
  });

  it('URL-encodes the session id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    await approveTool(() => 4242, 'a session/1', 'tool-1');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://127.0.0.1:4242/api/sessions/a%20session%2F1/approve');
  });
});

describe('denyTool', () => {
  it('POSTs the exact deny payload, with no reason', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    await denyTool(() => 4242, 'session-1', 'tool-1');

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4242/api/sessions/session-1/deny', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-1' }),
    });
  });
});

describe('submitReplyAnswer', () => {
  it('POSTs the reply text as the answer to question 0', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    await submitReplyAnswer(() => 4242, 'session-1', 'question-1', 'Blue, please');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4242/api/sessions/session-1/submit-answers',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId: 'question-1', answers: { '0': 'Blue, please' } }),
      }
    );
  });
});

describe('outcomes', () => {
  it('reports no-server without touching the network when no port is up yet', async () => {
    const outcome = await approveTool(() => null, 'session-1', 'tool-1');
    expect(outcome).toEqual<AnswerOutcome>({ ok: false, reason: 'no-server' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unauthorized on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401));
    const outcome = await approveTool(() => 4242, 'session-1', 'tool-1');
    expect(outcome).toEqual<AnswerOutcome>({ ok: false, reason: 'unauthorized' });
  });

  it('reports unauthorized on 403', async () => {
    fetchMock.mockResolvedValue(jsonResponse(403));
    const outcome = await denyTool(() => 4242, 'session-1', 'tool-1');
    expect(outcome).toEqual<AnswerOutcome>({ ok: false, reason: 'unauthorized' });
  });

  it('reports refused on any other non-OK status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409));
    const outcome = await approveTool(() => 4242, 'session-1', 'tool-1');
    expect(outcome).toEqual<AnswerOutcome>({ ok: false, reason: 'refused' });
  });

  it('reports network when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const outcome = await approveTool(() => 4242, 'session-1', 'tool-1');
    expect(outcome).toEqual<AnswerOutcome>({ ok: false, reason: 'network' });
  });

  it('reports ok on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    const outcome = await approveTool(() => 4242, 'session-1', 'tool-1');
    expect(outcome).toEqual<AnswerOutcome>({ ok: true });
  });

  it('logs an unauthorized outage once, not once per click', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401));
    await approveTool(() => 4242, 'session-1', 'tool-1');
    await denyTool(() => 4242, 'session-2', 'tool-2');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('logs again after a later success clears the outage', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401));
    await approveTool(() => 4242, 'session-1', 'tool-1');
    fetchMock.mockResolvedValueOnce(jsonResponse(200));
    await approveTool(() => 4242, 'session-1', 'tool-1');
    fetchMock.mockResolvedValueOnce(jsonResponse(401));
    await approveTool(() => 4242, 'session-1', 'tool-1');
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

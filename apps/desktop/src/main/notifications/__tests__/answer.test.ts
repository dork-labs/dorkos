import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { canStageIpv6OnlyLocalhost } from '../../__tests__/ipv6-loopback';

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

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4242/api/sessions/session-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-1' }),
    });
  });

  it('URL-encodes the session id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    await approveTool(() => 4242, 'a session/1', 'tool-1');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:4242/api/sessions/a%20session%2F1/approve');
  });
});

describe('denyTool', () => {
  it('POSTs the exact deny payload, with no reason', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));
    await denyTool(() => 4242, 'session-1', 'tool-1');

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4242/api/sessions/session-1/deny', {
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
      'http://localhost:4242/api/sessions/session-1/submit-answers',
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

describe.skipIf(!(await canStageIpv6OnlyLocalhost()))('the host it dials (DOR-4294)', () => {
  // The server binds `localhost`, which on macOS is routinely `::1` alone. The
  // shell used to post to `127.0.0.1` and was refused, so Allow on a desktop
  // notification quietly did nothing. This stages that server on a real socket,
  // with the real `fetch`.
  let server: http.Server;
  let port = 0;
  const received: { method?: string; url?: string; body: string }[] = [];

  beforeEach(async () => {
    vi.unstubAllGlobals();
    received.length = 0;
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        received.push({ method: req.method, url: req.url, body });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers through a server that listens only on IPv6 loopback', async () => {
    const outcome = await approveTool(() => port, 'session-1', 'tool-1');

    expect(outcome).toEqual({ ok: true });
    expect(received).toEqual([
      {
        method: 'POST',
        url: '/api/sessions/session-1/approve',
        body: JSON.stringify({ toolCallId: 'tool-1' }),
      },
    ]);
  });
});

describe('the host it dials, on IPv4 loopback (DOR-4294)', () => {
  // The other half: a server whose `localhost` came out as `127.0.0.1` only.
  // Where `::1` is listed first, the real `fetch` has to fall through to it.
  let server: http.Server;
  let port = 0;

  beforeEach(async () => {
    vi.unstubAllGlobals();
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200).end());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers through a server that listens only on IPv4 loopback', async () => {
    expect(await denyTool(() => port, 'session-1', 'tool-1')).toEqual({ ok: true });
  });
});

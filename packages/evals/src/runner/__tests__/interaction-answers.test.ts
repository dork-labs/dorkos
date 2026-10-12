/**
 * The approval driver's two non-permission answers (`runner/interaction-answers.ts`),
 * against a real loopback server that records every request: a held connection
 * request answered "no" through the owner route, so a turn whose right move is
 * asking for an app can END instead of timing out, and a question card answered
 * so the turn goes on. Both only when the case's policy asks for them.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import { ApprovalDriver } from '../approval-driver.js';
import { PENDING_CONNECTION_REQUESTS_PATH, questionCards } from '../interaction-answers.js';
import type { ApprovalPolicy } from '../../types.js';

interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('ApprovalDriver: connection requests and question cards', () => {
  let server: http.Server;
  let baseUrl: string;
  let seen: SeenRequest[];
  let pending: Array<{ requestId: string; status: string }>;

  beforeEach(async () => {
    seen = [];
    pending = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === PENDING_CONNECTION_REQUESTS_PATH) {
          res.end(JSON.stringify({ requests: pending }));
          return;
        }
        const decided = /^\/api\/connectors\/agent-requests\/([^/]+)\/decision$/.exec(
          req.url ?? ''
        );
        if (decided) pending = pending.filter((r) => r.requestId !== decided[1]);
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function driver(policy: ApprovalPolicy): ApprovalDriver {
    return new ApprovalDriver({ baseUrl, policy, pollIntervalMs: 10 });
  }

  const card: SseFrame = {
    event: 'question_prompt',
    data: {
      type: 'question_prompt',
      id: 'q1',
      questions: [{ question: 'Which order?' }, { question: 'Send now?' }],
    },
  } as SseFrame;

  it('denies a held connection request through the owner route, once, so the turn can end', async () => {
    pending = [{ requestId: 'req-1', status: 'awaiting_owner' }];
    const d = driver({ allowTools: [], connectionRequests: 'deny' });
    d.start();
    await until(() => d.log.connectionRequests.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await d.stop();

    const decisions = seen.filter((r) => r.url.endsWith('/decision'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.url).toBe('/api/connectors/agent-requests/req-1/decision');
    expect(JSON.parse(decisions[0]!.body)).toEqual({ decision: 'denied' });
    // A person's answer, never a program's: the owner boundary refuses these.
    expect(decisions[0]!.headers['x-dorkos-agent']).toBeUndefined();
    expect(decisions[0]!.headers['x-dorkos-approval']).toBeUndefined();
    expect(decisions[0]!.headers.origin).toBeUndefined();
    expect(d.log.connectionRequests[0]).toMatchObject({ requestId: 'req-1', decision: 'denied' });
    expect(d.log.errors).toEqual([]);
  });

  it('leaves connection requests alone when the policy does not ask', async () => {
    pending = [{ requestId: 'req-1', status: 'awaiting_owner' }];
    const d = driver({ allowTools: [] });
    d.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await d.stop();
    expect(seen).toEqual([]);
  });

  it('answers every question on a card, keyed by index, and only once', async () => {
    const d = driver({ allowTools: [], answerQuestions: 'Use your best judgment.' });
    d.start();
    d.observe([card], 'sess-1');
    d.observe([card], 'sess-1');
    await d.stop();
    const answers = seen.filter((r) => r.url.endsWith('/submit-answers'));
    expect(answers).toHaveLength(1);
    expect(answers[0]!.url).toBe('/api/sessions/sess-1/submit-answers');
    expect(JSON.parse(answers[0]!.body)).toEqual({
      toolCallId: 'q1',
      answers: { '0': 'Use your best judgment.', '1': 'Use your best judgment.' },
    });
    expect(d.log.questions).toHaveLength(1);
  });

  it('leaves a question card alone when the policy does not ask', async () => {
    const d = driver({ allowTools: [] });
    d.start();
    d.observe([card], 'sess-1');
    await d.stop();
    expect(seen).toEqual([]);
  });

  it('reads cards off either the event line or the payload type, and skips one with no id', () => {
    const byType = { event: '', data: { type: 'question_prompt', id: 'q2', questions: [] } };
    const noId = { event: 'question_prompt', data: { type: 'question_prompt', questions: [] } };
    expect(questionCards([card, byType, noId] as SseFrame[])).toEqual([
      { toolCallId: 'q1', count: 2 },
      { toolCallId: 'q2', count: 1 },
    ]);
  });
});

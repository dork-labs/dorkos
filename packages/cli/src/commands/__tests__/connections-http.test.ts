/** Hermetic HTTP proof for the Connections dispatcher and shared CLI API client. */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConnectionsDispatcher } from '../connections.js';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

let server: http.Server | undefined;

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<number> {
  server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
    server = undefined;
  }
});

describe('connections real HTTP seam', () => {
  it('distinguishes requester-safe review lifecycle outcomes over real HTTP', async () => {
    const captured: CapturedRequest[] = [];
    const port = await listen((request, response) => {
      captured.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: undefined,
      });
      const id = request.url?.split('/').at(-1);
      if (id === 'unknown') {
        response.writeHead(409, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({ error: 'Review resolution is indeterminate.', code: 'review_resolving' })
        );
        return;
      }
      if (id === 'upstream') {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Connector review service unavailable.' }));
        return;
      }
      const now = '2026-09-06T12:00:00.000Z';
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          reviewRequestId: id,
          reviewUrl: `/connections?review=${id}`,
          targetStatus: id === 'unavailable' ? 'unavailable' : 'available',
          expiresAt: '2026-09-06T12:15:00.000Z',
          ...(id === 'applied'
            ? { state: 'approved', resolvedAt: now, outcome: 'applied' }
            : id === 'indeterminate'
              ? { state: 'approved', resolvedAt: now, outcome: 'outcome_unknown' }
              : { state: 'pending' }),
        })
      );
    });
    vi.stubEnv('DORKOS_PORT', String(port));
    vi.stubEnv('DORKOS_API_KEY', 'program-key');

    await expect(runConnectionsDispatcher(['status', 'pending', '--json'])).resolves.toBe(2);
    await expect(runConnectionsDispatcher(['status', 'unavailable', '--json'])).resolves.toBe(4);
    await expect(runConnectionsDispatcher(['status', 'applied', '--json'])).resolves.toBe(0);
    await expect(runConnectionsDispatcher(['status', 'indeterminate', '--json'])).resolves.toBe(6);
    await expect(runConnectionsDispatcher(['status', 'unknown', '--json'])).resolves.toBe(6);
    await expect(runConnectionsDispatcher(['status', 'upstream', '--json'])).resolves.toBe(1);

    expect(captured).toHaveLength(6);
    expect(captured.every((request) => request.method === 'GET')).toBe(true);
    expect(
      captured.every((request) => request.headers.authorization === 'Bearer program-key')
    ).toBe(true);
  });

  it('sends both identities and never retries an outcome-unknown execution', async () => {
    const captured: CapturedRequest[] = [];
    const port = await listen((request, response) => {
      void readJsonBody(request).then((body) => {
        captured.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            logicalOperationId: 'logical-1',
            attemptCount: 1,
            result: {
              status: 'outcome_unknown',
              code: 'OUTCOME_UNKNOWN',
              message: 'The provider may have accepted the write. Check before retrying.',
            },
          })
        );
      });
    });
    vi.stubEnv('DORKOS_PORT', String(port));
    vi.stubEnv('DORKOS_API_KEY', 'program-key');
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'inherited-agent-token');

    const exitCode = await runConnectionsDispatcher([
      'call',
      'connection/one',
      'revision/one',
      '--agent',
      'agent/one',
      '--input',
      '{"recipient":"person@example.com"}',
    ]);

    expect(exitCode).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: 'POST',
      url: '/api/connectors/cli/executions',
      body: {
        agentId: 'agent/one',
        connectionId: 'connection/one',
        operationRevisionId: 'revision/one',
        arguments: { recipient: 'person@example.com' },
      },
    });
    expect(captured[0]?.headers.authorization).toBe('Bearer program-key');
    expect(captured[0]?.headers['x-dorkos-agent']).toBe('inherited-agent-token');
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('outcome_unknown'));
  });

  it('replaces generic approval guidance with one exact safely quoted Connections retry', async () => {
    const captured: CapturedRequest[] = [];
    const port = await listen((request, response) => {
      void readJsonBody(request).then((body) => {
        captured.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        });
        response.writeHead(202, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'approval_required',
            capabilityId: 'connectors.execute_destructive',
            capabilityTitle: 'Execute a destructive account operation',
            tier: 'destructive',
            approvalId: 'approval-1',
            approvalToken: "token ' $(not-run)",
            expiresAt: '2026-09-06T12:15:00.000Z',
            reason: 'no_approval',
            message: 'A person has to approve this first.',
            retry: {
              channel: 'http-header',
              field: 'X-DorkOS-Approval',
              instructions: 'dorkos call <id> --approval <token>',
            },
          })
        );
      });
    });
    vi.stubEnv('DORKOS_PORT', String(port));
    vi.stubEnv('DORKOS_API_KEY', 'program-key');
    vi.stubEnv('DORKOS_AGENT_TOKEN', 'inherited-agent-token');

    const exitCode = await runConnectionsDispatcher([
      'call',
      'connection one',
      'revision;one',
      '--agent',
      'agent one',
      '--input',
      '{"message":"it is $HOME; `not-run`"}',
    ]);

    expect(exitCode).toBe(1);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      method: 'POST',
      url: '/api/connectors/cli/executions',
      body: {
        agentId: 'agent one',
        connectionId: 'connection one',
        operationRevisionId: 'revision;one',
        arguments: { message: 'it is $HOME; `not-run`' },
      },
    });
    expect(captured[0]?.headers.authorization).toBe('Bearer program-key');
    expect(captured[0]?.headers['x-dorkos-agent']).toBe('inherited-agent-token');
    const written = vi.mocked(process.stdout.write).mock.calls[0]?.[0];
    expect(typeof written).toBe('string');
    const output = JSON.parse(written as string) as { retry: { instructions: string } };
    expect(output.retry.instructions).toContain(
      `dorkos connections call 'connection one' 'revision;one' --agent 'agent one'`
    );
    expect(output.retry.instructions).toContain(`--approval 'token '"'"' $(not-run)'`);
    expect(output.retry.instructions).toContain(`--input '{"message":"it is $HOME; \`not-run\`"}'`);
    expect(output.retry.instructions).not.toContain('dorkos call <id>');
  });
});

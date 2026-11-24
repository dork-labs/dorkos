import { describe, it, expect, vi } from 'vitest';
import {
  requestManagedConnectorExecutionReceipt,
  requestManagedConnectorAuthentication,
  requestManagedConnectorCatalog,
  submitManagedConnectorAuthorityCommand,
} from '../../cloud-link-client.js';
import { BASE } from './cloud-link-client.fixtures.js';

describe('managed connector authority commands', () => {
  const command = {
    version: 1,
    commandId: 'command-a',
    managedConnectionId: 'managed-a',
    scopeVersion: 2,
    kind: 'set_connection_lifecycle',
    lifecycle: 'paused',
  } as const;

  it('posts the exact strict command with the linked bearer', async () => {
    const status = {
      version: 1,
      commandId: command.commandId,
      managedConnectionId: command.managedConnectionId,
      scopeVersion: command.scopeVersion,
      state: 'applied',
      externalCleanup: 'not_required',
    } as const;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(status), { status: 200 }));

    await expect(
      submitManagedConnectorAuthorityCommand({
        baseUrl: BASE,
        accessToken: 'dork_inst_abc',
        command,
        fetchImpl,
      })
    ).resolves.toEqual(status);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/instances/connectors/authority-commands`);
    expect(init.headers).toMatchObject({ authorization: 'Bearer dork_inst_abc' });
    expect(JSON.parse(init.body as string)).toEqual(command);
  });

  it('distinguishes relink-required 403 from invalid-key 401 without leaking response text', async () => {
    const refused = await submitManagedConnectorAuthorityCommand({
      baseUrl: BASE,
      accessToken: 'old-key',
      command,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: 'permission_upgrade_required', reason: 'SECRET_HOSTED_ERROR' }),
            { status: 403 }
          )
      ),
    }).catch((error: Error) => error);
    expect(refused).toMatchObject({
      code: 'permission_upgrade_required',
      message:
        'Your DorkOS account link needs updating. Link this computer again in Settings › DorkOS account.',
    });
    expect((refused as Error).message).not.toContain('SECRET_HOSTED_ERROR');
    await expect(
      submitManagedConnectorAuthorityCommand({
        baseUrl: BASE,
        accessToken: 'dead-key',
        command,
        fetchImpl: vi.fn(async () => new Response('', { status: 401 })),
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('managed connector execution', () => {
  const receipt = {
    version: 1,
    receiptId: 'receipt-a',
    logicalOperationId: 'logical-a',
    attemptId: 'attempt-a',
    attemptIndex: 1,
    outcome: 'success',
    completedAt: '2026-09-06T12:00:01.000Z',
    recordedAt: '2026-09-06T12:00:02.000Z',
  } as const;

  it('refuses a receipt that does not match the attempt it was asked for', async () => {
    await expect(
      requestManagedConnectorExecutionReceipt({
        baseUrl: BASE,
        accessToken: 'dork_inst_abc',
        attemptId: 'attempt-a',
        fetchImpl: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                state: 'recorded',
                receipt: { ...receipt, logicalOperationId: 'other' },
                privateProviderLog: 'SECRET',
              }),
              { status: 200 }
            )
        ),
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('managed connector authentication start', () => {
  it('allows a valid authentication response after the generic ten-second request deadline', async () => {
    vi.useFakeTimers();
    try {
      const timeoutSignal = vi.fn((timeoutMs: number) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')),
          timeoutMs
        );
        return controller.signal;
      });
      const state = {
        version: 1,
        flowId: 'hosted-flow-a',
        toolkit: 'gmail',
        createdAt: '2026-09-10T12:00:00.000Z',
        expiresAt: '2026-09-10T12:10:00.000Z',
        state: 'pending',
        authorizeUrl: 'https://dorkos.test/connectors/managed/authorize?flow=hosted-flow-a',
      } as const;
      const fetchImpl = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(
              () => resolve(new Response(JSON.stringify(state), { status: 200 })),
              11_000
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(init.signal?.reason);
              },
              { once: true }
            );
          })
      );

      const pending = requestManagedConnectorAuthentication({
        baseUrl: BASE,
        accessToken: 'dork_inst_abc',
        request: { version: 1, requestId: 'request-a', toolkit: 'gmail' },
        fetchImpl,
        signal: new AbortController().signal,
        timeoutSignal,
      });
      await vi.advanceTimersByTimeAsync(11_000);

      await expect(pending).resolves.toEqual(state);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('catalog authentication representation', () => {
  it('opts in to auth setup details while accepting an old strict-v1 server response', async () => {
    const page = {
      version: 1,
      toolkits: [{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }],
      truncated: false,
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(page), { status: 200 }));
    await expect(
      requestManagedConnectorCatalog({
        baseUrl: BASE,
        accessToken: 'synthetic-instance-token',
        request: { version: 1, query: 'mail', limit: 25 },
        fetchImpl,
        signal: new AbortController().signal,
      })
    ).resolves.toEqual(page);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('query=mail');
    expect(init.headers).toMatchObject({
      'x-dorkos-catalog-auth-setup': '1',
      authorization: 'Bearer synthetic-instance-token',
    });
  });
});

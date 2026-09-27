import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type {
  ConnectorOperationClassification,
  ConnectorOperationPage,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-schemas';
import {
  APP_ACTIONS_FRESH_MS,
  ConnectorAppActionsError,
  ConnectorAppActionsService,
  PARTIAL_APP_ACTIONS_FRESH_MS,
} from '../resources/app-actions-service.js';

const INSTANCE = 'composio:test' as ConnectorProviderInstanceId;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dork-app-actions-'));
  dirs.push(dir);
  return dir;
}

function operation(
  slug: string,
  classification: ConnectorOperationClassification,
  extra: { displayName?: string; important?: boolean; toolkitVersion?: string } = {}
): ConnectorOperationPage['operations'][number] {
  return {
    providerInstanceId: INSTANCE,
    toolkit: 'gmail',
    operationSlug: slug,
    toolkitVersion: extra.toolkitVersion ?? 'v1',
    schemaHash: `hash-${slug}`,
    capabilityClassification: classification,
    retryPolicy: 'never',
    inputSchema: { type: 'object', secretDefault: 'must-not-be-kept' },
    ...(extra.displayName !== undefined && { displayName: extra.displayName }),
    ...(extra.important !== undefined && { important: extra.important }),
  };
}

/** A way whose pages, version and failures each test scripts. */
function fakeProvider(
  opts: {
    operations?: 'unsupported' | 'available';
    version?: () => Promise<Awaited<ReturnType<ConnectorProvider['resolveToolkitVersion']>>>;
    pages?: Array<ConnectorOperationPage | 'throw' | { status: 'unsupported'; reason: string }>;
  } = {}
) {
  const pages = opts.pages ?? [
    {
      operations: [
        operation('GMAIL_FETCH_EMAILS', 'read', { displayName: 'Fetch Emails', important: true }),
        operation('GMAIL_SEND_EMAIL', 'destructive', { important: true }),
        operation('GMAIL_ADD_LABEL', 'write'),
      ],
      truncated: false,
    },
  ];
  const resolveToolkitVersion = vi.fn(
    opts.version ??
      (async () => ({ status: 'ok' as const, toolkit: 'gmail', toolkitVersion: 'v1' }))
  );
  const listOperationSchemas = vi.fn(async (request: { cursor?: string }) => {
    const index = request.cursor ? Number(request.cursor) : 0;
    const page = pages[index];
    if (page === 'throw' || page === undefined) throw new Error('upstream page failed');
    if ('status' in page) return page;
    return {
      status: 'ok' as const,
      page: {
        ...page,
        ...(page.truncated && { nextCursor: String(index + 1) }),
      },
    };
  });
  const provider = {
    getCapabilities: () => ({
      capabilities: {
        operations:
          opts.operations === 'unsupported'
            ? { status: 'unsupported', reason: 'No trusted list.' }
            : { status: 'available' },
      },
    }),
    resolveToolkitVersion,
    listOperationSchemas,
  } as unknown as ConnectorProvider;
  return { provider, resolveToolkitVersion, listOperationSchemas };
}

function service(
  provider: ConnectorProvider | undefined,
  dorkHome = tempHome(),
  now: () => Date = () => new Date('2026-09-27T12:00:00.000Z')
) {
  return new ConnectorAppActionsService({
    registry: { resolveProviderInstance: () => provider },
    dorkHome,
    now,
  });
}

describe('ConnectorAppActionsService', () => {
  it('lists each action with the exact classification discovery produced', async () => {
    const { provider } = fakeProvider();
    const result = await service(provider).list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    expect(result).toEqual({
      status: 'listed',
      toolkit: 'gmail',
      toolkitVersion: 'v1',
      complete: true,
      fetchedAt: '2026-09-27T12:00:00.000Z',
      actions: [
        {
          operationSlug: 'GMAIL_FETCH_EMAILS',
          displayName: 'Fetch Emails',
          capabilityClassification: 'read',
          important: true,
        },
        {
          operationSlug: 'GMAIL_SEND_EMAIL',
          capabilityClassification: 'destructive',
          important: true,
        },
        { operationSlug: 'GMAIL_ADD_LABEL', capabilityClassification: 'write', important: false },
      ],
    });
  });

  it('answers "unlisted" without a call for a way that has no trusted list', async () => {
    const { provider, resolveToolkitVersion } = fakeProvider({ operations: 'unsupported' });
    await expect(
      service(provider).list({ providerInstanceId: INSTANCE, toolkit: 'gmail' })
    ).resolves.toEqual({ status: 'unlisted', toolkit: 'gmail' });
    expect(resolveToolkitVersion).not.toHaveBeenCalled();
  });

  it('answers "unlisted" when the service has no concrete version for the app', async () => {
    const { provider } = fakeProvider({
      version: async () => ({ status: 'unsupported', reason: 'No version.' }),
    });
    await expect(
      service(provider).list({ providerInstanceId: INSTANCE, toolkit: 'gmail' })
    ).resolves.toEqual({ status: 'unlisted', toolkit: 'gmail' });
  });

  it('refuses an unknown way and a listing that read nothing', async () => {
    await expect(
      service(undefined).list({ providerInstanceId: INSTANCE, toolkit: 'gmail' })
    ).rejects.toMatchObject({ code: 'provider_not_found' });
    const { provider } = fakeProvider({ pages: ['throw'] });
    const failing = service(provider);
    await expect(
      failing.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' })
    ).rejects.toBeInstanceOf(ConnectorAppActionsError);
    const broken = fakeProvider({
      version: async () => {
        throw new Error('network');
      },
    });
    await expect(
      service(broken.provider).list({ providerInstanceId: INSTANCE, toolkit: 'gmail' })
    ).rejects.toMatchObject({ code: 'actions_unavailable' });
  });

  it('keeps what it read when a listing stops part way, and says it is partial', async () => {
    const { provider } = fakeProvider({
      pages: [{ operations: [operation('GMAIL_FETCH_EMAILS', 'read')], truncated: true }, 'throw'],
    });
    const result = await service(provider).list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    expect(result).toMatchObject({ status: 'listed', complete: false });
    expect(result.status === 'listed' && result.actions).toHaveLength(1);
  });

  it('never counts an action from another version as part of the list', async () => {
    const { provider } = fakeProvider({
      pages: [
        {
          operations: [
            operation('GMAIL_FETCH_EMAILS', 'read'),
            operation('GMAIL_OLD', 'read', { toolkitVersion: 'v0' }),
          ],
          truncated: false,
        },
      ],
    });
    const result = await service(provider).list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    expect(result.status === 'listed' && result.actions.map((a) => a.operationSlug)).toEqual([
      'GMAIL_FETCH_EMAILS',
    ]);
  });

  it('serves a fresh copy from memory, and from disk after a restart, with no call', async () => {
    const dorkHome = tempHome();
    const first = fakeProvider();
    await service(first.provider, dorkHome).list({
      providerInstanceId: INSTANCE,
      toolkit: 'gmail',
    });

    const [file] = readdirSync(path.join(dorkHome, 'cache', 'connectors', 'actions'));
    const kept = readFileSync(path.join(dorkHome, 'cache', 'connectors', 'actions', file), 'utf-8');
    expect(kept).not.toContain('must-not-be-kept');
    expect(kept).not.toContain('inputSchema');

    const second = fakeProvider();
    const restarted = service(second.provider, dorkHome);
    const result = await restarted.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    await restarted.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    expect(result).toMatchObject({ status: 'listed', complete: true });
    expect(second.resolveToolkitVersion).not.toHaveBeenCalled();
    expect(second.listOperationSchemas).not.toHaveBeenCalled();
  });

  it('serves a stale copy at once and refreshes it behind, re-listing only a new version', async () => {
    let now = new Date('2026-09-27T12:00:00.000Z');
    const { provider, resolveToolkitVersion, listOperationSchemas } = fakeProvider();
    const subject = service(provider, tempHome(), () => now);
    await subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    expect(listOperationSchemas).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + APP_ACTIONS_FRESH_MS + 1);
    const stale = await subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    expect(stale).toMatchObject({ fetchedAt: '2026-09-27T12:00:00.000Z' });
    await vi.waitFor(() => expect(resolveToolkitVersion).toHaveBeenCalledTimes(2));
    // Same version: the list is immutable, so only its date moves on.
    await vi.waitFor(async () =>
      expect(await subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' })).toMatchObject({
        fetchedAt: now.toISOString(),
      })
    );
    expect(listOperationSchemas).toHaveBeenCalledTimes(1);

    resolveToolkitVersion.mockResolvedValue({
      status: 'ok',
      toolkit: 'gmail',
      toolkitVersion: 'v2',
    });
    now = new Date(now.getTime() + APP_ACTIONS_FRESH_MS + 1);
    // The earlier refresh may still be writing its copy; asking again joins
    // it until it settles, then starts the next one.
    await vi.waitFor(async () => {
      await subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
      expect(listOperationSchemas).toHaveBeenCalledTimes(2);
    });
  });

  it('tries a partial list again once its short window passes', async () => {
    let now = new Date('2026-09-27T12:00:00.000Z');
    const { provider, resolveToolkitVersion } = fakeProvider({
      pages: [{ operations: [operation('GMAIL_FETCH_EMAILS', 'read')], truncated: true }, 'throw'],
    });
    const subject = service(provider, tempHome(), () => now);
    await subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    await subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    expect(resolveToolkitVersion).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + PARTIAL_APP_ACTIONS_FRESH_MS + 1);
    await subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' });
    await vi.waitFor(() => expect(resolveToolkitVersion).toHaveBeenCalledTimes(2));
  });

  it('shares one listing between callers who ask at the same time', async () => {
    const { provider, listOperationSchemas } = fakeProvider();
    const subject = service(provider);
    await Promise.all([
      subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' }),
      subject.list({ providerInstanceId: INSTANCE, toolkit: 'gmail' }),
    ]);
    expect(listOperationSchemas).toHaveBeenCalledTimes(1);
  });
});

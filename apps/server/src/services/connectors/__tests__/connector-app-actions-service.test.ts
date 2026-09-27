import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
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
  SHORT_APP_ACTIONS_FRESH_MS,
} from '../resources/app-actions-service.js';
import { ConnectorRegistry } from '../registry.js';

const INSTANCE = 'composio:test' as ConnectorProviderInstanceId;
const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const dirs: string[] = [];
const dbs: Array<ReturnType<typeof createDb>> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.$client.close();
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
    instanceId: INSTANCE,
    type: 'composio',
    getCapabilities: () => ({
      instanceId: INSTANCE,
      type: 'composio',
      supportsMultiAccount: true,
      custody: 'managed',
      features: {},
      capabilities: {
        catalog: { status: 'available' },
        authentication: { status: 'available' },
        accounts: { status: 'available' },
        operations:
          opts.operations === 'unsupported'
            ? { status: 'unsupported', reason: 'No trusted list.' }
            : { status: 'available' },
        execution: { status: 'available' },
        triggers: { status: 'unsupported', reason: 'None.' },
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
  const db = createDb(':memory:');
  runMigrations(db);
  dbs.push(db);
  const registry = new ConnectorRegistry({
    db,
    configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
  });
  if (provider) registry.register(provider, 'digest-1');
  const subject = new ConnectorAppActionsService({ db, registry, dorkHome, now });
  const list = () => subject.list(OWNER, { providerInstanceId: INSTANCE, toolkit: 'gmail' });
  return { subject, registry, list };
}

describe('ConnectorAppActionsService', () => {
  it('lists each action with the exact classification discovery produced', async () => {
    const { provider } = fakeProvider();
    expect(await service(provider).list()).toEqual({
      status: 'listed',
      toolkit: 'gmail',
      toolkitVersion: 'v1',
      completeness: 'complete',
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
    await expect(service(provider).list()).resolves.toEqual({
      status: 'unlisted',
      toolkit: 'gmail',
    });
    expect(resolveToolkitVersion).not.toHaveBeenCalled();
  });

  it('keeps an "unlisted" answer only for the short window', async () => {
    let now = new Date('2026-09-27T12:00:00.000Z');
    const { provider, resolveToolkitVersion } = fakeProvider({
      version: async () => ({ status: 'unsupported', reason: 'No version.' }),
    });
    const { subject, list } = service(provider, tempHome(), () => now);
    await expect(list()).resolves.toEqual({ status: 'unlisted', toolkit: 'gmail' });
    await subject.idle();
    now = new Date(now.getTime() + SHORT_APP_ACTIONS_FRESH_MS - 1);
    await list();
    await subject.idle();
    expect(resolveToolkitVersion).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + 2);
    await list();
    await subject.idle();
    expect(resolveToolkitVersion).toHaveBeenCalledTimes(2);
  });

  it('refuses a way that is unknown, not the owner’s, or no longer available', async () => {
    await expect(service(undefined).list()).rejects.toMatchObject({ code: 'provider_not_found' });

    const { provider, resolveToolkitVersion } = fakeProvider();
    const { subject, registry, list } = service(provider);
    await expect(
      subject.list(
        { kind: 'local_install', installationId: 'someone-else' },
        { providerInstanceId: INSTANCE, toolkit: 'gmail' }
      )
    ).rejects.toMatchObject({ code: 'provider_not_found' });
    registry.unregisterProviderInstance(INSTANCE);
    await expect(list()).rejects.toMatchObject({ code: 'provider_not_found' });
    expect(resolveToolkitVersion).not.toHaveBeenCalled();
  });

  it('refuses a listing that read nothing', async () => {
    const { provider } = fakeProvider({ pages: ['throw'] });
    await expect(service(provider).list()).rejects.toBeInstanceOf(ConnectorAppActionsError);
    const broken = fakeProvider({
      version: async () => {
        throw new Error('network');
      },
    });
    await expect(service(broken.provider).list()).rejects.toMatchObject({
      code: 'actions_unavailable',
    });
  });

  it('keeps what it read when a listing stops part way, and says it was interrupted', async () => {
    const { provider } = fakeProvider({
      pages: [{ operations: [operation('GMAIL_FETCH_EMAILS', 'read')], truncated: true }, 'throw'],
    });
    const result = await service(provider).list();
    expect(result).toMatchObject({ status: 'listed', completeness: 'interrupted' });
    expect(result.status === 'listed' && result.actions).toHaveLength(1);
  });

  it('says "too large" when the app has more pages than DorkOS reads', async () => {
    const endless = Array.from({ length: 25 }, (_, index) => ({
      operations: [operation(`GMAIL_OP_${index}`, 'read')],
      truncated: true,
    }));
    const { provider } = fakeProvider({ pages: endless });
    const result = await service(provider).list();
    expect(result).toMatchObject({ status: 'listed', completeness: 'too_large' });
    expect(result.status === 'listed' && result.actions).toHaveLength(20);
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
    const result = await service(provider).list();
    expect(result.status === 'listed' && result.actions.map((a) => a.operationSlug)).toEqual([
      'GMAIL_FETCH_EMAILS',
    ]);
  });

  it('serves a fresh copy from memory, and from disk after a restart, with no call', async () => {
    const dorkHome = tempHome();
    const first = fakeProvider();
    await service(first.provider, dorkHome).list();

    const kept = readdirSync(path.join(dorkHome, 'cache', 'connectors', 'actions'), {
      recursive: true,
    })
      .map(String)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        readFileSync(path.join(dorkHome, 'cache', 'connectors', 'actions', name), 'utf-8')
      );
    expect(kept).toHaveLength(1);
    expect(kept[0]).not.toContain('must-not-be-kept');
    expect(kept[0]).not.toContain('inputSchema');

    const second = fakeProvider();
    const restarted = service(second.provider, dorkHome);
    expect(await restarted.list()).toMatchObject({ status: 'listed', completeness: 'complete' });
    await restarted.list();
    expect(second.resolveToolkitVersion).not.toHaveBeenCalled();
    expect(second.listOperationSchemas).not.toHaveBeenCalled();
  });

  it('lists again when the way’s setup changes', async () => {
    const { provider, listOperationSchemas } = fakeProvider();
    const { registry, list } = service(provider);
    await list();
    await list();
    expect(listOperationSchemas).toHaveBeenCalledTimes(1);
    registry.register(provider, 'digest-2');
    await list();
    expect(listOperationSchemas).toHaveBeenCalledTimes(2);
  });

  it('drops everything kept for a way that is removed, memory and disk', async () => {
    const dorkHome = tempHome();
    const { provider, listOperationSchemas } = fakeProvider();
    const { subject, registry, list } = service(provider, dorkHome);
    await list();
    await subject.idle();
    const dir = path.join(dorkHome, 'cache', 'connectors', 'actions');
    expect(readdirSync(dir)).toHaveLength(1);

    registry.unregisterProviderInstance(INSTANCE);
    await subject.idle();
    expect(readdirSync(dir)).toHaveLength(0);
    registry.register(provider, 'digest-1');
    await list();
    expect(listOperationSchemas).toHaveBeenCalledTimes(2);
  });

  it('serves a stale copy at once and refreshes it behind, re-listing only a new version', async () => {
    let now = new Date('2026-09-27T12:00:00.000Z');
    const { provider, resolveToolkitVersion, listOperationSchemas } = fakeProvider();
    const { subject, list } = service(provider, tempHome(), () => now);
    await list();
    expect(listOperationSchemas).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + APP_ACTIONS_FRESH_MS + 1);
    expect(await list()).toMatchObject({ fetchedAt: '2026-09-27T12:00:00.000Z' });
    await subject.idle();
    expect(resolveToolkitVersion).toHaveBeenCalledTimes(2);
    // Same version: the list is immutable, so only its date moves on.
    expect(await list()).toMatchObject({ fetchedAt: now.toISOString() });
    expect(listOperationSchemas).toHaveBeenCalledTimes(1);

    resolveToolkitVersion.mockResolvedValue({
      status: 'ok',
      toolkit: 'gmail',
      toolkitVersion: 'v2',
    });
    now = new Date(now.getTime() + APP_ACTIONS_FRESH_MS + 1);
    await list();
    await subject.idle();
    expect(listOperationSchemas).toHaveBeenCalledTimes(2);
  });

  it('never replaces a complete list of the same version with a partial one', async () => {
    let now = new Date('2026-09-27T12:00:00.000Z');
    const pages: Parameters<typeof fakeProvider>[0] = {
      pages: [
        {
          operations: [operation('GMAIL_FETCH_EMAILS', 'read'), operation('GMAIL_SEND', 'write')],
          truncated: false,
        },
      ],
    };
    const { provider, resolveToolkitVersion, listOperationSchemas } = fakeProvider(pages);
    const { subject, list } = service(provider, tempHome(), () => now);
    await list();
    // From now on a listing of this version would stop part way.
    listOperationSchemas.mockRejectedValue(new Error('page failed'));
    now = new Date(now.getTime() + APP_ACTIONS_FRESH_MS + 1);
    await list();
    await subject.idle();
    expect(resolveToolkitVersion).toHaveBeenCalledTimes(2);
    expect(await list()).toMatchObject({
      completeness: 'complete',
      fetchedAt: now.toISOString(),
    });
    const result = await list();
    expect(result.status === 'listed' && result.actions).toHaveLength(2);
  });

  /** A second provider object for the same way, listing its own actions. */
  function replacement(slug: string) {
    return fakeProvider({
      pages: [{ operations: [operation(slug, 'read')], truncated: false }],
    });
  }

  function slugs(result: Awaited<ReturnType<ConnectorAppActionsService['list']>>): string[] {
    return result.status === 'listed' ? result.actions.map((a) => a.operationSlug) : [];
  }

  it('keeps nothing from a listing whose way is removed and re-added mid-listing', async () => {
    const dorkHome = tempHome();
    const first = fakeProvider();
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = first.listOperationSchemas.getMockImplementation()!;
    first.listOperationSchemas.mockImplementationOnce(async (request) => {
      started();
      await gate;
      return original(request);
    });
    const { subject, registry, list } = service(first.provider, dorkHome);
    const pending = list();
    await began;

    registry.unregisterProviderInstance(INSTANCE);
    const second = replacement('GMAIL_FROM_SECOND');
    registry.register(second.provider, 'digest-1');
    release();
    await pending;
    await subject.idle();

    expect(slugs(await list())).toEqual(['GMAIL_FROM_SECOND']);
    expect(second.listOperationSchemas).toHaveBeenCalledTimes(1);
    const files = readdirSync(path.join(dorkHome, 'cache', 'connectors', 'actions'), {
      recursive: true,
    })
      .map(String)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        readFileSync(path.join(dorkHome, 'cache', 'connectors', 'actions', name), 'utf-8')
      );
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('GMAIL_FROM_SECOND');
    expect(files[0]).not.toContain('GMAIL_FETCH_EMAILS');
  });

  it('drops the kept list when the provider object is replaced, even with the same setup', async () => {
    const { provider } = fakeProvider();
    const { subject, registry, list } = service(provider);
    expect(slugs(await list())).toContain('GMAIL_FETCH_EMAILS');
    await subject.idle();

    const second = replacement('GMAIL_FROM_SECOND');
    registry.register(second.provider, 'digest-1');
    expect(slugs(await list())).toEqual(['GMAIL_FROM_SECOND']);
    expect(second.listOperationSchemas).toHaveBeenCalledTimes(1);
  });

  it('never reads the old copy back from disk when asked straight after a replacement', async () => {
    const dorkHome = tempHome();
    const { provider } = fakeProvider();
    const { subject, registry, list } = service(provider, dorkHome);
    await list();
    await subject.idle();

    const second = replacement('GMAIL_FROM_SECOND');
    registry.register(second.provider, 'digest-1');
    // No wait: the drop of the old file is still under way.
    expect(slugs(await list())).toEqual(['GMAIL_FROM_SECOND']);
  });

  it('answers from the new way when it is replaced while the kept copy is being read', async () => {
    const dorkHome = tempHome();
    const before = service(fakeProvider().provider, dorkHome);
    await before.list();
    await before.subject.idle();

    // A restart: the copy is only on disk, so the next list() has to read it.
    const first = fakeProvider();
    const { subject, registry, list } = service(first.provider, dorkHome);
    const pending = list();
    // The read is under way; the way is replaced with the same setup.
    const second = replacement('GMAIL_FROM_SECOND');
    registry.register(second.provider, 'digest-1');

    expect(slugs(await pending)).toEqual(['GMAIL_FROM_SECOND']);
    expect(first.listOperationSchemas).not.toHaveBeenCalled();
    await subject.idle();
    expect(slugs(await list())).toEqual(['GMAIL_FROM_SECOND']);
  });

  it('shares one listing between callers who ask at the same time', async () => {
    const { provider, listOperationSchemas } = fakeProvider();
    const { list } = service(provider);
    await Promise.all([list(), list()]);
    expect(listOperationSchemas).toHaveBeenCalledTimes(1);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectorRuntimeBindings,
  connectorUsageAttempts,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { OpenConnectorTurnInput } from '../../runtime-principal-port.js';
import {
  ConnectorRuntimeAuthorityError,
  ConnectorRuntimePrincipalService,
  type ConnectorRuntimeAuthorityResolver,
} from '../runtime-principal-service.js';
import { isServerPrincipal } from '../server-principal.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;

describe('ConnectorRuntimePrincipalService', () => {
  let db: Db;
  let nowMs: number;
  let authorityLive: boolean;
  let resolver: ConnectorRuntimeAuthorityResolver;
  let input: OpenConnectorTurnInput;
  let ownerCurrent: boolean;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    nowMs = Date.parse('2026-09-06T12:00:00.000Z');
    authorityLive = true;
    ownerCurrent = true;
    resolver = {
      authorizeTurn: vi.fn().mockResolvedValue({ owner: OWNER, agentId: 'agent-a' }),
      revalidateTurn: vi.fn(async () => authorityLive),
    };
    input = {
      runtime: 'opencode',
      canonicalSessionId: 'session-a',
      agentPath: '/project/.dork/agent.json',
      canonicalCwd: '/project',
      signal: new AbortController().signal,
    };
  });

  function makeService(bootEpoch: string, bearer: string): ConnectorRuntimePrincipalService {
    return new ConnectorRuntimePrincipalService({
      db,
      authority: resolver,
      bindingTtlMs: 1_000,
      now: () => new Date(nowMs),
      makeBootEpoch: () => bootEpoch,
      makeBearer: () => bearer,
    });
  }

  function openTurn(service: ConnectorRuntimePrincipalService, value = input) {
    return service.openTurn(value, { isCurrent: () => ownerCurrent });
  }

  it('requires the boot barrier and never stores the raw bearer', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await expect(openTurn(service)).rejects.toEqual(
      expect.objectContaining<Partial<ConnectorRuntimeAuthorityError>>({
        code: 'boot_not_initialized',
      })
    );

    await service.initializeBoot();
    const opened = await openTurn(service);
    expect(opened.bearer).toBe('secret-bearer');
    expect(db.select().from(connectorRuntimeBindings).get()).toMatchObject({
      id: opened.bindingId,
      bootEpoch: 'boot-a',
      ownerKind: 'local_install',
      ownerId: 'install-a',
      runtime: 'opencode',
      canonicalSessionId: 'session-a',
      agentId: 'agent-a',
      canonicalCwd: '/project',
    });
    expect(db.select().from(connectorRuntimeBindings).get()?.tokenHash).not.toContain(
      'secret-bearer'
    );
  });

  it('matches runtime and canonical cwd before returning authentic authority', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    await openTurn(service);

    await expect(
      service.resolve({ bearer: 'secret-bearer', expectedRuntime: 'codex' })
    ).resolves.toEqual({ status: 'refused', reason: 'wrong_runtime' });
    await expect(
      service.resolve({
        bearer: 'secret-bearer',
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/other',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'wrong_cwd' });

    const resolved = await service.resolve({
      bearer: 'secret-bearer',
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    expect(resolved.status).toBe('resolved');
    if (resolved.status === 'resolved') {
      expect(isServerPrincipal(resolved.principal)).toBe(true);
      expect(resolved.principal.claims).toMatchObject({
        kind: 'runtime',
        owner: OWNER,
        runtime: 'opencode',
        canonicalSessionId: 'session-a',
        agentId: 'agent-a',
      });
    }
  });

  it('rechecks live authority, revokes changed authority, and refuses expiry', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    await openTurn(service);
    authorityLive = false;

    await expect(
      service.resolve({
        bearer: 'secret-bearer',
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'authority_changed' });
    expect(db.select().from(connectorRuntimeBindings).get()?.revokeReason).toBe(
      'authority_changed'
    );

    const expiring = makeService('boot-b', 'expiring-bearer');
    authorityLive = true;
    await expiring.initializeBoot();
    await openTurn(expiring);
    nowMs += 1_000;
    await expect(
      expiring.resolve({
        bearer: 'expiring-bearer',
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'expired' });
  });

  it('invalidates prior-process bearers before a new boot becomes reachable', async () => {
    const first = makeService('boot-a', 'old-bearer');
    await first.initializeBoot();
    await openTurn(first);

    const restarted = makeService('boot-b', 'new-bearer');
    await restarted.initializeBoot();
    await expect(
      restarted.resolve({
        bearer: 'old-bearer',
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'stale_boot' });
    expect(db.select().from(connectorRuntimeBindings).get()?.revokeReason).toBe('server_restart');
  });

  it('cannot reconstruct a bearer or renewal permit after a file-backed database restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dorkos-turn-renewal-'));
    const dbPath = join(dir, 'dork.db');
    const firstDb = createDb(dbPath);
    runMigrations(firstDb);
    const first = new ConnectorRuntimePrincipalService({
      db: firstDb,
      authority: resolver,
      bindingTtlMs: 1_000,
      now: () => new Date(nowMs),
      makeBootEpoch: () => 'boot-file-a',
      makeBearer: () => 'file-bearer',
    });

    try {
      await first.initializeBoot();
      const opened = await first.openTurn(input, { isCurrent: () => true });
      firstDb.$client.close();

      const restartedDb = createDb(dbPath);
      const restarted = new ConnectorRuntimePrincipalService({
        db: restartedDb,
        authority: resolver,
        bindingTtlMs: 1_000,
        now: () => new Date(nowMs),
        makeBootEpoch: () => 'boot-file-b',
        makeBearer: () => 'unused-file-bearer',
      });
      try {
        await restarted.initializeBoot();
        await expect(
          restarted.resolve({
            bearer: opened.bearer,
            expectedRuntime: 'opencode',
            expectedCanonicalCwd: '/project',
          })
        ).resolves.toEqual({ status: 'refused', reason: 'stale_boot' });
        await expect(
          restarted.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
        ).resolves.toEqual({ status: 'refused', reason: 'invalid' });
        expect(restartedDb.select().from(connectorRuntimeBindings).get()).toMatchObject({
          id: opened.bindingId,
          revokedAt: new Date(nowMs).toISOString(),
          revokeReason: 'server_restart',
        });
      } finally {
        restartedDb.$client.close();
      }
    } finally {
      if (firstDb.$client.open) firstDb.$client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create a binding when setup is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = makeService('boot-a', 'unused-bearer');
    await service.initializeBoot();

    await expect(openTurn(service, { ...input, signal: controller.signal })).rejects.toThrow(
      /abort/i
    );
    expect(db.select().from(connectorRuntimeBindings).all()).toHaveLength(0);
    expect(resolver.authorizeTurn).not.toHaveBeenCalled();
  });

  it('does not create a binding when the active owner changes during authority setup', async () => {
    const service = makeService('boot-a', 'unused-bearer');
    await service.initializeBoot();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolver.authorizeTurn).mockImplementationOnce(async () => {
      await blocked;
      return { owner: OWNER, agentId: 'agent-a' };
    });

    const opening = openTurn(service);
    await vi.waitFor(() => expect(resolver.authorizeTurn).toHaveBeenCalledOnce());
    ownerCurrent = false;
    release();

    await expect(opening).rejects.toEqual(
      expect.objectContaining<Partial<ConnectorRuntimeAuthorityError>>({
        code: 'authority_refused',
      })
    );
    expect(db.select().from(connectorRuntimeBindings).all()).toHaveLength(0);
  });

  it('keeps a binding denied in-process when the durable revoke write fails', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    const resolved = await service.resolve({
      bearer: 'secret-bearer',
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('expected an authenticated principal');

    vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('simulated durable revoke failure');
    });
    await expect(service.revoke(opened.bindingId, 'runtime_failed')).rejects.toThrow(
      'simulated durable revoke failure'
    );
    expect(db.select().from(connectorRuntimeBindings).get()?.revokedAt).toBeNull();

    await expect(
      service.resolve({
        bearer: 'secret-bearer',
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'revoked' });
    await expect(service.revalidatePrincipal(resolved.principal)).resolves.toBe(false);
    await expect(
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
    ).resolves.toEqual({ status: 'refused', reason: 'invalid' });
    expect(resolver.revalidateTurn).toHaveBeenCalledTimes(1);
  });

  it('rechecks the durable row after live authority validation awaits', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    const resolved = await service.resolve({
      bearer: 'secret-bearer',
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    if (resolved.status !== 'resolved') throw new Error('expected an authenticated principal');

    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let releaseValidation!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    vi.mocked(resolver.revalidateTurn).mockImplementationOnce(async () => {
      validationStarted();
      await blocked;
      return true;
    });

    const revalidation = service.revalidatePrincipal(resolved.principal);
    await started;
    await service.revoke(opened.bindingId, 'turn_cancelled');
    releaseValidation();
    await expect(revalidation).resolves.toBe(false);
  });

  it('does not mint a principal when revoke wins during bearer resolution', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    let releaseValidation!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    vi.mocked(resolver.revalidateTurn).mockImplementationOnce(async () => {
      validationStarted();
      await blocked;
      return true;
    });

    const resolution = service.resolve({
      bearer: 'secret-bearer',
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    await started;
    await service.revoke(opened.bindingId, 'turn_cancelled');
    releaseValidation();
    await expect(resolution).resolves.toEqual({ status: 'refused', reason: 'revoked' });
  });

  it('does not mint a principal when the active owner changes during bearer resolution', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    await openTurn(service);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolver.revalidateTurn).mockImplementationOnce(async () => blocked.then(() => true));

    const resolution = service.resolve({
      bearer: 'secret-bearer',
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    await vi.waitFor(() => expect(resolver.revalidateTurn).toHaveBeenCalledOnce());
    ownerCurrent = false;
    release();

    await expect(resolution).resolves.toEqual({ status: 'refused', reason: 'revoked' });
    expect(db.select().from(connectorRuntimeBindings).get()?.revokeReason).toBe('turn_cancelled');
  });

  it('refuses an authenticated principal as soon as its active owner changes', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    const resolved = await service.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    if (resolved.status !== 'resolved') throw new Error('expected an authenticated principal');
    vi.mocked(resolver.revalidateTurn).mockClear();

    ownerCurrent = false;

    await expect(service.revalidatePrincipal(resolved.principal)).resolves.toBe(false);
    expect(resolver.revalidateTurn).not.toHaveBeenCalled();
    expect(db.select().from(connectorRuntimeBindings).get()?.revokeReason).toBe('turn_cancelled');
  });

  it('keeps owner-loss authority denied when its durable tombstone write fails', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    const resolved = await service.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    if (resolved.status !== 'resolved') throw new Error('expected an authenticated principal');

    ownerCurrent = false;
    const update = vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('simulated owner-loss tombstone failure');
    });
    await expect(service.revalidatePrincipal(resolved.principal)).rejects.toThrow(
      'simulated owner-loss tombstone failure'
    );
    update.mockRestore();
    ownerCurrent = true;

    expect(db.select().from(connectorRuntimeBindings).get()?.revokedAt).toBeNull();
    await expect(
      service.resolve({
        bearer: opened.bearer,
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'revoked' });
    await expect(service.revalidatePrincipal(resolved.principal)).resolves.toBe(false);
    await expect(
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
    ).resolves.toEqual({ status: 'refused', reason: 'invalid' });
  });

  it('rechecks the active owner after principal authority validation awaits', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    const resolved = await service.resolve({
      bearer: opened.bearer,
      expectedRuntime: 'opencode',
      expectedCanonicalCwd: '/project',
    });
    if (resolved.status !== 'resolved') throw new Error('expected an authenticated principal');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolver.revalidateTurn).mockClear();
    vi.mocked(resolver.revalidateTurn).mockImplementationOnce(async () => blocked.then(() => true));

    const revalidation = service.revalidatePrincipal(resolved.principal);
    await vi.waitFor(() => expect(resolver.revalidateTurn).toHaveBeenCalledOnce());
    ownerCurrent = false;
    release();

    await expect(revalidation).resolves.toBe(false);
    expect(db.select().from(connectorRuntimeBindings).get()?.revokeReason).toBe('turn_cancelled');
  });

  it('renews only with the exact live process permit and preserves bearer claims', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    const before = db.select().from(connectorRuntimeBindings).get()!;

    nowMs += 500;
    await expect(
      service.renew({
        bindingId: opened.bindingId,
        permit: {} as typeof opened.renewalPermit,
      })
    ).resolves.toEqual({ status: 'refused', reason: 'invalid' });
    await expect(
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
    ).resolves.toEqual({
      status: 'renewed',
      expiresAt: '2026-09-06T12:00:01.500Z',
    });

    const after = db.select().from(connectorRuntimeBindings).get()!;
    expect(after).toEqual({ ...before, expiresAt: '2026-09-06T12:00:01.500Z' });
    expect(db.select().from(connectorUsageAttempts).all()).toEqual([]);
    await expect(
      service.resolve({
        bearer: opened.bearer,
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toMatchObject({ status: 'resolved' });
    expect(db.select().from(connectorRuntimeBindings).get()?.expiresAt).toBe(after.expiresAt);
  });

  it.each([1_000, 1_001])('refuses renewal at and after expiry (%i ms)', async (elapsedMs) => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);

    nowMs += elapsedMs;
    await expect(
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
    ).resolves.toEqual({ status: 'refused', reason: 'expired' });
  });

  it('refuses bearer use immediately after active-turn replacement', async () => {
    const second = makeService('boot-b', 'second-bearer');
    await second.initializeBoot();
    const secondOpened = await openTurn(second);
    ownerCurrent = false;
    await expect(
      second.resolve({
        bearer: secondOpened.bearer,
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'revoked' });
    await expect(
      second.renew({ bindingId: secondOpened.bindingId, permit: secondOpened.renewalPermit })
    ).resolves.toEqual({ status: 'refused', reason: 'invalid' });
    expect(db.select().from(connectorRuntimeBindings).get()?.revokeReason).toBe('turn_cancelled');
  });

  it('rechecks expiry and exact owner after awaited authority work', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolver.revalidateTurn).mockClear();
    vi.mocked(resolver.revalidateTurn).mockImplementationOnce(async () => blocked.then(() => true));

    const renewal = service.renew({
      bindingId: opened.bindingId,
      permit: opened.renewalPermit,
    });
    await vi.waitFor(() => expect(resolver.revalidateTurn).toHaveBeenCalled());
    nowMs += 1_000;
    ownerCurrent = false;
    release();
    await expect(renewal).resolves.toEqual({ status: 'refused', reason: 'expired' });
    expect(db.select().from(connectorRuntimeBindings).get()?.expiresAt).toBe(
      '2026-09-06T12:00:01.000Z'
    );
  });

  it('lets revoke win while renewal awaits authority and never revives on restart', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolver.revalidateTurn).mockImplementationOnce(async () => blocked.then(() => true));

    const renewal = service.renew({
      bindingId: opened.bindingId,
      permit: opened.renewalPermit,
    });
    await vi.waitFor(() => expect(resolver.revalidateTurn).toHaveBeenCalled());
    await service.revoke(opened.bindingId, 'turn_cancelled');
    release();
    await expect(renewal).resolves.toEqual({ status: 'refused', reason: 'revoked' });

    await service.initializeBoot();
    await expect(
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
    ).resolves.toEqual({ status: 'refused', reason: 'invalid' });
  });

  it('refuses authority changes and owner-slot replacement while renewal awaits', async () => {
    const authorityChanged = makeService('boot-a', 'authority-bearer');
    await authorityChanged.initializeBoot();
    const authorityOpened = await openTurn(authorityChanged);
    authorityLive = false;
    await expect(
      authorityChanged.renew({
        bindingId: authorityOpened.bindingId,
        permit: authorityOpened.renewalPermit,
      })
    ).resolves.toEqual({ status: 'refused', reason: 'authority_changed' });

    authorityLive = true;
    const service = makeService('boot-b', 'owner-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(resolver.revalidateTurn).mockClear();
    vi.mocked(resolver.revalidateTurn).mockImplementationOnce(async () => blocked.then(() => true));
    const renewal = service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit });
    await vi.waitFor(() => expect(resolver.revalidateTurn).toHaveBeenCalled());
    ownerCurrent = false;
    release();
    await expect(renewal).resolves.toEqual({ status: 'refused', reason: 'inactive_owner' });
    await expect(
      service.resolve({
        bearer: opened.bearer,
        expectedRuntime: 'opencode',
        expectedCanonicalCwd: '/project',
      })
    ).resolves.toEqual({ status: 'refused', reason: 'revoked' });
  });

  it('converges overlapping renewal attempts on one monotonic committed expiry', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await openTurn(service);
    nowMs += 500;

    const [first, second] = await Promise.all([
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit }),
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit }),
    ]);
    expect(first).toEqual({ status: 'renewed', expiresAt: '2026-09-06T12:00:01.500Z' });
    expect(second).toEqual(first);
    expect(db.select().from(connectorRuntimeBindings).get()?.expiresAt).toBe(
      '2026-09-06T12:00:01.500Z'
    );
  });

  it('does not overwrite a competing expiry committed after its final row read', async () => {
    let clockReads = 0;
    const competingExpiry = '2026-09-06T12:00:02.000Z';
    const service = new ConnectorRuntimePrincipalService({
      db,
      authority: resolver,
      bindingTtlMs: 1_000,
      now: () => {
        clockReads += 1;
        if (clockReads === 4) {
          db.update(connectorRuntimeBindings).set({ expiresAt: competingExpiry }).run();
        }
        return new Date(nowMs);
      },
      makeBootEpoch: () => 'boot-a',
      makeBearer: () => 'secret-bearer',
    });
    await service.initializeBoot();
    const opened = await openTurn(service);
    nowMs += 500;

    await expect(
      service.renew({ bindingId: opened.bindingId, permit: opened.renewalPermit })
    ).resolves.toEqual({ status: 'renewed', expiresAt: competingExpiry });
    expect(db.select().from(connectorRuntimeBindings).get()?.expiresAt).toBe(competingExpiry);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorRuntimeBindings, createDb, runMigrations, type Db } from '@dorkos/db';
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

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    nowMs = Date.parse('2026-09-06T12:00:00.000Z');
    authorityLive = true;
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

  it('requires the boot barrier and never stores the raw bearer', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await expect(service.openTurn(input)).rejects.toEqual(
      expect.objectContaining<Partial<ConnectorRuntimeAuthorityError>>({
        code: 'boot_not_initialized',
      })
    );

    await service.initializeBoot();
    const opened = await service.openTurn(input);
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
    await service.openTurn(input);

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
    await service.openTurn(input);
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
    await expiring.openTurn(input);
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
    await first.openTurn(input);

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

  it('does not create a binding when setup is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const service = makeService('boot-a', 'unused-bearer');
    await service.initializeBoot();

    await expect(service.openTurn({ ...input, signal: controller.signal })).rejects.toThrow(
      /abort/i
    );
    expect(db.select().from(connectorRuntimeBindings).all()).toHaveLength(0);
    expect(resolver.authorizeTurn).not.toHaveBeenCalled();
  });

  it('keeps a binding denied in-process when the durable revoke write fails', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await service.openTurn(input);
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
  });

  it('rechecks the durable row after live authority validation awaits', async () => {
    const service = makeService('boot-a', 'secret-bearer');
    await service.initializeBoot();
    const opened = await service.openTurn(input);
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
    const opened = await service.openTurn(input);
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
});

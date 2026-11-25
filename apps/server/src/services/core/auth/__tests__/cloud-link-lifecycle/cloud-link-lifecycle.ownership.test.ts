import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkProofForKey } from '../../cloud-link-client.js';
import {
  bearer,
  callKinds,
  callsTo,
  cloudRoutes,
  codes,
  command,
  deferred,
  heartbeat,
  manage,
  managedCall,
  memoryConfig,
  response,
  stopManagers,
} from './cloud-link-lifecycle.fixtures.js';

describe('CloudLinkManager lifecycle ownership', () => {
  afterEach(stopManagers);

  it.each([200, 401])(
    'ignores old heartbeat HTTP %i after a replacement link',
    async (oldStatus) => {
      const oldReply = deferred<Response>();
      const config = memoryConfig('old-key');
      const manager = manage(
        config,
        cloudRoutes({
          heartbeat: (init) =>
            bearer(init) === 'old-key' ? oldReply.promise : heartbeat('new-account'),
        })
      );

      const oldStartup = manager.initOnStartup();
      await manager.startLink();
      await manager.pendingLink;
      const before = manager.getStatus();
      oldReply.resolve(oldStatus === 200 ? heartbeat('old-account') : response(401));
      await oldStartup;

      expect(config.getToken()).toBe('new-key');
      expect(config.getAccountLabel()).toBe('new-account');
      expect(manager.getStatus()).toEqual(before);
    }
  );

  it.each(callKinds)('does not let an old %s refusal clear the replacement link', async (kind) => {
    const oldReply = deferred<Response>();
    const config = memoryConfig('old-key');
    const manager = manage(config, cloudRoutes({ connectors: () => oldReply.promise }));
    const oldFailure = managedCall(manager, kind).catch((error: unknown) => error);

    await manager.startLink();
    await manager.pendingLink;
    oldReply.resolve(response(401));
    await expect(oldFailure).resolves.toMatchObject({ code: 'unauthorized' });
    expect(config.getToken()).toBe('new-key');
    expect(manager.getStatus().state).toBe('linked');
  });

  it('keeps a pending re-link alive when the old key is refused mid-poll (DOR-2521)', async () => {
    const tokenReply = deferred<Response>();
    const config = memoryConfig('old-key');
    const fetchImpl = cloudRoutes({
      token: () => tokenReply.promise,
      // The heartbeat refuses the old key and accepts the new one.
      heartbeat: (init) => (bearer(init) === 'old-key' ? response(401) : heartbeat('new-account')),
      connectors: () => response(401),
    });
    const manager = manage(config, fetchImpl);

    await manager.startLink();
    await vi.waitFor(() => expect(callsTo(fetchImpl, '/device/token')).toBe(1));
    // The old key is refused while the person is still approving the new link.
    await expect(managedCall(manager, 'managed')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('old-key'));
    expect(manager.getStatus().state).toBe('pending');

    tokenReply.resolve(response(200, { access_token: 'new-key' }));
    await manager.pendingLink;

    expect(config.getToken()).toBe('new-key');
    expect(config.getPreviousLinkProof()).toBeNull();
    expect(config.getAccountLabel()).toBe('new-account');
    expect(manager.getStatus().state).toBe('linked');
  });

  it('keeps the proof of a key a managed-connector call finds refused (DOR-2521)', async () => {
    const config = memoryConfig('old-key');
    const manager = manage(
      config,
      vi.fn(async () => response(401))
    );

    await expect(manager.submitConnectorAuthorityCommand(command)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('old-key'));
    expect(manager.getStatus().state).toBe('unlinked');
  });

  it('treats a 401 after a finished link as an unlink, not a pending re-link', async () => {
    const config = memoryConfig('old-key');
    let refuse = false;
    const manager = manage(
      config,
      cloudRoutes({
        heartbeat: () => (refuse ? response(401) : heartbeat('new-account')),
        connectors: () => (refuse ? response(401) : response(500)),
      })
    );

    await manager.startLink();
    await manager.pendingLink;
    refuse = true;
    await expect(manager.submitConnectorAuthorityCommand(command)).rejects.toMatchObject({
      code: 'unauthorized',
    });

    expect(config.getToken()).toBeNull();
    expect(config.getPreviousLinkProof()).toBe(linkProofForKey('new-key'));
    expect(manager.getStatus().state).toBe('unlinked');
  });

  it('ignores a superseded device-code response before polling', async () => {
    const firstCode = deferred<Response>();
    const config = memoryConfig();
    let codeRequests = 0;
    const fetchImpl = cloudRoutes({
      code: () => (++codeRequests === 1 ? firstCode.promise : codes('new-code')),
    });
    const manager = manage(config, fetchImpl);

    const oldStart = manager.startLink().catch((error: unknown) => error);
    await vi.waitFor(() => expect(callsTo(fetchImpl, '/device/code')).toBe(1));
    await manager.startLink();
    await manager.pendingLink;
    firstCode.resolve(codes('old-code'));
    await expect(oldStart).resolves.toMatchObject({ message: 'Cloud link request was superseded' });

    expect(config.getToken()).toBe('new-key');
    expect(manager.getStatus().state).toBe('linked');
    expect(callsTo(fetchImpl, '/device/token')).toBe(1);
  });

  it('ignores an old poll approval after replacement', async () => {
    const oldPoll = deferred<Response>();
    const config = memoryConfig();
    let codeRequests = 0;
    const fetchImpl = cloudRoutes({
      code: () => codes(++codeRequests === 1 ? 'old-code' : 'new-code'),
      token: (init) => {
        const body = JSON.parse(String(init?.body)) as { device_code: string };
        return body.device_code === 'old-code'
          ? oldPoll.promise
          : response(200, { access_token: 'new-key' });
      },
    });
    const manager = manage(config, fetchImpl);

    await manager.startLink();
    const oldTask = manager.pendingLink;
    await manager.startLink();
    await manager.pendingLink;
    oldPoll.resolve(response(200, { access_token: 'old-key' }));
    await oldTask;

    expect(config.getToken()).toBe('new-key');
    expect(config.getAccountLabel()).toBe('new-account');
    expect(manager.getStatus().state).toBe('linked');
    expect(callsTo(fetchImpl, '/instances/heartbeat')).toBe(1);
  });

  it('runs the unlink step while the link still stands (ADR 261001-000811)', async () => {
    const config = memoryConfig('old-key');
    const manager = manage(
      config,
      vi.fn(async () => response(200, { ok: true }))
    );
    const seen: (string | null)[] = [];
    manager.setOnUnlink(() => {
      seen.push(config.getToken());
    });

    await manager.unlink();
    // Called before the withdrawal, so what was minted under it can be revoked.
    expect(seen).toEqual(['old-key']);
    expect(config.getToken()).toBeNull();
  });

  it('withdraws locally before revoke settles and preserves an equal-token replacement', async () => {
    const revoke = deferred<Response>();
    const config = memoryConfig('same-key');
    const manager = manage(
      config,
      cloudRoutes({
        revoke: () => revoke.promise,
        token: () => response(200, { access_token: 'same-key' }),
        heartbeat: () => heartbeat('replacement'),
      })
    );

    const unlink = manager.unlink();
    expect(config.getToken()).toBeNull();
    expect(manager.getStatus()).toEqual({ state: 'idle' });
    await manager.startLink();
    await manager.pendingLink;
    const replacement = manager.getStatus();
    revoke.resolve(response(200, { ok: true }));
    await unlink;

    expect(config.getToken()).toBe('same-key');
    expect(config.getAccountLabel()).toBe('replacement');
    expect(manager.getStatus()).toEqual(replacement);
  });

  it('ignores an old heartbeat 401 across unlink and same-token relink', async () => {
    const oldHeartbeat = deferred<Response>();
    const config = memoryConfig('same-key');
    let heartbeatRequests = 0;
    const manager = manage(
      config,
      cloudRoutes({
        heartbeat: () =>
          ++heartbeatRequests === 1 ? oldHeartbeat.promise : heartbeat('replacement'),
        revoke: () => response(200, { ok: true }),
        token: () => response(200, { access_token: 'same-key' }),
      })
    );

    const oldStartup = manager.initOnStartup();
    await manager.unlink();
    await manager.startLink();
    await manager.pendingLink;
    oldHeartbeat.resolve(response(401));
    await oldStartup;

    expect(config.getToken()).toBe('same-key');
    expect(config.getAccountLabel()).toBe('replacement');
    expect(manager.getStatus().state).toBe('linked');
  });

  it('retains the current credential and retries after a transient heartbeat failure', async () => {
    vi.useFakeTimers();
    const config = memoryConfig('current-key');
    let heartbeatRequests = 0;
    const manager = manage(
      config,
      cloudRoutes({
        heartbeat: () => (++heartbeatRequests === 1 ? response(503) : heartbeat('current-account')),
      }),
      // The middle of the jitter range: exactly one interval.
      { heartbeatIntervalMs: 100, random: () => 0.5 }
    );

    await manager.initOnStartup();
    expect(config.getToken()).toBe('current-key');
    expect(manager.getStatus().state).toBe('linked');
    await vi.advanceTimersByTimeAsync(100);

    expect(heartbeatRequests).toBe(2);
    expect(config.getAccountLabel()).toBe('current-account');
    expect(config.getToken()).toBe('current-key');
  });

  it('stop prevents an in-flight heartbeat from restoring state or a timer', async () => {
    vi.useFakeTimers();
    const held = deferred<Response>();
    const config = memoryConfig('key');
    const fetchImpl = cloudRoutes({ heartbeat: () => held.promise });
    const manager = manage(config, fetchImpl, { heartbeatIntervalMs: 100 });
    const startup = manager.initOnStartup();
    manager.stop();
    held.resolve(heartbeat('old-account'));
    await startup;
    await vi.advanceTimersByTimeAsync(500);

    expect(manager.getStatus().lastHeartbeatAt).toBeUndefined();
    expect(config.getAccountLabel()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

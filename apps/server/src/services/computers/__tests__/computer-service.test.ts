import { createComputerRuntime } from '../../runtimes/opencode/computer/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComputerService } from '../computer-service.js';
import { ComputerStore } from '../store.js';
import type { ComputerBackend } from '../backend/types.js';

const roots: string[] = [];
const services: ComputerService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const service of services.splice(0)) await service.stop().catch(() => undefined);
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'computer-service-')));
  roots.push(root);
  let enabled = true;
  const endpoints = {
    desktopUrl: 'http://127.0.0.1:47101',
    opencodeUrl: 'http://127.0.0.1:47102',
    desktopPassword: 'private-display',
    opencodePassword: 'private-runtime',
  };
  const backend = {
    create: vi.fn<ComputerBackend['create']>(async (_id, generation) => ({
      phase: 'running',
      generation,
    })),
    start: vi.fn<ComputerBackend['start']>(async (_id, generation) => ({
      phase: 'running',
      generation,
    })),
    stop: vi.fn<ComputerBackend['stop']>(async (_id, generation) => ({
      phase: 'stopped',
      generation,
    })),
    status: vi.fn<ComputerBackend['status']>(async () => ({ phase: 'running', generation: 1 })),
    endpoints: vi.fn(async () => endpoints),
    exec: vi.fn(),
  } satisfies ComputerBackend;
  const fetcher = vi.fn(
    async (url: URL | string) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/frame')
            ? { dataUrl: 'data:image/png;base64,YQ==', width: 1280, height: 800 }
            : { healthy: true, ready: true }
        ),
        { headers: { 'Content-Type': 'application/json' } }
      )
  );
  vi.stubGlobal('fetch', fetcher);
  const interruptTurns = vi.fn(async () => {});
  const service = new ComputerService({
    root,
    backend,
    enabled: () => enabled,
    supported: true,
    interruptTurns,
    createSession: async (cwd) => ({ id: 'chat', cwd, runtime: 'computer-local' }),
  });
  services.push(service);
  return {
    root,
    backend,
    service,
    fetcher,
    interruptTurns,
    disable: () => {
      enabled = false;
    },
  };
}
async function ready(service: ComputerService) {
  await service.create();
  await vi.waitFor(async () => expect((await service.status()).phase).toBe('ready'));
}

describe('persistent local computer lifecycle and input authority', () => {
  it('waits for guest services after SSH readiness and preserves setup state', async () => {
    const { service, fetcher, backend } = await setup();
    fetcher.mockRejectedValueOnce(new Error('sidecar is still starting'));
    await service.create();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect((await service.status()).phase).toBe('provisioning');
    expect(service.acceptingWork()).toBe(false);
    await vi.waitFor(() => expect(service.acceptingWork()).toBe(true), { timeout: 3000 });
    expect(backend.create).toHaveBeenCalledTimes(1);
  });

  it('stops instead of publishing ready while waiting for guest health', async () => {
    const { service, fetcher, backend } = await setup();
    fetcher.mockRejectedValue(new Error('sidecar is still starting'));
    await service.create();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect((await service.stop()).phase).toBe('stopped');
    expect(service.acceptingWork()).toBe(false);
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps setup retryable when Stop confirms that no backend ownership ever existed', async () => {
    const { service, backend } = await setup();
    backend.create.mockRejectedValueOnce(new Error('artifact download failed'));
    backend.status.mockResolvedValue({ phase: 'missing', generation: 0 });
    backend.stop.mockRejectedValue(new Error('Missing computer ownership'));
    await service.create();
    await vi.waitFor(async () => expect((await service.status()).phase).toBe('failed'));
    expect((await service.stop()).phase).toBe('missing');
    expect(backend.stop).not.toHaveBeenCalled();
    backend.status.mockResolvedValue({ phase: 'running', generation: 3 });
    await service.create();
    await vi.waitFor(() => expect(service.acceptingWork()).toBe(true));
    expect(backend.create).toHaveBeenCalledTimes(2);
  });

  it('does not replace a failed setup when backend absence cannot be confirmed', async () => {
    const { service, backend } = await setup();
    backend.create.mockRejectedValueOnce(new Error('setup failed'));
    backend.status.mockResolvedValue({ phase: 'uncertain', generation: 0 });
    backend.stop.mockRejectedValue(new Error('unknown resources'));
    await service.create();
    await vi.waitFor(async () => expect((await service.status()).phase).toBe('failed'));
    expect((await service.stop()).phase).toBe('uncertain');
    await expect(service.create()).rejects.toMatchObject({ code: 'cleanup-uncertain' });
    expect(backend.create).toHaveBeenCalledTimes(1);
  });

  it('can explicitly create after stopping a missing computer', async () => {
    const { service, backend } = await setup();
    expect((await service.stop()).phase).toBe('missing');
    await ready(service);
    expect(backend.create).toHaveBeenCalledTimes(1);
  });
  it('serializes duplicate create and projects no endpoint secrets', async () => {
    const { service, backend } = await setup();
    await Promise.all([service.create(), service.create(), service.create()]);
    await vi.waitFor(() => expect(service.acceptingWork()).toBe(true));
    expect(backend.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await service.status())).not.toMatch(/private-|4710/);
  });
  it('fences runtime immediately while owned setup is still pending and retains disk identity', async () => {
    const { service, backend, root } = await setup();
    let finish!: () => void;
    backend.create.mockImplementation(async (_id, generation) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { phase: 'running', generation };
    });
    await service.create();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const stop = service.stop();
    expect(service.acceptingWork()).toBe(false);
    await expect(service.endpoint()).rejects.toMatchObject({ code: 'not-ready' });
    await vi.waitFor(async () => expect((await service.status()).phase).toBe('stopping'));
    finish();
    expect((await stop).phase).toBe('stopped');
    const record = await new ComputerStore(root).read();
    expect(record?.generation).toBe(2);
    expect(backend.stop).toHaveBeenCalledWith(expect.objectContaining({ id: record?.id }), 2);
    await service.start();
    await vi.waitFor(() => expect(service.acceptingWork()).toBe(true));
    expect(backend.create).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith(expect.objectContaining({ id: record?.id }), 3);
  });
  it('closes runtime and session admission throughout pending takeover', async () => {
    const { service, interruptTurns, root } = await setup();
    await ready(service);
    let finish!: () => void;
    interruptTurns.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const acquiring = service.acquire('person');
    expect(service.acceptingWork()).toBe(false);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(service.endpoint()).rejects.toMatchObject({ code: 'not-ready' });
    await expect(service.session()).rejects.toMatchObject({ code: 'not-ready' });
    const { runtime } = createComputerRuntime({
      runtimeId: 'computer-local',
      anchor: service.anchor,
      guestDirectory: '/home/agent/project',
      sessionMapPath: join(root, 'session-map.json'),
      currentEnabled: () => service.acceptingWork(),
      ensureEndpoint: () => service.endpoint(),
    });
    expect(() => runtime.sendMessage('one', 'hello')).toThrow('COMPUTER_DISABLED');
    finish();
    const lease = await acquiring;
    expect(service.acceptingWork()).toBe(false);
    await service.release('person', lease.leaseId);
    expect(service.acceptingWork()).toBe(true);
  });

  it('confirms release after an ambiguous takeover response before reopening admission', async () => {
    const { service, fetcher } = await setup();
    await ready(service);
    const controls: boolean[] = [];
    fetcher.mockImplementation(async (url, init?: RequestInit) => {
      if (String(url).endsWith('/control')) {
        const body = JSON.parse(String(init?.body));
        controls.push(body.held);
        if (body.held) throw new Error('response lost after freezing');
      }
      return new Response('{"healthy":true,"ready":true}');
    });
    await expect(service.acquire('person')).rejects.toThrow('response lost');
    expect(controls).toEqual([true, false]);
    expect(service.acceptingWork()).toBe(true);
  });

  it('keeps admission closed until an ambiguous takeover is actually released', async () => {
    const { service, fetcher } = await setup();
    await ready(service);
    vi.useFakeTimers();
    fetcher.mockImplementation(async () => {
      throw new Error('release unavailable');
    });
    await expect(service.acquire('person')).rejects.toThrow('release unavailable');
    expect(service.acceptingWork()).toBe(false);
    await expect(service.endpoint()).rejects.toMatchObject({ code: 'not-ready' });
    fetcher.mockImplementation(async () => new Response('{"healthy":true,"ready":true}'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.acceptingWork()).toBe(true);
  });

  it('revokes old controller, rejects delayed input and never revokes successor by stale release', async () => {
    const { service } = await setup();
    await ready(service);
    const old = await service.acquire('first');
    expect((await service.frame('first')).controlledByYou).toBe(true);
    expect(service.acceptingWork()).toBe(false);
    const current = await service.acquire('second');
    await expect(
      service.input('first', { ...old, kind: 'key', action: 'down', key: 'a' })
    ).rejects.toMatchObject({ code: 'control-lost' });
    await service.release('first', old.leaseId);
    await service.input('second', { ...current, kind: 'key', action: 'down', key: 'b' });
    await service.release('second', current.leaseId);
    expect(service.acceptingWork()).toBe(true);
  });
  it('drops old control only after a confirmed VM stop despite guest release failure', async () => {
    const { service, fetcher } = await setup();
    await ready(service);
    await service.acquire('person');
    fetcher.mockImplementation(async () => new Response('{}', { status: 503 }));
    await expect(service.release('person', 'stale')).resolves.toBeUndefined();
    expect((await service.stop()).phase).toBe('stopped');
    fetcher.mockImplementation(async () => new Response('{"healthy":true,"ready":true}'));
    await service.start();
    await vi.waitFor(() => expect(service.acceptingWork()).toBe(true));
  });
  it('clears an old controller after an independently observed guest stop', async () => {
    const { service, backend } = await setup();
    await ready(service);
    await service.acquire('person');
    backend.status.mockResolvedValue({ phase: 'stopped', generation: 1 });
    expect((await service.status()).phase).toBe('stopped');
    backend.status.mockResolvedValue({ phase: 'running', generation: 2 });
    await service.start();
    await vi.waitFor(() => expect(service.acceptingWork()).toBe(true));
  });
  it('retries a failed current-lease return and restores admission after confirmed release', async () => {
    const { service, fetcher } = await setup();
    await ready(service);
    vi.useFakeTimers();
    const lease = await service.acquire('person');
    fetcher.mockRejectedValueOnce(new Error('transient'));
    await expect(service.release('person', lease.leaseId)).rejects.toThrow('transient');
    expect(service.acceptingWork()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(service.acceptingWork()).toBe(true));
  });
  it('retains uncertainty after three unconfirmed current-lease release attempts', async () => {
    const { service, fetcher } = await setup();
    await ready(service);
    vi.useFakeTimers();
    const lease = await service.acquire('person');
    fetcher.mockRejectedValue(new Error('unconfirmed'));
    await expect(service.release('person', lease.leaseId)).rejects.toThrow('unconfirmed');
    await vi.advanceTimersByTimeAsync(10000);
    await vi.waitFor(async () => expect((await service.status()).phase).toBe('uncertain'));
    expect(service.acceptingWork()).toBe(false);
    await expect(service.start()).rejects.toMatchObject({ code: 'cleanup-uncertain' });
  });
  it('refuses disabled work without booting and preserves cleanup uncertainty', async () => {
    const { service, backend, disable } = await setup();
    await ready(service);
    disable();
    await expect(service.endpoint()).rejects.toMatchObject({ code: 'disabled' });
    backend.stop.mockRejectedValue(new Error('unconfirmed'));
    const status = await service.stop();
    expect(status).toMatchObject({ phase: 'disabled', error: { code: 'cleanup-uncertain' } });
    expect(backend.create).toHaveBeenCalledTimes(1);
  });
  it('interrupted lifecycle journal refuses replacement after server restart', async () => {
    const { root, backend } = await setup();
    await new ComputerStore(root).write(
      { id: randomUUID(), generation: 4, phase: 'starting' },
      'start-intent'
    );
    const restarted = new ComputerService({
      root,
      backend,
      supported: true,
      enabled: () => true,
      createSession: async () => {
        throw new Error();
      },
      interruptTurns: async () => {},
    });
    expect((await restarted.status()).phase).toBe('uncertain');
    await expect(restarted.create()).rejects.toMatchObject({ code: 'cleanup-uncertain' });
    expect(backend.create).not.toHaveBeenCalled();
  });
  it('malformed stored identity is uncertainty and cannot create a new disk', async () => {
    const { root, service, backend } = await setup();
    await writeFile(join(root, 'computer.json'), '{broken', { mode: 0o600 });
    await expect(service.create()).rejects.toMatchObject({ code: 'cleanup-uncertain' });
    expect(backend.create).not.toHaveBeenCalled();
  });
  it('bounds a guest frame while streaming before exposing it', async () => {
    const { service, fetcher } = await setup();
    await ready(service);
    fetcher.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
              controller.close();
            },
          })
        )
    );
    await expect(service.frame('observer')).rejects.toMatchObject({ code: 'unavailable' });
  });
});

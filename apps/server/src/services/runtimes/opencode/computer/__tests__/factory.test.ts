import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComputerRuntime } from '../index.js';
import { shellHistory } from './fixtures/opencode-shell-history.js';
import { ComputerSessionMap } from '../session-map.js';
import { OpenCodeRuntime } from '../../opencode-runtime.js';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function factory() {
  const home = mkdtempSync(join(tmpdir(), 'computer-runtime-'));
  chmodSync(home, 0o700);
  homes.push(home);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const request = input as Request;
    expect(new URL(request.url).pathname).toBe('/provider');
    return Response.json({ all: [], connected: [], default: {} });
  });
  return {
    ...createComputerRuntime({
      runtimeId: 'computer-local',
      anchor: home,
      guestDirectory: '/home/agent/project',
      sessionMapPath: join(home, 'sessions.json'),
      currentEnabled: () => true,
      ensureEndpoint: async () => ({
        generation: 1,
        opencodeUrl: 'http://127.0.0.1:8123',
        opencodePassword: 'guest-only-password',
      }),
      fetch,
    }),
    fetch,
  };
}
describe('createComputerRuntime', () => {
  it('does not advertise host settings or credits for the guest runtime', () => {
    const { runtime } = factory();
    expect(runtime.getCapabilities().credits).toBeUndefined();
    expect(runtime.getCapabilities().settings).toEqual({
      configSection: null,
      supportsEffort: false,
      sections: [],
    });
  });

  it('keeps host identity intact and uses actual computer policy identity', async () => {
    const host = new OpenCodeRuntime({ provider: { getClient: vi.fn(), peekClient: () => null } });
    const { runtime } = factory();
    expect(host.type).toBe('opencode');
    expect(runtime.type).toBe('computer-local');
    expect(runtime.getCapabilities().type).toBe('computer-local');
    expect(await (runtime as OpenCodeRuntime).sessionRunsOnCredits('one')).toBe(false);
    expect(runtime.getConnectedProvider?.()).toBeNull();
  });
  it('refuses credits and host directory grants before any guest call', () => {
    const { runtime, fetch } = factory();
    expect(() => runtime.sendMessage('one', 'hello', { model: 'dorkos-credits/model' })).toThrow(
      'CREDITS_REFUSED'
    );
    expect(() =>
      runtime.sendMessage('one', 'hello', {
        additionalDirectories: [{ path: '/etc', access: 'read' }],
      })
    ).toThrow('DIRECTORY_REFUSED');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reads model and sign-in state only from the guest sidecar', async () => {
    const { runtime, fetch, revoke, provider } = factory();
    expect(await runtime.getSupportedModels()).toEqual([]);
    expect((await runtime.checkDependencies())[0].status).toBe('missing');
    expect(fetch).toHaveBeenCalledTimes(2);
    await revoke();
    expect(provider.peekClient()).toBeNull();
  });
});

it('reads actual non-git guest shell history after a factory/session-map restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'computer-shell-history-')));
  chmodSync(home, 0o700);
  homes.push(home);
  const mapPath = join(home, 'sessions.json');
  new ComputerSessionMap(mapPath).bind('session-one', 'ses_fixture');
  const request = vi.fn<typeof globalThis.fetch>(async (input) => {
    const req = input as Request;
    expect(new URL(req.url).pathname).toBe('/session/ses_fixture/message');
    expect(req.headers.get('x-opencode-directory')).toBe('/home/agent/project');
    return Response.json(shellHistory);
  });
  const options = {
    runtimeId: 'computer-local' as const,
    anchor: home,
    guestDirectory: '/home/agent/project' as const,
    sessionMapPath: mapPath,
    currentEnabled: () => true,
    ensureEndpoint: async () => ({
      generation: 1,
      opencodeUrl: 'http://127.0.0.1:8123',
      opencodePassword: 'guest-only-password',
    }),
    fetch: request,
  };
  const first = createComputerRuntime(options);
  const history = await first.runtime.getMessageHistory(home, 'session-one');
  expect(history).toHaveLength(1);
  expect(JSON.stringify(history)).toContain('qualification-marker');
  expect(JSON.stringify(history)).toContain('/home/agent/project');
  await first.revoke();
  const restarted = createComputerRuntime(options);
  expect(await restarted.runtime.getMessageHistory(home, 'session-one')).toEqual(history);
  await restarted.revoke();
});

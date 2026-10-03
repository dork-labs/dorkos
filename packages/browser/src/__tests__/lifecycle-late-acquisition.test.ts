import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { symlink, access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type { BrowserContext, BrowserType } from 'playwright-core';
import { verifiedLibrary } from '../runtime/public-library.js';
import { createBrowserEngine } from '../index.js';
import { configuration, fixture, requestId, profileId } from './lifecycle-fixture.js';
vi.mock('../runtime/public-library.js', () => ({ verifiedLibrary: vi.fn() }));

it.each(['verified', 'unknown', 'replaced-reservation'] as const)(
  'never publishes timed-out launch and handles late %s ownership conservatively',
  async (mode) => {
    const owned = await fixture();
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const exited = once(child, 'exit');
    await once(child, 'spawn');
    let profileDir = '';
    let resolve!: (context: BrowserContext) => void;
    let launchEntered!: () => void;
    const entered = new Promise<void>((done) => {
      launchEntered = done;
    });
    let closeCalls = 0;
    const launch = new Promise<BrowserContext>((done) => {
      resolve = done;
    });
    vi.mocked(verifiedLibrary).mockResolvedValue({
      launchPersistentContext: async (path: string) => {
        profileDir = path;
        launchEntered();
        return launch;
      },
    } as unknown as BrowserType);
    const config = await configuration(join(owned.root, 'data'), owned.origin);
    let unavailable = false;
    const observeTree = config.processes.descendants;
    config.processes.descendants = (identity, signal) =>
      unavailable
        ? Promise.resolve({ status: 'unknown', identities: [] })
        : observeTree(identity, signal);
    const engine = createBrowserEngine(config);
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const opening = engine.open(
        mode === 'replaced-reservation'
          ? { kind: 'open', requestId, mode: 'persistent', profileId }
          : { kind: 'open', requestId, mode: 'ephemeral' }
      );
      const rejection = expect(opening).rejects.toMatchObject({
        code: 'BROWSER_LAUNCH_TIMEOUT',
        cleanupCode: 'observationUnavailable',
      });
      await entered;
      await vi.advanceTimersByTimeAsync(10_001);
      await rejection;
      vi.useRealTimers();
      const original = (await engine.shutdown())[0]!;
      expect(original).toMatchObject({ cleanup: 'unverified' });
      await symlink(`${hostname()}-${child.pid}`, join(profileDir, 'SingletonLock'));
      if (mode === 'unknown') unavailable = true;
      const ownerFile = join(config.dataDir, 'reservations', profileId, 'owner.json');
      if (mode === 'replaced-reservation') {
        const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
        owner.nonce = '11111111-1111-4111-8111-111111111111';
        await writeFile(ownerFile, JSON.stringify(owner));
      }
      resolve({
        close: async () => {
          closeCalls++;
          child.kill('SIGTERM');
          await exited;
        },
      } as BrowserContext);
      await expect.poll(() => closeCalls).toBe(1);
      await exited;
      const late = await engine.close({
        kind: 'close',
        requestId,
        browserId: original.browserId,
        browserGeneration: original.browserGeneration,
      });
      // Late cooperative closure cannot replace the first uncertain parent outcome.
      expect(late.cleanup).toBe('unverified');
      if (late.cleanup === 'observed' || original.cleanup === 'observed')
        throw Error('Opening timeout cannot become observed cleanup');
      expect(late.reason).toBe(original.reason);
      expect(closeCalls).toBe(1);
      await access(profileDir); // Retain quarantined ownership even after an observed child exit.
      if (mode === 'replaced-reservation')
        expect(JSON.parse(await readFile(ownerFile, 'utf8')).nonce).toBe(
          '11111111-1111-4111-8111-111111111111'
        );
      expect(owned.reports).toHaveLength(0);
      expect((await engine.shutdown())[0]).toMatchObject({ cleanup: 'unverified' }); // No retrospective invented success.
    } finally {
      vi.useRealTimers();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      await engine.shutdown();
      await owned.close();
    }
  },
  10_000
);

it('keeps an acquired context in the cleanup ledger when post-launch setup fails and close rejects', async () => {
  const owned = await fixture();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  let profileDir = '';
  let closeCalls = 0;
  vi.mocked(verifiedLibrary).mockResolvedValue({
    launchPersistentContext: async (path: string) => {
      profileDir = path;
      await symlink(`${hostname()}-${child.pid}`, join(path, 'SingletonLock'));
      return {
        on: () => {
          throw Error('PRIVATE-SETUP-SECRET');
        },
        close: async () => {
          closeCalls++;
          throw Error('PRIVATE-CLOSE-SECRET');
        },
      };
    },
  } as unknown as BrowserType);
  const config = await configuration(join(owned.root, 'data'), owned.origin);
  const engine = createBrowserEngine(config);
  try {
    const error = await engine
      .open({ kind: 'open', requestId, mode: 'ephemeral' })
      .catch((error) => error);
    expect(error).toMatchObject({ code: 'OPEN_FAILED', cleanupCode: 'closeFailed' });
    expect(String(error)).not.toContain('PRIVATE-');
    expect(closeCalls).toBe(1);
    await access(profileDir);
    expect((await engine.shutdown())[0]).toMatchObject({
      cleanup: 'failed',
      reason: 'closeFailed',
    });
    expect(owned.reports).toHaveLength(0);
  } finally {
    child.kill('SIGTERM');
    await exited;
    await engine.shutdown();
    await owned.close(); // Explicit test repair after the precisely owned child has exited.
  }
}, 5000);

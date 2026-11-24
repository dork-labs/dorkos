import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import type { RunnerExitFixture } from './runner-parent-exit.setup.js';
import { mkdir, mkdtemp, realpath, rm, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, inject, it, vi } from 'vitest';
import { RUNTIME_ENV_PROFILES } from '../../../../shared/runtime-environment-catalog.js';
import type { SidecarSpawnPort } from '../../../sidecar-custody.js';
import { createPinnedManagerCustody } from '../../pinned-manager-custody.js';
import { OFFLINE_PROXY_ENV, pinnedOpenCode } from '../../pinned-opencode.js';

const armed =
  process.env.DORKOS_OPENCODE_PINNED_SERVE_PROOF === '1' &&
  process.env.DORKOS_TEST_RUNNER_EXIT_CHILD === '1';
type SidecarChild = Awaited<ReturnType<SidecarSpawnPort['start']>>;

// These two names are overwritten below. All other supported profile inputs
// must be absent, even when empty, before this fixture starts a native child.
const fixtureFlags = new Set<string>([
  'OPENCODE_DISABLE_MODELS_FETCH',
  'OPENCODE_DISABLE_AUTOUPDATE',
]);
const refusedProfileNames = RUNTIME_ENV_PROFILES.OpenCode.filter((name) => !fixtureFlags.has(name));

/** Hold the worker's event loop until the outer observer has completed or its deadline passes. */
function waitForSilentWorkerRelease(control: RunnerExitFixture): boolean {
  const release = join(control.root, 'worker-release');
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const blocking = join(control.root, 'worker-blocking');
  const stopAt = control.deadline - 1000;
  writeFileSync(blocking + '.part', JSON.stringify({ pid: process.pid, stopAt }), {
    flag: 'wx',
    mode: 0o600,
  });
  renameSync(blocking + '.part', blocking + '.json');
  while (Date.now() < stopAt) {
    if (existsSync(release)) return readFileSync(release, 'utf8') === 'proof-observed\n';
    // Synchronous on purpose. IPC and scope events do not reach JS in this window.
    Atomics.wait(cell, 0, 0, Math.min(25, Math.max(0, stopAt - Date.now())));
  }
  return false;
}

it.skipIf(!armed)(
  'readies the pinned sidecar before its fixture runner exits itself',
  async ({ signal }) => {
    // Presence-only check: never read, print or copy ambient credential values.
    if (refusedProfileNames.some((name) => Object.hasOwn(process.env, name)))
      throw new Error('Pinned serve refuses ambient OpenCode credentials or configuration');
    const control = inject('runnerExitFixture');
    expect(process.ppid).toBe(control.mainPid);
    process.once('exit', (code) =>
      writeFileSync(
        join(control.root, 'worker-exit.json'),
        JSON.stringify({ version: 1, code, workerPid: process.pid, mainPid: control.mainPid }) +
          '\n',
        {
          flag: 'wx',
          mode: 0o600,
        }
      )
    );
    const binary = pinnedOpenCode();
    if (binary === null) throw new Error('Pinned serve subject unavailable');
    const provided = inject('openCodeCustody');
    if (provided.kind !== 'available')
      throw new Error('Pinned serve needs the stock custody setup');
    const root = await realpath(await mkdtemp(join(control.root, 'native-')));
    const suite = new AbortController();
    const fixture = createPinnedManagerCustody(provided, AbortSignal.any([suite.signal, signal]));
    let manager: { shutdown(): Promise<void> } | undefined;
    const failures: unknown[] = [];
    try {
      for (const dir of [
        'home',
        'config/opencode',
        'data',
        'cache',
        'state',
        'dork',
        'workspace',
        'temp',
      ])
        await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, 'config', 'opencode', 'opencode.json'),
        JSON.stringify({ enabled_providers: [] }),
        { mode: 0o600 }
      );
      for (const [name, dir] of Object.entries({
        HOME: 'home',
        DORK_HOME: 'dork',
        XDG_CONFIG_HOME: 'config',
        XDG_DATA_HOME: 'data',
        XDG_CACHE_HOME: 'cache',
        XDG_STATE_HOME: 'state',
        TMPDIR: 'temp',
        TMP: 'temp',
        TEMP: 'temp',
      })) {
        vi.stubEnv(name, join(root, dir));
      }
      vi.stubEnv('OPENCODE_DISABLE_MODELS_FETCH', '1');
      vi.stubEnv('OPENCODE_DISABLE_AUTOUPDATE', '1');
      for (const [name, value] of Object.entries(OFFLINE_PROXY_ENV)) vi.stubEnv(name, value);
      await writeFile(
        join(root, 'dork', 'config.json'),
        JSON.stringify({
          runtimes: {
            default: 'opencode',
            opencode: {
              enabled: true,
              binaryPath: binary,
              port: 0,
              provider: null,
              baseURL: null,
              defaultModel: null,
              defaultTrustStop: null,
            },
          },
        }),
        { mode: 0o600 }
      );
      (await import('../../../../../core/config-manager.js')).initConfigManager(join(root, 'dork'));

      const expectedImage = await realpath(binary);
      const starts: SidecarChild[] = [];
      const joins: Awaited<ReturnType<SidecarChild['stopAndJoin']>>[] = [];
      const custody: SidecarSpawnPort = {
        async start(request, owner) {
          // Check the normal projection before passing it to the existing owner.
          for (const name of refusedProfileNames)
            expect(Object.hasOwn(request.env, name)).toBe(false);
          for (const name of ['TMPDIR', 'TMP', 'TEMP'])
            expect(request.env[name]).toBe(join(root, 'temp'));
          expect(request.env.HOME).toBe(join(root, 'home'));
          expect(request.env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1');
          expect(request.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
          expect(request.argv[0]).toBe('serve');
          expect(await realpath(request.executable)).toBe(expectedImage);
          const child = await fixture.port.start(request, owner);
          starts.push(child);
          return {
            ...child,
            async stopAndJoin(reason, deadline) {
              const joined = await child.stopAndJoin(reason, deadline);
              joins.push(joined);
              return joined;
            },
          };
        },
      };
      const { OpenCodeServerManager } = await import('../../../server-manager.js');
      const live = new OpenCodeServerManager({ custody, runsOnCredits: () => false });
      manager = live;
      // The manager reads the ready line and constructs a client. No SDK call follows.
      await live.getClient(join(root, 'workspace'));
      expect(starts).toHaveLength(1);
      const child = starts[0];
      expect(child.pid).toBeGreaterThan(0);
      await expect(child.spawn).resolves.toMatchObject({
        kind: 'spawned',
        pid: child.pid,
        executable: expectedImage,
      });
      expect(fixture.report()).toEqual({ retain: true, failures: [] });

      const spawn = await child.spawn;
      await writeFile(
        join(control.root, 'pinned-ready.part'),
        JSON.stringify({
          ready: true,
          starts: starts.length,
          mainPid: control.mainPid,
          workerPid: process.pid,
          workerParentPid: process.ppid,
          target: spawn,
        }) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
      await rename(
        join(control.root, 'pinned-ready.part'),
        join(control.root, 'pinned-ready.json')
      );
      if (control.mode === 'silent-worker') {
        // A successful release follows observed native closure. Returning lets the
        // real worker handle its now-closed runner channel and retire.
        if (waitForSilentWorkerRelease(control)) return;
      } else {
        // The nested main observes the first readiness receipt and exits itself.
        await wait(Math.max(0, control.deadline - Date.now()));
      }
      writeFileSync(join(control.root, 'worker-fallback-started'), '', { flag: 'wx', mode: 0o600 });
      throw new Error('Fixture runner remained beyond its existing deadline');
    } catch (error) {
      failures.push(error);
    }
    const [shutdown] = await Promise.allSettled([manager?.shutdown()]);
    const evidence = fixture.report();
    suite.abort();
    vi.unstubAllEnvs();
    if (shutdown.status === 'rejected') failures.push(shutdown.reason);
    failures.push(...evidence.failures);
    if (shutdown.status === 'fulfilled' && !evidence.retain) {
      const [removed] = await Promise.allSettled([rm(root, { recursive: true, force: true })]);
      if (removed.status === 'rejected') failures.push(removed.reason);
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Pinned serve proof failed');
  },
  30_000
);

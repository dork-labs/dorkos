/**
 * The contract boot's one deadline (DOR-4687, after #3932): a slow build and
 * slow boot attempts end in the harness's own verdict, inside
 * {@link BOOT_BUDGET_MS}, before vitest would abandon the `beforeAll` hook at
 * {@link BOOT_HOOK_TIMEOUT_MS} and leave a server running with nobody to stop it.
 *
 * It drives the real boot code ({@link bootWithEdges}: the build wait, the
 * port-loss retry, the health check) on a fake clock, with fake edges: the build
 * is a timer, the server is a bare `ChildProcess` that is never spawned, and the
 * health probe is a `fetch` that never connects. Nothing is built or booted,
 * and this run's shared build folder is never touched.
 */
import { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_BUDGET_MS,
  BOOT_HOOK_TIMEOUT_MS,
  BOOT_TIMEOUT_MS,
  bootWithEdges,
  type BootEdges,
  type StartedServer,
} from './harness.js';
import { SERVER_DIR } from './server-build.js';
import { KILL_WAIT_MS, STOP_GRACE_MS } from './stop-server.js';

const ENTRY = 'src/index.ts';
const BUILT = new Map([[path.resolve(SERVER_DIR, ENTRY), '/built/index.mjs']]);

/** A started server that never answers; `exitAfterMs` makes it die first, as a lost port does. */
function fakeServer(n: number, exitAfterMs?: number): StartedServer & { closed: boolean } {
  const child = new ChildProcess();
  const port = 50_000 + n;
  if (exitAfterMs !== undefined) {
    setTimeout(() => Object.assign(child, { exitCode: 1 }), exitAfterMs);
  }
  const server = {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    version: `0.0.0-contract.r${n}`,
    dorkHome: `/fake/home-${n}`,
    log: () => (exitAfterMs === undefined ? '' : `Error: Port ${port} is already in use`),
    closed: false,
    close: async () => {
      server.closed = true;
    },
  };
  return server;
}

/** The boot's verdict, and the fake-clock time it came at. */
interface Verdict {
  readonly error: Error;
  readonly atMs: number;
}

/**
 * Boot with `edges` and run the clock to the hook's budget. Returns the
 * harness's verdict, or `undefined` if it was still waiting when vitest
 * would have abandoned the hook.
 */
async function bootUntilHookTimeout(edges: BootEdges): Promise<Verdict | undefined> {
  const started = Date.now();
  let verdict: Verdict | undefined;
  void bootWithEdges(edges, {}, ENTRY, {}).then(
    () => {
      verdict = { error: new Error('A server that never answers was reported up'), atMs: 0 };
    },
    (error: Error) => {
      verdict = { error, atMs: Date.now() - started };
    }
  );
  await vi.advanceTimersByTimeAsync(BOOT_HOOK_TIMEOUT_MS);
  return verdict;
}

describe('the contract boot deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // No server is listening, so every health probe fails as a refused connection does.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('fetch failed')))
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('gives up on a build that never finishes, before the hook would, and starts no server', async () => {
    const start = vi.fn<BootEdges['start']>();
    const verdict = await bootUntilHookTimeout({
      runsFromBuild: async () => true,
      build: () => new Promise(() => {}),
      start,
    });

    expect(
      verdict,
      `still waiting for the build at ${BOOT_HOOK_TIMEOUT_MS} ms: vitest would abandon the hook first`
    ).toBeDefined();
    expect(verdict!.error.message).toMatch(
      `ran out of its ${BOOT_BUDGET_MS} ms waiting for the contract server build`
    );
    expect(verdict!.atMs).toBeLessThanOrEqual(BOOT_BUDGET_MS);
    expect(start).not.toHaveBeenCalled();
  });

  it('holds one deadline across a slow build, a late lost port and a server that never answers', async () => {
    // The build lands just inside its own wait; the first server dies late on
    // a lost port; the retry never answers. Each step alone is within its own
    // bound, but a fresh bound per step would end at 179 + 170 + 180 s.
    let built: Promise<Map<string, string>> | undefined;
    const servers: ReturnType<typeof fakeServer>[] = [];
    const verdict = await bootUntilHookTimeout({
      runsFromBuild: async () => true,
      build: () => (built ??= new Promise((resolve) => setTimeout(() => resolve(BUILT), 179_000))),
      start: async (args) => {
        expect(args.at(-1)).toBe('/built/index.mjs');
        const server = fakeServer(servers.length, servers.length === 0 ? 170_000 : undefined);
        servers.push(server);
        return server;
      },
    });

    expect(
      verdict,
      `no verdict by ${BOOT_HOOK_TIMEOUT_MS} ms: vitest would abandon the hook with a server running`
    ).toBeDefined();
    expect(verdict!.error.message).toMatch(/did not answer \/api\/health/);
    expect(verdict!.atMs).toBeLessThanOrEqual(BOOT_BUDGET_MS);
    expect(servers).toHaveLength(2);
    expect(
      servers.map((s) => s.closed),
      'every server started is stopped'
    ).toEqual([true, true]);
  });

  it('stops retrying after three lost ports and reports the last exit', async () => {
    const servers: ReturnType<typeof fakeServer>[] = [];
    const verdict = await bootUntilHookTimeout({
      runsFromBuild: async () => true,
      build: async () => BUILT,
      start: async () => {
        const server = fakeServer(servers.length, 1_000);
        servers.push(server);
        return server;
      },
    });

    expect(verdict, 'no verdict after every port was lost').toBeDefined();
    expect(verdict!.error.message).toMatch(/The server exited \(1\) before it answered/);
    expect(verdict!.error.message).toMatch(/Port 50002 is already in use/);
    expect(servers).toHaveLength(3);
    expect(
      servers.map((s) => s.closed),
      'every server started is stopped'
    ).toEqual([true, true, true]);
  });

  it('leaves the hook room to stop the last server after the budget runs out', () => {
    expect(BOOT_BUDGET_MS).toBeGreaterThanOrEqual(BOOT_TIMEOUT_MS);
    expect(BOOT_HOOK_TIMEOUT_MS - BOOT_BUDGET_MS).toBeGreaterThanOrEqual(
      STOP_GRACE_MS + KILL_WAIT_MS
    );
  });
});

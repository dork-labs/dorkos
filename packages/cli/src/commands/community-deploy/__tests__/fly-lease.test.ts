/** @vitest-environment node */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCommunityDeployPhase } from '../deploy.js';
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import { ProviderMutationError } from '../provider-mutation.js';
import { ProviderCommandError } from '../provider-process.js';
import { createDefaultCommunityDeployDependencies } from '../runtime/default-deploy.js';
import {
  FLY_LEASE_WAIT_LIMIT_MS,
  FlyMachineBusyError,
  readFlyMachineLease,
  waitForFlyMachineLeases,
  type FlyMachineLease,
} from '../runtime/fly-lease.js';

const APP = 'dorkos-community-test';
const MACHINE = '6834251f306958';
const INDEX = `sha256:${'a'.repeat(64)}`;
const PLATFORM = `sha256:${'f'.repeat(64)}`;
const REPOSITORY = 'ghcr.io/dork-labs/dorkos-community';

const plan = createLaunchPlan({
  dorkosVersion: '0.96.0',
  imageDigest: INDEX,
  fly: {
    organizationId: 'personal',
    organizationName: 'Personal',
    appName: APP,
    region: 'ord',
    machineSize: 'shared-cpu-1x',
  },
  neon: {
    organizationId: 'org-dorian',
    organizationName: 'Dorian',
    projectName: APP,
    region: 'aws-us-east-2',
  },
  tigris: { bucketName: APP, private: true },
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A fixed wall clock for every test here; only a fake sleep moves it. */
const START_MS = 1_759_533_425_000;

/**
 * A fake `fly` that behaves like flyctl v0.4.110 around a Machine lease: `machine leases view`
 * reports the lease for its first `heldReads` reads (as `{}` after), and `deploy` fails while the
 * lease is held, exactly as the resumed deploy did in DOR-2170 L3 (release v2 `failed`). Counting
 * reads instead of reading the real clock keeps the tests deterministic under load.
 *
 * @param heldReads - How many lease reads report the lease before it is gone.
 * @param leaseUntilSeconds - The lease's `expires_at`, in Unix seconds; null to omit it.
 */
async function fakeFly(heldReads: number, leaseUntilSeconds: number | null = null) {
  const root = await mkdtemp(join(tmpdir(), 'dorkos-fly-lease-'));
  roots.push(root);
  const state = join(root, 'state.json');
  await writeFile(state, JSON.stringify({ heldReads, leaseUntil: leaseUntilSeconds, calls: [] }));
  const executable = join(root, 'fly');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const args = process.argv.slice(2);
const held = state.heldReads > 0;
state.calls.push({ args: args.filter((arg) => !arg.endsWith('fly.toml')), held });
if (args[0] === 'machine' && args[1] === 'leases' && args[2] === 'view') {
  const id = args[3];
  const data = { nonce: 'nonce', owner: 'someone@tokens.fly.io', version: 'v1' };
  if (state.leaseUntil !== null) data.expires_at = state.leaseUntil;
  if (held) state.heldReads -= 1;
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
  process.stdout.write(JSON.stringify(held ? { [id]: { status: 'success', data } } : {}));
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
if (args[0] === 'deploy') {
  if (held) {
    process.stderr.write('Error: failed to acquire leases: failed to get lease on VM ' + '${MACHINE}' + ': lease currently held by someone@tokens.fly.io');
    process.exit(1);
  }
  process.exit(0);
}
process.exit(2);
`
  );
  await chmod(executable, 0o755);
  return {
    executable,
    calls: async () =>
      (JSON.parse(await readFile(state, 'utf8')) as { calls: { args: string[]; held: boolean }[] })
        .calls,
  };
}

function defaults(
  executable: string,
  progress: (line: string) => void = () => undefined,
  signal?: AbortSignal
) {
  let now = START_MS;
  const sleeps: number[] = [];
  const runtime = createDefaultCommunityDeployDependencies({
    options: {
      fly: { executable, env: {}, timeoutMs: 10_000, signal },
      neon: { executable: 'neonctl', env: {}, timeoutMs: 10_000 },
      graphqlTimeoutMs: 10_000,
    },
    plan,
    latestJournal: () => {
      throw new Error('unused');
    },
    persist: vi.fn(),
    now: () => '2026-10-03T23:17:05.000Z',
    resolvePlatformDigest: async () => PLATFORM,
    progress,
    leaseClock: {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  });
  return Object.assign(runtime, { sleeps });
}

const SECRET_DIGESTS = {
  COMMUNITY_DATABASE_URL: 'database',
  COMMUNITY_AUTH_SECRET: 'auth',
  COMMUNITY_INVITE_SECRET: 'invite',
  COMMUNITY_BOOTSTRAP_SECRET: 'bootstrap',
};

// The journal and Fly state right after one Control-C during `fly deploy` (DOR-2170 L3, run 28f2a212).
const stopped: LaunchJournal = LaunchJournalSchema.parse({
  schemaVersion: 1,
  runId: '28f2a212-6638-4588-b154-9d25bf59701c',
  revision: 13,
  planHash: 'b'.repeat(64),
  releaseDigest: INDEX,
  imagePlatformDigest: PLATFORM,
  state: 'secrets_staged',
  pendingIntent: null,
  resources: { flyAppId: 'app-id', neonProjectId: 'project-id', tigrisBucketId: 'bucket-id' },
  secretBaseline: {},
  secretDigests: SECRET_DIGESTS,
  verifiedBindings: [],
  completedSteps: [
    'planned',
    'fly_app_created',
    'neon_project_created',
    'bucket_created',
    'secrets_staged',
  ],
  lastSafeError: { category: 'transient', code: 'CANCELLED' },
  createdAt: '2026-10-03T23:15:36.000Z',
  updatedAt: '2026-10-03T23:16:23.000Z',
});

const interrupted = {
  machines: [
    {
      id: MACHINE,
      name: 'machine',
      state: 'started',
      region: 'ord',
      imageDigest: PLATFORM,
      imageRepository: REPOSITORY,
      checks: [{ name: 'health', status: 'passing' }],
    },
  ],
  releases: [
    {
      id: 'release-1',
      imageRef: `${REPOSITORY}@${PLATFORM}`,
      status: 'interrupted',
      stable: false,
      version: 1,
    },
  ],
  addresses: [{ address: '203.0.113.1', type: 'v4', region: '' }],
};

describe('resuming right after a deploy stopped with Control-C (DOR-2702)', () => {
  it('waits for the stopped deploy to let go of the Machine, then deploys', async () => {
    // The lease is held for the first read and gone on the next, 3.5 minutes before it would end.
    const fly = await fakeFly(1, START_MS / 1000 + 210);
    const lines: string[] = [];
    const runtime = defaults(fly.executable, (line) => lines.push(line));
    const result = await executeCommunityDeployPhase(plan, stopped, {
      ...runtime,
      persist: vi.fn(async () => undefined),
      readSecrets: vi.fn(async () =>
        Object.entries(SECRET_DIGESTS).map(([name, digest]) => ({
          name,
          digest,
          status: 'Deployed' as const,
        }))
      ),
      readRuntime: vi.fn(async () => interrupted),
      verifyNewRuntime: vi.fn((inventory) => inventory),
      verifyHealth: vi.fn(async () => undefined),
    });

    expect(result.journal.state).toBe('healthy');
    const calls = await fly.calls();
    // Read (held), wait, read (gone), then exactly one deploy, which never ran into the lease.
    expect(calls.map((call) => [call.args[0], call.held])).toEqual([
      ['machine', true],
      ['machine', false],
      ['deploy', false],
    ]);
    expect(calls[0]?.args).toEqual(['machine', 'leases', 'view', MACHINE, '--app', APP, '--json']);
    expect(runtime.sleeps).toEqual([15_000]);
    expect(lines).toEqual([
      `Fly is still holding the Machine of ${APP} for another deploy. Waiting up to about 4 minutes for Fly to let go of it…`,
      'Fly has let go of the Machine. Deploying now…',
    ]);
  });

  it('says plainly when to try again if a deploy still fails on a held lease', async () => {
    const fly = await fakeFly(5, START_MS / 1000 + 4 * 60 - 10);
    const failure = new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
    const explained = await defaults(fly.executable).explainDeployFailure(failure, [MACHINE]);
    expect(explained).toBeInstanceOf(FlyMachineBusyError);
    expect((explained as Error).message).toBe(
      `Fly is still holding the Machine of ${APP} for another deploy, so setup did not deploy over it. ` +
        'Wait about 4 minutes, then run the resume command above again.'
    );
    // The lease's owner is never repeated.
    expect((explained as Error).message).not.toContain('tokens.fly.io');

    // A lease with no end time: no number of minutes is made up.
    const endless = await fakeFly(5, null);
    await expect(
      defaults(endless.executable).explainDeployFailure(failure, [MACHINE])
    ).resolves.toMatchObject({ message: expect.stringContaining('Wait a few minutes,') });

    // A lease whose end has passed is not held, so the deploy's own error stands.
    const lapsed = await fakeFly(5, START_MS / 1000 - 1);
    await expect(
      defaults(lapsed.executable).explainDeployFailure(failure, [MACHINE])
    ).resolves.toBe(failure);

    // No lease: the deploy's own error stands. No Machine: Fly is not asked at all.
    const free = await fakeFly(0);
    await expect(defaults(free.executable).explainDeployFailure(failure, [MACHINE])).resolves.toBe(
      failure
    );
    await expect(defaults(free.executable).explainDeployFailure(failure, [])).resolves.toBe(
      failure
    );
    expect(await free.calls()).toHaveLength(1);
  });

  it('keeps the error of a deploy that setup itself cancelled, even with the lease held', async () => {
    const fly = await fakeFly(5, START_MS / 1000 + 120);
    const stop = new AbortController();
    stop.abort();
    const cancelled = new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
    await expect(
      defaults(fly.executable, undefined, stop.signal).explainDeployFailure(cancelled, [MACHINE])
    ).resolves.toBe(cancelled);
  });

  it('reads a lease from flyctl JSON and nothing else', async () => {
    const until = START_MS / 1000 + 120;
    const held = await fakeFly(1, until);
    const options = { executable: held.executable, env: {}, timeoutMs: 10_000 };
    await expect(readFlyMachineLease(options, APP, MACHINE)).resolves.toEqual({
      expiresAtMs: until * 1000,
    });
    const endless = await fakeFly(1, null);
    await expect(
      readFlyMachineLease({ ...options, executable: endless.executable }, APP, MACHINE)
    ).resolves.toEqual({ expiresAtMs: null });
    const free = await fakeFly(0);
    await expect(
      readFlyMachineLease({ ...options, executable: free.executable }, APP, MACHINE)
    ).resolves.toBeNull();
  });
});

/** A clock that moves only when the wait sleeps. */
function clockedWait(
  leases: (now: number, machineId: string) => FlyMachineLease | Error,
  limitMs?: number,
  machineIds: readonly string[] = [MACHINE]
) {
  let now = 1_000_000;
  const lines: string[] = [];
  const sleeps: number[] = [];
  const run = waitForFlyMachineLeases({
    appName: APP,
    machineIds,
    readLease: async (machineId) => {
      const lease = leases(now, machineId);
      if (lease instanceof Error) throw lease;
      return lease;
    },
    progress: (line) => lines.push(line),
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    limitMs,
  });
  return { run, lines, sleeps, elapsed: () => now - 1_000_000 };
}

describe('waiting for a Machine lease', () => {
  it('returns at once, silently, when nothing is leased', async () => {
    const wait = clockedWait(() => null);
    await wait.run;
    expect(wait.lines).toEqual([]);
    expect(wait.sleeps).toEqual([]);
  });

  it('waits for a lease that ends within the limit, with a progress line', async () => {
    const ends = 1_000_000 + 3.5 * 60_000;
    const wait = clockedWait((now) => (now < ends ? { expiresAtMs: ends } : null));
    await wait.run;
    expect(wait.lines[0]).toBe(
      `Fly is still holding the Machine of ${APP} for another deploy. Waiting up to about 4 minutes for Fly to let go of it…`
    );
    expect(wait.lines).toContain('Still waiting for Fly to let go of the Machine…');
    expect(wait.lines.at(-1)).toBe('Fly has let go of the Machine. Deploying now…');
    expect(wait.elapsed()).toBeGreaterThanOrEqual(3.5 * 60_000);
    expect(wait.elapsed()).toBeLessThan(FLY_LEASE_WAIT_LIMIT_MS);
  });

  it('stops at once, with a time to retry, for a lease that ends after the limit', async () => {
    const wait = clockedWait(() => ({ expiresAtMs: 1_000_000 + 20 * 60_000 }));
    await expect(wait.run).rejects.toThrow(
      `Fly is still holding the Machine of ${APP} for another deploy, so setup did not deploy over it. Wait about 20 minutes, then run the resume command above again.`
    );
    expect(wait.sleeps).toEqual([]);
  });

  it('gives up at the limit when the lease keeps being renewed', async () => {
    // A deploy that is still running refreshes its 13-second lease, so it never ends.
    const wait = clockedWait((now) => ({ expiresAtMs: now + 13_000 }));
    await expect(wait.run).rejects.toBeInstanceOf(FlyMachineBusyError);
    await expect(wait.run).rejects.toThrow('Wait a few minutes');
    expect(wait.elapsed()).toBe(FLY_LEASE_WAIT_LIMIT_MS);
  });

  it('ignores a lease whose end has already passed', async () => {
    // Fly can still report a lease for a moment after it ends; it no longer locks the Machine.
    const wait = clockedWait((now) => ({ expiresAtMs: now - 1 }));
    await wait.run;
    expect(wait.lines).toEqual([]);
    expect(wait.sleeps).toEqual([]);
  });

  it('waits for a lease with no end time without inventing one', async () => {
    let reads = 0;
    const wait = clockedWait(() => (++reads <= 2 ? { expiresAtMs: null } : null));
    await wait.run;
    expect(wait.lines[0]).toBe(
      `Fly is still holding the Machine of ${APP} for another deploy. Waiting for Fly to let go of it…`
    );
    expect(wait.sleeps).toEqual([15_000, 15_000]);

    // Beside a lease that does end, the unknown end still wins: no time is promised.
    let pairs = 0;
    const mixed = clockedWait(
      (now, machine) =>
        ++pairs > 2 ? null : machine === 'a' ? { expiresAtMs: null } : { expiresAtMs: now + 5_000 },
      undefined,
      ['a', 'b']
    );
    await mixed.run;
    expect(mixed.lines[0]).toContain('Waiting for Fly to let go of it…');
    expect(mixed.sleeps).toEqual([15_000]);
  });

  it('never sleeps past the lease end or the limit', async () => {
    // Read again two seconds after the lease ends, not a full poll later.
    const ends = 1_000_000 + 5_000;
    const short = clockedWait((now) => (now < ends ? { expiresAtMs: ends } : null));
    await short.run;
    expect(short.sleeps).toEqual([7_000]);

    // A renewed lease near the limit: the last sleep stops exactly at the limit.
    const capped = clockedWait((now) => ({ expiresAtMs: now + 9_500 }), 10_000);
    await expect(capped.run).rejects.toBeInstanceOf(FlyMachineBusyError);
    expect(capped.sleeps).toEqual([10_000]);

    // Even below the one-second floor between reads.
    const tiny = clockedWait((now) => ({ expiresAtMs: now + 400 }), 500);
    await expect(tiny.run).rejects.toBeInstanceOf(FlyMachineBusyError);
    expect(tiny.sleeps).toEqual([500]);
  });

  it('deploys as before when the lease cannot be read, but never swallows a cancellation', async () => {
    const unreadable = clockedWait(() => new ProviderCommandError('EXIT'));
    await unreadable.run;
    expect(unreadable.lines).toEqual([]);

    const cancelled = clockedWait(() => new ProviderCommandError('CANCELLED'));
    await expect(cancelled.run).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

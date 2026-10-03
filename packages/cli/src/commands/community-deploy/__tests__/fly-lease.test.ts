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

/**
 * A fake `fly` that behaves like flyctl v0.4.110 around a Machine lease: `machine leases view`
 * reports the lease until it ends (as `{}` after), and `deploy` fails while the lease is held,
 * exactly as the resumed deploy did in DOR-2170 L3 (release v2 `failed`).
 *
 * @param leaseUntilSeconds - When the stopped deploy's lease ends, in Unix seconds; null for none.
 */
async function fakeFly(leaseUntilSeconds: number | null) {
  const root = await mkdtemp(join(tmpdir(), 'dorkos-fly-lease-'));
  roots.push(root);
  const state = join(root, 'state.json');
  await writeFile(state, JSON.stringify({ leaseUntil: leaseUntilSeconds, calls: [] }));
  const executable = join(root, 'fly');
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const args = process.argv.slice(2);
const held = state.leaseUntil !== null && Date.now() < state.leaseUntil * 1000;
state.calls.push({ args: args.filter((arg) => !arg.endsWith('fly.toml')), held });
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
if (args[0] === 'machine' && args[1] === 'leases' && args[2] === 'view') {
  const id = args[3];
  process.stdout.write(JSON.stringify(held ? { [id]: { status: 'success', data: { nonce: 'nonce', expires_at: state.leaseUntil, owner: 'someone@tokens.fly.io', version: 'v1' } } } : {}));
  process.exit(0);
}
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

function defaults(executable: string, progress: (line: string) => void = () => undefined) {
  return createDefaultCommunityDeployDependencies({
    options: {
      fly: { executable, env: {}, timeoutMs: 10_000 },
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
  });
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
    // The stopped deploy's lease ends a moment from now, as it would at the end of its five minutes.
    const fly = await fakeFly(Math.ceil(Date.now() / 1000) + 1);
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
    const deploys = (await fly.calls()).filter((call) => call.args[0] === 'deploy');
    // One deploy, made only after Fly reported the lease gone: it never ran into the lease.
    expect(deploys).toEqual([
      { args: expect.arrayContaining(['deploy', '--app', APP]), held: false },
    ]);
    expect((await fly.calls())[0]?.args).toEqual([
      'machine',
      'leases',
      'view',
      MACHINE,
      '--app',
      APP,
      '--json',
    ]);
    expect(lines[0]).toMatch(/^Fly is still finishing the deploy that was stopped on /u);
    expect(lines.at(-1)).toBe('Fly has let go of the Machine. Deploying now…');
  }, 20_000);

  it('says plainly when to try again if a deploy still fails on a held lease', async () => {
    const fly = await fakeFly(Math.ceil(Date.now() / 1000) + 4 * 60 - 10);
    const failure = new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN');
    const explained = await defaults(fly.executable).explainDeployFailure(failure, [MACHINE]);
    expect(explained).toBeInstanceOf(FlyMachineBusyError);
    expect((explained as Error).message).toBe(
      `Fly is still finishing an earlier deploy of ${APP}, so setup did not deploy over it. ` +
        'Wait about 4 minutes, then run the resume command above again.'
    );
    // The lease's owner is never repeated.
    expect((explained as Error).message).not.toContain('tokens.fly.io');

    // No lease: the deploy's own error stands. No Machine: Fly is not asked at all.
    const free = await fakeFly(null);
    await expect(defaults(free.executable).explainDeployFailure(failure, [MACHINE])).resolves.toBe(
      failure
    );
    await expect(defaults(free.executable).explainDeployFailure(failure, [])).resolves.toBe(
      failure
    );
    expect(await free.calls()).toHaveLength(1);
  });

  it('reads a lease from flyctl JSON and nothing else', async () => {
    const until = Math.ceil(Date.now() / 1000) + 120;
    const held = await fakeFly(until);
    const options = { executable: held.executable, env: {}, timeoutMs: 10_000 };
    await expect(readFlyMachineLease(options, APP, MACHINE)).resolves.toEqual({
      expiresAtMs: until * 1000,
    });
    const free = await fakeFly(null);
    await expect(
      readFlyMachineLease({ ...options, executable: free.executable }, APP, MACHINE)
    ).resolves.toBeNull();
  });
});

/** A clock that moves only when the wait sleeps. */
function clockedWait(leases: (now: number) => FlyMachineLease | Error, limitMs?: number) {
  let now = 1_000_000;
  const lines: string[] = [];
  const sleeps: number[] = [];
  const run = waitForFlyMachineLeases({
    appName: APP,
    machineIds: [MACHINE],
    readLease: async () => {
      const lease = leases(now);
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
      `Fly is still finishing the deploy that was stopped on ${APP}. Waiting up to about 4 minutes for it to let go of the Machine…`
    );
    expect(wait.lines).toContain('Still waiting for Fly to let go of the Machine…');
    expect(wait.lines.at(-1)).toBe('Fly has let go of the Machine. Deploying now…');
    expect(wait.elapsed()).toBeGreaterThanOrEqual(3.5 * 60_000);
    expect(wait.elapsed()).toBeLessThan(FLY_LEASE_WAIT_LIMIT_MS);
  });

  it('stops at once, with a time to retry, for a lease that ends after the limit', async () => {
    const wait = clockedWait(() => ({ expiresAtMs: 1_000_000 + 20 * 60_000 }));
    await expect(wait.run).rejects.toThrow(
      `Fly is still finishing an earlier deploy of ${APP}, so setup did not deploy over it. Wait about 20 minutes, then run the resume command above again.`
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

  it('deploys as before when the lease cannot be read, but never swallows a cancellation', async () => {
    const unreadable = clockedWait(() => new ProviderCommandError('EXIT'));
    await unreadable.run;
    expect(unreadable.lines).toEqual([]);

    const cancelled = clockedWait(() => new ProviderCommandError('CANCELLED'));
    await expect(cancelled.run).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

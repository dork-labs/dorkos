/** @vitest-environment node */
import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommunityLiveGateError } from '../../../../scripts/community-deploy-live-capture.js';
import {
  describeCommunityLiveGateFailure,
  describeLauncherStop,
  explainCommunityLiveGateFailure,
  PUBLISHED_LAUNCHER_STEP,
} from '../../../../scripts/community-deploy-live-failure.js';
import type { CompatibleCommunityRelease } from '../release-resolver.js';
import { fakeFlyGraphql, writeFakeLaunchTools } from './fake-launch-tools.js';

// The prompts need a real terminal; every service answer comes from the fakes.
vi.mock('../consent.js', () => ({
  requireCommunityLaunchConsent: vi.fn(async () => undefined),
  requireTigrisTermsAcceptance: vi.fn(async () => undefined),
}));
vi.mock('../runtime/default-owner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/default-owner.js')>()),
  assertOwnerHandoffPrerequisites: vi.fn(async () => undefined),
  confirmOwnerClipboardWrite: vi.fn(async () => undefined),
}));
// The registry is not faked; the deploy step is what these tests reach.
vi.mock('../runtime/default-deploy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/default-deploy.js')>()),
  resolveCommunityPlatformDigest: vi.fn(async () => `sha256:${'f'.repeat(64)}`),
}));

const { runCommunityDispatcher } = await import('../community-dispatcher.js');

const APP = 'dorkos-community-test';
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/**
 * The shared fakes, with `fly deploy` and the runtime reads it needs layered on top. `fail` makes
 * the deploy exit 1, as flyctl does when it cannot take a Machine lease; `hang` makes it wait
 * until setup stops it, after touching `deploying`.
 */
async function launchHarness(deploy: 'fail' | 'hang') {
  const bin = await temporary('dorkos-community-stop-bin-');
  const dorkHome = await temporary('dorkos-community-stop-home-');
  const statePath = join(bin, 'state.json');
  await writeFakeLaunchTools(bin, join(bin, 'seen.jsonl'), statePath, {});
  await rename(join(bin, 'fly'), join(bin, 'fly-base'));
  const deploying = join(bin, 'deploying');
  await writeFile(
    join(bin, 'fly'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const reply = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
if (args[0] === 'machine' && args[1] === 'list') reply([]);
if (args[0] === 'machine' && args[1] === 'leases') reply({});
if (args[0] === 'releases') reply([]);
if (args[0] === 'ips') reply([]);
if (args[0] === 'deploy') {
  if (${JSON.stringify(deploy)} === 'fail') {
    process.stderr.write('Error: failed to acquire leases');
    process.exit(1);
  }
  fs.writeFileSync(${JSON.stringify(deploying)}, '');
  setTimeout(() => process.exit(0), 60000);
} else {
  const result = spawnSync(${JSON.stringify(join(bin, 'fly-base'))}, args, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
}
`
  );
  await chmod(join(bin, 'fly'), 0o755);
  // The shared fakes have no direct connection string; give the one Neon would.
  await rename(join(bin, 'neonctl'), join(bin, 'neonctl-base'));
  await writeFile(
    join(bin, 'neonctl'),
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'connection-string') {
  const role = args[args.indexOf('--role-name') + 1];
  process.stdout.write('postgresql://' + role + ':fixture@ep-fixture.aws-us-east-2.aws.neon.tech/community?sslmode=require&channel_binding=require');
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(join(bin, 'neonctl-base'))}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`
  );
  await chmod(join(bin, 'neonctl'), 0o755);
  vi.stubGlobal('fetch', fakeFlyGraphql(statePath, APP).fetch);

  const run = async (during?: () => Promise<void>) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let failure: Error | null = null;
    let exitCode: number | null = null;
    try {
      const launched = runCommunityDispatcher(
        [
          'deploy',
          '--version',
          '0.76.0',
          '--fly-org',
          'dork-labs',
          '--fly-region',
          'ord',
          '--neon-org',
          'org-dorian',
          '--neon-region',
          'aws-us-east-2',
          '--app-name',
          APP,
        ],
        {
          cliVersion: '0.76.0',
          dorkHome,
          processEnv: { PATH: bin },
          parseRelease: (bytes) =>
            JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
        }
      );
      await during?.();
      exitCode = await launched;
    } catch (error) {
      failure = error as Error;
    }
    const printed = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([value]) => String(value))
      .join('');
    stdout.mockRestore();
    stderr.mockRestore();
    return { printed, failure, exitCode };
  };

  const journal = async () => {
    const directory = join(dorkHome, 'launches', 'community');
    const [name] = (await readdir(directory)).filter((file) => file.endsWith('.json'));
    return JSON.parse(await readFile(join(directory, name!), 'utf8')) as Record<string, unknown>;
  };

  /** Send setup a signal the way the process would, once the fake deploy is running. */
  const signalDuringDeploy = (signal: 'SIGINT' | 'SIGTERM') => {
    const before = new Set(process.listeners(signal));
    return async () => {
      for (let tries = 0; tries < 600; tries += 1) {
        if (await stat(deploying).catch(() => null)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Only setup's own listener: the test runner's are not touched.
      for (const listener of process.listeners(signal)) {
        if (!before.has(listener)) (listener as (name: string) => void)(signal);
      }
    };
  };

  return { run, journal, signalDuringDeploy };
}

describe('a launch that stops at the deploy (DOR-2702)', () => {
  it('saves the failed deploy in the journal, so the live gate can name its code', async () => {
    const launch = await launchHarness('fail');
    const { printed, failure } = await launch.run();

    // The person reads plain words; the code is not on the terminal.
    expect(failure?.message).toContain('did not finish cleanly');
    expect(`${printed}\n${failure?.message}`).not.toMatch(/\(CREATION_OUTCOME_UNCERTAIN\)/u);
    const saved = await launch.journal();
    expect(saved.lastSafeError).toEqual({
      category: 'uncertain',
      code: 'CREATION_OUTCOME_UNCERTAIN',
    });
    expect(saved.state).toBe('secrets_staged');

    // The gate reads the journal and names the code in its own failure.
    const explained = await explainCommunityLiveGateFailure(
      new CommunityLiveGateError(PUBLISHED_LAUNCHER_STEP),
      { cleanedUp: false, recoveryCommand: null },
      async () => null,
      async () => describeLauncherStop(saved)
    );
    expect(describeCommunityLiveGateFailure(explained)).toContain(
      'launcher stopped with CREATION_OUTCOME_UNCERTAIN'
    );
  }, 60_000);

  it('ends a Control-C with a plain line that matches the journal, and exits 130', async () => {
    const launch = await launchHarness('hang');
    const { printed, failure, exitCode } = await launch.run(launch.signalDuringDeploy('SIGINT'));
    expect(failure).toBeNull();
    expect(exitCode).toBe(130);
    expect((await launch.journal()).lastSafeError).toEqual({
      category: 'transient',
      code: 'CANCELLED',
    });
    expect(printed).toContain('Space setup stopped.\n');
    expect(printed.trimEnd().split('\n').at(-1)).toBe(
      'Setup was stopped. What it made so far is kept: run the resume command above to carry on.'
    );
    expect(printed).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/u);
  }, 60_000);

  it('exits 143 when stopped with SIGTERM', async () => {
    const launch = await launchHarness('hang');
    const { failure, exitCode } = await launch.run(launch.signalDuringDeploy('SIGTERM'));
    expect(failure).toBeNull();
    expect(exitCode).toBe(143);
  }, 60_000);
});

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompatibleCommunityRelease } from '../release-resolver.js';
import { createInitialCommunityLaunchJournal } from '../resume.js';
import { initializeLaunchJournal, launchJournalPath } from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import { fakeFlyGraphql, writeFakeLaunchTools } from './fake-launch-tools.js';

// The prompts need a real terminal; everything a credential could travel through stays real.
vi.mock('../consent.js', () => ({
  requireCommunityLaunchConsent: vi.fn(async () => undefined),
  requireTigrisTermsAcceptance: vi.fn(async () => undefined),
}));
const ownerEnvs: Record<string, string>[] = [];
vi.mock('../runtime/default-owner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/default-owner.js')>()),
  assertOwnerHandoffPrerequisites: vi.fn(async (env: Record<string, string>) => {
    ownerEnvs.push(env);
  }),
  confirmOwnerClipboardWrite: vi.fn(async (env: Record<string, string>) => {
    ownerEnvs.push(env);
  }),
}));

const { runCommunityDispatcher } = await import('../community-dispatcher.js');

const MARK = 'dor2602_launch_sentinel';
const SENTINELS = {
  FLY_ACCESS_TOKEN: `FlyV1 fm2_${MARK}_access`,
  FLY_API_TOKEN: `FlyV1 fm2_${MARK}_api`,
  NEON_API_KEY: `napi_${MARK}_neon`,
};
const CREDENTIAL_NAMES = Object.keys(SENTINELS);
const APP = 'dorkos-community-test';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ownerEnvs.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function readTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8'))
  );
}

describe('exported credentials on a real (fake-service) launch', () => {
  it('reach only fly and neonctl, sign GraphQL, and appear in no output, error or saved file', async () => {
    const bin = await temporary('dorkos-community-launch-bin-');
    const dorkHome = await temporary('dorkos-community-launch-home-');
    const seenPath = join(bin, 'seen.jsonl');
    const statePath = join(bin, 'state.json');
    await writeFakeLaunchTools(bin, seenPath, statePath, SENTINELS);

    const graphql = fakeFlyGraphql(statePath, APP);
    vi.stubGlobal('fetch', graphql.fetch);
    const { authorizations } = graphql;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let failure: unknown = null;
    try {
      await runCommunityDispatcher(
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
          processEnv: { PATH: bin, ...SENTINELS },
          parseRelease: (bytes) =>
            JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
        }
      );
    } catch (error) {
      // The fakes stop at the image deploy; by then the journal and the GraphQL calls exist.
      failure = error;
    }

    const printed = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([value]) => String(value))
      .join('');
    // It got past creation: the bucket was made over GraphQL and the journal was written.
    expect(graphql.tigrisCreated()).toBe(true);
    expect(authorizations.length).toBeGreaterThan(0);
    expect(new Set(authorizations)).toEqual(new Set([SENTINELS.FLY_ACCESS_TOKEN]));
    const saved = await readTree(dorkHome);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.join('\n')).toContain('neon-project-1');

    expect(printed.match(/from your environment/gu)).toHaveLength(1);
    const seen = (await readFile(seenPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { name: string; present: string[]; exact: string[] });
    for (const tool of ['fly', 'neonctl']) {
      const calls = seen.filter(({ name }) => name === tool);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.exact.sort()).toEqual([...CREDENTIAL_NAMES].sort());
    }
    const ghCalls = seen.filter(({ name }) => name === 'gh');
    expect(ghCalls.length).toBeGreaterThan(0);
    for (const call of ghCalls) expect(call.present).toEqual([]);
    // The clipboard and browser-opener checks get the environment without any credential.
    expect(ownerEnvs.length).toBeGreaterThan(0);
    for (const env of ownerEnvs) {
      expect(Object.keys(env).filter((name) => CREDENTIAL_NAMES.includes(name))).toEqual([]);
    }

    const failureText =
      failure instanceof Error ? `${failure.message}\n${failure.stack ?? ''}` : String(failure);
    for (const text of [printed, failureText, ...saved]) expect(text).not.toContain(MARK);
  });

  it('names an exported credential on the removal path too, and prints no value', async () => {
    const dorkHome = await temporary('dorkos-community-removal-home-');
    const runId = '8b2f7c1e-4d3a-4e5f-9a6b-1c2d3e4f5a6b';
    const plan = createLaunchPlan({
      dorkosVersion: '0.76.0',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      fly: {
        organizationId: 'dork-labs',
        organizationName: 'Dork Labs',
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
    await initializeLaunchJournal(
      launchJournalPath(dorkHome, runId),
      createInitialCommunityLaunchJournal(runId, plan, '2026-09-21T00:00:00.000Z')
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      runCommunityDispatcher(['deploy', '--remove-uncertain', runId], {
        cliVersion: '0.76.0',
        dorkHome,
        processEnv: { PATH: '', ...SENTINELS },
        parseRelease: () => {
          throw new Error('unused');
        },
      })
    ).resolves.toBe(0);

    const printed = stdout.mock.calls.map(([value]) => String(value)).join('');
    expect(printed.match(/from your environment/gu)).toHaveLength(1);
    expect(printed).toContain('This run has no unresolved resource.');
    expect(printed).not.toContain(MARK);
  });
});

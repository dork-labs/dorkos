import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompatibleCommunityRelease } from '../release-resolver.js';
import {
  fakeFlyGraphql,
  writeFakeLaunchTools,
  type FakeLaunchBehavior,
} from './fake-launch-tools.js';

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

const { runCommunityDispatcher } = await import('../community-dispatcher.js');

const MARK = 'dor2656_refusal_sentinel';
const APP = 'dorkos-community-test';
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface Run {
  /** Everything printed to stdout and stderr, in order. */
  printed: string;
  /** What the dispatcher threw, or null. */
  failure: Error | null;
  /** The exit code, when it returned. */
  exitCode: number | null;
}

/** A fake bin directory and DorkOS home, and a way to run the dispatcher against them. */
async function harness(behavior: FakeLaunchBehavior, credentials: Record<string, string>) {
  const bin = await temporary('dorkos-community-refusal-bin-');
  const dorkHome = await temporary('dorkos-community-refusal-home-');
  const statePath = join(bin, 'state.json');
  await writeFakeLaunchTools(bin, join(bin, 'seen.jsonl'), statePath, credentials, behavior);
  vi.stubGlobal('fetch', fakeFlyGraphql(statePath, APP).fetch);
  const env = { PATH: bin, ...credentials };

  const run = async (args: string[]): Promise<Run> => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let failure: Error | null = null;
    let exitCode: number | null = null;
    let printed: string;
    try {
      exitCode = await runCommunityDispatcher(['deploy', ...args], {
        cliVersion: '0.76.0',
        dorkHome,
        processEnv: env,
        parseRelease: (bytes) =>
          JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
      });
    } catch (error) {
      failure = error as Error;
    } finally {
      printed = [...stdout.mock.calls, ...stderr.mock.calls]
        .map(([value]) => String(value))
        .join('');
      stdout.mockRestore();
      stderr.mockRestore();
    }
    return { printed, failure, exitCode };
  };

  const launch = () =>
    run([
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
    ]);

  const journals = async (): Promise<Array<Record<string, unknown>>> => {
    const directory = join(dorkHome, 'launches', 'community');
    const names = await readdir(directory).catch(() => [] as string[]);
    return Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')))
    );
  };

  const state = async () =>
    JSON.parse(await readFile(statePath, 'utf8')) as {
      flyApp: unknown;
      neonProject: unknown;
    };

  return { run, launch, journals, state };
}

describe('a create the service refuses (DOR-2656)', () => {
  // Catches the refusal being reported as an unknown outcome: the L3 run printed
  // "Journal state: uncertain", a --resume command that could never work, and a run that
  // --list-incomplete kept listing.
  it('says the Fly token cannot create apps, offers no resume, and leaves no run behind', async () => {
    const { launch, run, journals, state } = await harness(
      { flyCreate: 'refuse' },
      { FLY_API_TOKEN: `FlyV1 fm2_${MARK}_readonly` }
    );

    const result = await launch();

    expect(result.failure?.message).toBe(
      `Fly refused to create app ${APP} in organization dork-labs. ` +
        "The Fly token in FLY_API_TOKEN can't create apps there. " +
        'Use a token or sign-in that can, then run setup again. ' +
        'Nothing was created, so there is nothing to clean up.'
    );
    expect(result.printed).not.toContain('--resume');
    expect(result.printed).not.toContain('uncertain');
    expect(result.printed).not.toContain('Manual reconciliation');
    expect(`${result.printed}\n${result.failure?.message}`).not.toContain(MARK);
    expect((await state()).flyApp).toBeNull();
    expect(await journals()).toEqual([]);

    const listed = await run(['--list-incomplete']);
    expect(listed.printed).toBe('No incomplete Community launches were found.\n');
  });

  // Catches the refusal wording reaching a run that already made something: that run must keep
  // its recovery table and resume command, as L3 (b) and (c) expect.
  it('keeps a run that already made the Fly app, says the Neon key cannot create projects, and offers resume', async () => {
    const { launch, run, journals, state } = await harness(
      { neonCreate: 'refuse' },
      { NEON_API_KEY: `napi_${MARK}_project_scoped` }
    );

    const result = await launch();

    expect(result.failure?.message).toBe(
      `Neon refused to create project ${APP} in organization org-dorian. ` +
        "The Neon key in NEON_API_KEY can't create projects there. " +
        'Use a key or sign-in that can, then resume with the command above.'
    );
    expect(result.printed).toContain(`Fly app ${APP} — owner dork-labs; may incur charges`);
    expect(result.printed).toContain('Journal state: fly_app_created');
    expect(result.printed).toMatch(/Resume with:\n {2}dorkos community deploy --resume /u);
    expect(result.printed).not.toContain('Manual reconciliation');
    expect(`${result.printed}\n${result.failure?.message}`).not.toContain(MARK);
    expect((await state()).neonProject).toBeNull();
    const [journal] = await journals();
    expect(journal).toMatchObject({
      state: 'fly_app_created',
      pendingIntent: null,
      lastSafeError: { category: 'authorization', code: 'ACCESS_DENIED' },
    });

    const listed = await run(['--list-incomplete']);
    expect(listed.printed).toContain(`${String(journal!.runId)}  fly_app_created`);
  });

  // Catches the refusal being taken on its word. flyctl creates the app and then waits for it,
  // and that wait can fail with the same "unauthorized" after the app exists.
  it('adopts the app when Fly says unauthorized after making it', async () => {
    const { launch, journals, state } = await harness({ flyCreate: 'refuse-after-create' }, {});

    const result = await launch();

    expect(result.failure?.message ?? '').not.toContain('refused');
    expect((await state()).flyApp).not.toBeNull();
    const [journal] = await journals();
    expect(journal).toMatchObject({ completedSteps: expect.arrayContaining(['fly_app_created']) });
  });
});

describe('an ambiguous create stays uncertain, and --remove-uncertain can clear it', () => {
  // Catches an over-broad refusal rule: a cut-off answer must never be called a refusal. Then
  // catches DOR-2656's second half: after --remove-uncertain finds nothing, --list-incomplete
  // still listed the run.
  it('keeps a garbled Fly answer uncertain, then clears the run once nothing is found', async () => {
    const { launch, run, journals } = await harness({ flyCreate: 'garble' }, {});

    const result = await launch();

    expect(result.failure?.message).toBe(
      'Community creation outcome requires manual reconciliation (fly)'
    );
    expect(result.printed).toContain('Journal state: uncertain');
    expect(result.printed).toContain('--remove-uncertain');
    const [journal] = await journals();
    expect(journal).toMatchObject({
      state: 'uncertain',
      lastSafeError: { code: 'CREATION_OUTCOME_UNCERTAIN' },
    });
    const runId = String(journal!.runId);
    expect((await run(['--list-incomplete'])).printed).toContain(`${runId}  uncertain`);

    // Straight away the create could still land, so the run is kept.
    const early = await run(['--remove-uncertain', runId]);
    expect(early.exitCode).toBe(0);
    expect(early.printed).toContain('The create probably never landed.');
    expect(early.printed).toContain('DorkOS keeps this run for now');
    expect((await run(['--list-incomplete'])).printed).toContain(`${runId}  uncertain`);

    // Well past the create window, the same command clears it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30 * 60_000);
    const removal = await run(['--remove-uncertain', runId]);
    vi.useRealTimers();
    expect(removal.exitCode).toBe(0);
    expect(removal.printed).toContain('The create probably never landed.');
    expect(removal.printed).toContain('it no longer shows in --list-incomplete');

    expect(await journals()).toEqual([]);
    expect((await run(['--list-incomplete'])).printed).toBe(
      'No incomplete Community launches were found.\n'
    );
  });
});

describe('a preflight read the service refuses (DOR-2657)', () => {
  // Catches the generic "check provider status … neonctl auth" message reaching a person whose
  // exported key just lacks permission, and any echo of the key itself.
  it('says the Neon key in NEON_API_KEY cannot read the organization', async () => {
    const { launch, journals } = await harness(
      { neonOrgs: 'refuse' },
      { NEON_API_KEY: `napi_${MARK}_project_scoped` }
    );

    const result = await launch();

    expect(result.failure?.message).toBe(
      "The Neon key in NEON_API_KEY can't read organization org-dorian. " +
        'Setup needs a key or sign-in that can create projects in it.'
    );
    expect(`${result.printed}\n${result.failure?.message}`).not.toContain(MARK);
    expect(await journals()).toEqual([]);
  });

  it('says the Fly token in FLY_API_TOKEN cannot read the organization', async () => {
    const { launch, journals } = await harness(
      { flyOrgs: 'refuse' },
      { FLY_API_TOKEN: `FlyV1 fm2_${MARK}_other_org` }
    );

    const result = await launch();

    expect(result.failure?.message).toBe(
      "The Fly token in FLY_API_TOKEN can't read organization dork-labs. " +
        'It may have expired, or it may not have access there. ' +
        'Setup needs a token or sign-in that can create apps in it.'
    );
    expect(`${result.printed}\n${result.failure?.message}`).not.toContain(MARK);
    expect(await journals()).toEqual([]);
  });
});

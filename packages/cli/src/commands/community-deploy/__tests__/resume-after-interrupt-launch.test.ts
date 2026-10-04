/**
 * DOR-2701, end to end through the dispatcher against fake `fly`/`neonctl`/`gh` and a fake Fly
 * GraphQL endpoint: the L3 run that stopped right after it saved the Neon create intent, once the
 * Fly app already existed.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompatibleCommunityRelease } from '../release-resolver.js';
import { fakeFlyGraphql, writeFakeLaunchTools } from './fake-launch-tools.js';

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
const consent = await import('../consent.js');

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

interface FakeState {
  flyApp: { ID: string } | null;
  neonProject: { id: string } | null;
  [key: string]: unknown;
}

async function harness() {
  const bin = await temporary('dorkos-community-resume-bin-');
  const dorkHome = await temporary('dorkos-community-resume-home-');
  const statePath = join(bin, 'state.json');
  await writeFakeLaunchTools(
    bin,
    join(bin, 'seen.jsonl'),
    statePath,
    {},
    {
      neonCreate: 'lost-once',
    }
  );
  vi.stubGlobal('fetch', fakeFlyGraphql(statePath, APP).fetch);

  const run = async (args: string[]) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let failure: Error | null = null;
    let exitCode: number | null = null;
    try {
      exitCode = await runCommunityDispatcher(['deploy', ...args], {
        cliVersion: '0.76.0',
        dorkHome,
        processEnv: { PATH: bin },
        parseRelease: (bytes) =>
          JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
      });
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

  const journals = async (): Promise<Array<Record<string, unknown>>> => {
    const directory = join(dorkHome, 'launches', 'community');
    const names = await readdir(directory).catch(() => [] as string[]);
    return Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')))
    );
  };
  const state = async () => JSON.parse(await readFile(statePath, 'utf8')) as FakeState;
  const setState = async (update: Partial<FakeState>) =>
    writeFile(statePath, JSON.stringify({ ...(await state()), ...update }));

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

  /** Run a command later than now, past the create window and its ten-minute margin. */
  const later = async (args: string[]) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 30 * 60_000);
    try {
      return await run(args);
    } finally {
      vi.useRealTimers();
    }
  };

  return { run, launch, later, journals, state, setState };
}

/** The arguments of the one command printed after `label`, without `dorkos community deploy`. */
function printedCommand(printed: string, label: string): string[] {
  const line = printed.split('\n').find((entry) => entry.startsWith(label));
  if (!line) throw new Error(`No "${label}" line in:\n${printed}`);
  return line.slice(label.length).trim().split(' ').slice(3);
}

describe('a run stopped right after it saved the Neon create intent (DOR-2701)', () => {
  it('is never offered a resume that loops, and continues once the create provably never landed', async () => {
    const { run, launch, later, journals, state } = await harness();

    const stopped = await launch();
    expect(stopped.failure?.message).toContain('(neon)');
    const [journal] = await journals();
    expect(journal).toMatchObject({
      state: 'uncertain',
      pendingIntent: { provider: 'neon' },
      resources: { flyAppId: APP },
      completedSteps: ['planned', 'fly_app_created'],
    });
    const runId = String(journal!.runId);
    // The L3 table printed "Resume with:" here, and that command looped for good.
    expect(stopped.printed).not.toContain('Resume with:');
    expect(stopped.printed).toContain(
      `Next: check whether that create landed with:\n  dorkos community deploy --remove-uncertain ${runId}`
    );

    // A resume typed anyway says what moves the run forward, before asking for consent again.
    const consentCalls = vi.mocked(consent.requireCommunityLaunchConsent).mock.calls.length;
    const resumed = await run(['--resume', runId]);
    expect(resumed.failure?.message).toContain(
      `Check it first, and the run can continue: dorkos community deploy --remove-uncertain ${runId}`
    );
    expect(vi.mocked(consent.requireCommunityLaunchConsent).mock.calls.length).toBe(consentCalls);

    // Straight away the create could still land, so nothing changes.
    const early = await run(['--remove-uncertain', runId]);
    expect(early.printed).toContain('could still appear, so nothing was changed');
    expect(early.printed).toContain('the run can continue from where it stopped');
    expect((await journals())[0]).toEqual(journal);

    // Past the window, the intent is released and the Fly app is kept.
    const released = await later(['--remove-uncertain', runId]);
    expect(released.exitCode).toBe(0);
    expect(released.printed).toContain(
      `This run keeps what it already made (Fly app ${APP}) and can continue from where it stopped.`
    );
    expect((await journals())[0]).toMatchObject({
      state: 'fly_app_created',
      pendingIntent: null,
      lastSafeError: null,
      resources: { flyAppId: APP },
      completedSteps: ['planned', 'fly_app_created'],
    });

    // The printed command is the one that works: it makes the Neon project and keeps the app.
    const appBefore = (await state()).flyApp;
    // It goes on past Tigris to the deploy, where these fakes stop.
    await run(printedCommand(released.printed, 'Continue with:'));
    expect((await state()).neonProject).not.toBeNull();
    expect((await state()).flyApp).toEqual(appBefore);
    const [after] = await journals();
    expect(after).toMatchObject({
      runId,
      resources: { flyAppId: APP, neonProjectId: 'neon-project-1' },
    });
    expect(after!.completedSteps).toEqual(
      expect.arrayContaining([
        'planned',
        'fly_app_created',
        'neon_project_created',
        'bucket_created',
      ])
    );
    // Six whole dispatcher runs against subprocess fakes.
  }, 60_000);

  it('can be forgotten once the Fly app is removed by hand, and not before', async () => {
    const { run, launch, later, journals, setState } = await harness();
    await launch();
    const runId = String((await journals())[0]!.runId);

    // The app is still there: the run stays, and the message names it and how to remove it.
    const kept = await later(['--forget', runId]);
    expect(kept.exitCode).toBe(1);
    expect(kept.printed).toContain('They may incur charges until you remove them:');
    expect(kept.printed).toContain(`Fly app ${APP}, in Fly organization dork-labs`);
    expect(kept.printed).toContain(`Remove: fly apps destroy ${APP}`);
    expect(await journals()).toHaveLength(1);

    // After `fly apps destroy`, it is retired and leaves --list-incomplete.
    await setState({ flyApp: null });
    const forgotten = await later(['--forget', runId]);
    expect(forgotten.exitCode).toBe(0);
    expect(forgotten.printed).toContain('it no longer shows in --list-incomplete');
    expect(await journals()).toEqual([]);
    expect((await run(['--list-incomplete'])).printed).toBe(
      'No incomplete space server launches were found.\n'
    );
  }, 60_000);
});

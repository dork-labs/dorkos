/**
 * DOR-2701: a run stopped right after it saved a create intent, at each create step, against an
 * in-memory Fly, Neon and Tigris. The create never reaches the service, as when Control-C lands
 * between "intent saved" and the request. Before this fix, a run that had made anything earlier
 * could never be resumed, and `--remove-uncertain` left it stuck.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityCreationUncertainError,
  executeCommunityCreationPhase,
  type CommunityCreationDependencies,
} from '../execute.js';
import {
  deleteLaunchJournal,
  initializeLaunchJournal,
  launchJournalPath,
  readLaunchJournal,
  writeLaunchJournal,
  type LaunchJournal,
} from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import { createInitialCommunityLaunchJournal } from '../resume.js';
import {
  runUncertainRemoval,
  type PendingIntent,
  type ProbeResult,
  type RemovalProvider,
  type UncertainResourceProbe,
} from '../provenance/uncertain-removal.js';
import { formatRemovalOutcome } from '../provenance/removal-output.js';
import { runForgetLaunch, type LaunchResourceChecks } from '../provenance/forget-launch.js';
import { formatForgetOutcome } from '../provenance/forget-command.js';

const RUN_ID = '802d9149-bbad-4f9e-a949-2058b5e836c4';
const NAME = 'dor2701-app';
const STARTED = '2026-10-03T23:10:23.824Z';
/** Past the create window and its ten-minute margin (DOR-2656's bar). */
const LATER = '2026-10-03T23:45:00.000Z';
/** Inside the create window: a cut-off create could still land. */
const SOON = '2026-10-03T23:11:35.000Z';

const plan = createLaunchPlan({
  dorkosVersion: '0.96.0',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  fly: {
    organizationId: 'personal',
    organizationName: 'Personal',
    appName: NAME,
    region: 'ord',
    machineSize: 'shared-cpu-1x',
  },
  neon: {
    organizationId: 'org-old-resonance',
    organizationName: 'Old Resonance',
    projectName: NAME,
    region: 'aws-us-east-2',
  },
  tigris: { bucketName: NAME, private: true },
});

const STEPS = ['fly', 'neon', 'tigris'] as const;
const DONE = { fly: 'fly_app_created', neon: 'neon_project_created', tigris: 'bucket_created' };

let root: string;
let journalPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dorkos-resume-after-interrupt-'));
  journalPath = launchJournalPath(root, RUN_ID);
  await initializeLaunchJournal(
    journalPath,
    createInitialCommunityLaunchJournal(RUN_ID, plan, STARTED)
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = async () => (await readLaunchJournal(journalPath))!;

/** Fly, Neon and Tigris as plain records. `interrupt` names the one create that never lands. */
function services(interrupt?: RemovalProvider) {
  const world: { fly: string | null; neon: string | null; tigris: string | null } = {
    fly: null,
    neon: null,
    tigris: null,
  };
  let flyNetwork: string | null = null;
  let interrupted = false;
  const ids = { fly: NAME, neon: 'project-1', tigris: 'addon-1' };
  const orgs = { fly: 'personal', neon: 'org-old-resonance', tigris: 'personal' };
  const identity = (service: RemovalProvider) => ({
    id: ids[service],
    organizationId: orgs[service],
    name: NAME,
    ...(service === 'tigris' ? { bindingId: NAME } : {}),
    ...(service === 'neon'
      ? {
          relatedResources: {
            neonBranchId: 'branch-1',
            neonDatabaseId: 'database-1',
            neonRoleId: 'role-1',
            neonEndpointId: 'endpoint-1',
          },
        }
      : {}),
    ...(service === 'fly' && flyNetwork ? { provenance: { flyNetwork } } : {}),
  });
  const boundary = (service: RemovalProvider) => ({
    create: vi.fn(async (marker: string) => {
      if (service === interrupt && !interrupted) {
        // The intent is saved; the request never went out.
        interrupted = true;
        throw new Error('cancelled');
      }
      world[service] = ids[service];
      if (service === 'fly') flyNetwork = `dorkos-${marker}`;
      return identity(service);
    }),
    inspect: vi.fn(async () => {
      if (!world[service]) throw new Error('missing');
      return identity(service);
    }),
  });
  const fly = boundary('fly');
  const neon = boundary('neon');
  const tigris = boundary('tigris');
  const creation: CommunityCreationDependencies = {
    persist: (next, expected) => writeLaunchJournal(journalPath, next, expected),
    fly,
    neon,
    tigris,
    now: () => STARTED,
  };
  /** The removal probe: absent only when nothing with the name exists. */
  const probe = (found?: () => ProbeResult): UncertainResourceProbe => ({
    find: vi.fn(async (intent: PendingIntent): Promise<ProbeResult> =>
      found ? found() : world[intent.provider] ? unprovedFind(intent.provider) : { kind: 'absent' }
    ),
    remove: vi.fn(async () => undefined),
    isGone: vi.fn(async () => true),
  });
  const checks: LaunchResourceChecks = {
    flyAppGone: async () => world.fly === null,
    neonProjectGone: async () => world.neon === null,
    tigrisBucketGone: async () => world.tigris === null,
    intendedCreateAbsent: async (intent) => world[intent.provider] === null,
  };
  return { world, creation, fly, neon, tigris, probe, checks };
}

/** Something with the run's name that does not carry its marker. */
function unprovedFind(provider: RemovalProvider): ProbeResult {
  if (provider === 'fly') {
    return {
      kind: 'fly',
      app: {
        token: '4817203',
        name: NAME,
        organization: 'personal',
        network: `dorkos-${'0'.repeat(32)}`,
        createdAt: '2026-10-03T23:10:24Z',
        machines: 0,
        volumes: 0,
        ipAddresses: 0,
        certificates: 0,
        secretNames: [],
      },
    };
  }
  if (provider === 'neon') {
    return {
      kind: 'neon',
      projects: [
        {
          token: 'project-9',
          name: NAME,
          organization: 'org-old-resonance',
          region: 'aws-us-east-2',
          createdAt: '2026-10-03T23:10:24Z',
          branchCount: 1,
          defaultBranchCount: 1,
          roles: [`community_${'0'.repeat(32)}`],
          databases: ['community'],
        },
      ],
    };
  }
  return {
    kind: 'tigris',
    facts: {
      app: { name: NAME, organization: 'personal', network: 'dorkos-elsewhere' },
      totalCount: 1,
      addOns: [{ token: 'addon-9', name: NAME, organization: 'personal', createdAt: STARTED }],
    },
  };
}

function removal(probe: UncertainResourceProbe, now: string) {
  return runUncertainRemoval({
    readJournal: () => readLaunchJournal(journalPath),
    persist: (next, expected) => writeLaunchJournal(journalPath, next, expected),
    discard: (expected) => deleteLaunchJournal(journalPath, expected),
    probeFor: () => probe,
    confirm: async () => ({ kind: 'declined' }),
    now: () => now,
    sleep: async () => undefined,
    gate: { fly: true, neon: true },
  });
}

/** Run the creation phase until the interrupted step stops it, and return that journal. */
async function interruptAt(service: RemovalProvider) {
  const world = services(service);
  await expect(executeCommunityCreationPhase(plan, await read(), world.creation)).rejects.toEqual(
    new CommunityCreationUncertainError(service)
  );
  return world;
}

describe('a run stopped right after it saved a create intent (DOR-2701)', () => {
  it.each(STEPS)(
    'continues from the %s step once that create provably never landed, keeping every earlier resource',
    async (service) => {
      const world = await interruptAt(service);
      const stopped = await read();
      const earlier = STEPS.slice(0, STEPS.indexOf(service));
      expect(stopped).toMatchObject({
        state: 'uncertain',
        pendingIntent: { provider: service },
        completedSteps: ['planned', ...earlier.map((step) => DONE[step])],
        lastSafeError: { code: 'CREATION_OUTCOME_UNCERTAIN' },
      });
      const earlierResources = { ...stopped.resources };
      expect(Object.keys(earlierResources)).toEqual(
        expect.arrayContaining(
          earlier.map(
            (step) => ({ fly: 'flyAppId', neon: 'neonProjectId', tigris: 'tigrisBucketId' })[step]
          )
        )
      );

      // A resume still refuses on its own: only the proof below may release the intent.
      await expect(
        executeCommunityCreationPhase(plan, stopped, world.creation)
      ).rejects.toBeInstanceOf(CommunityCreationUncertainError);

      const outcome = await removal(world.probe(), LATER);
      if (earlier.length === 0) {
        // Nothing else was made, so the run is cleared and a fresh launch starts over (DOR-2656).
        expect(outcome).toEqual({ outcome: 'absent', provider: 'fly', cleared: true });
        expect(await readLaunchJournal(journalPath)).toBeNull();
        return;
      }
      expect(outcome).toEqual({
        outcome: 'absent',
        provider: service,
        cleared: false,
        released: true,
      });
      const released = await read();
      expect(released).toMatchObject({
        state: DONE[earlier.at(-1)!],
        pendingIntent: null,
        lastSafeError: null,
        resources: earlierResources,
        completedSteps: stopped.completedSteps,
      });

      const finished = await executeCommunityCreationPhase(plan, released, world.creation);
      expect(finished.completedSteps).toEqual([
        'planned',
        'fly_app_created',
        'neon_project_created',
        'bucket_created',
      ]);
      expect(finished.resources).toMatchObject(earlierResources);
      expect(finished.pendingIntent).toBeNull();
      // Every earlier create ran once, in the first launch; the interrupted one ran again.
      for (const step of earlier) expect(world[step].create).toHaveBeenCalledOnce();
      expect(world[service].create).toHaveBeenCalledTimes(2);
      expect(world.world).toEqual({ fly: NAME, neon: 'project-1', tigris: 'addon-1' });
    }
  );

  it.each(STEPS)(
    'refuses to release the %s intent when the create is not provably absent',
    async (service) => {
      const world = await interruptAt(service);
      const stopped = await read();
      const outcomes = [
        // Something with the name exists and does not carry this run's marker.
        await removal(
          world.probe(() => unprovedFind(service)),
          LATER
        ),
        // A failed read is never taken for "absent".
        await removal(
          world.probe(() => {
            throw new Error('server error');
          }),
          LATER
        ),
        // Absent, but too recently to rule out a late landing.
        await removal(world.probe(), SOON),
      ];
      expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
        'unproved',
        'unreachable',
        'absent',
      ]);
      expect(outcomes[2]).toMatchObject({ cleared: false, clearableAfter: expect.any(String) });
      expect(outcomes[2]).not.toHaveProperty('released');
      expect(await read()).toEqual(stopped);
      await expect(
        executeCommunityCreationPhase(plan, stopped, world.creation)
      ).rejects.toBeInstanceOf(CommunityCreationUncertainError);
      expect(world[service].create).toHaveBeenCalledOnce();

      // When it cannot finish, it names everything the run made, where, and how to remove it.
      const text = formatRemovalOutcome(outcomes[0]!, {
        runId: RUN_ID,
        journal: stopped,
        resumeCommand: null,
        recovery: '',
      }).text;
      if (service !== 'fly') {
        expect(text).toContain('They may incur charges until you remove them:');
        expect(text).toContain(`Fly app ${NAME}, in Fly organization personal`);
        expect(text).toContain(`Remove: fly apps destroy ${NAME}`);
        expect(text).toContain(`dorkos community deploy --forget ${RUN_ID}`);
      }
      if (service === 'tigris') {
        expect(text).toContain(
          `Neon project ${NAME} (project id project-1), in Neon organization org-old-resonance`
        );
        expect(text).toContain('Remove: neonctl projects delete project-1');
      }
    }
  );
});

describe('--forget retires a run only when everything it made is gone', () => {
  it('keeps the run, naming what is left, until the person removes it, then forgets it', async () => {
    const world = await interruptAt('tigris');
    const deps = (now: string) => ({
      readJournal: () => readLaunchJournal(journalPath),
      discard: (expected: number) => deleteLaunchJournal(journalPath, expected),
      checks: world.checks,
      now: () => now,
    });

    const kept = await runForgetLaunch(deps(LATER));
    expect(kept).toMatchObject({
      outcome: 'still-there',
      remaining: [
        { provider: 'fly', name: NAME, organization: 'personal', status: 'present' },
        { provider: 'neon', id: 'project-1', organization: 'org-old-resonance' },
      ],
    });
    const text = formatForgetOutcome(kept, RUN_ID).text;
    expect(text).toContain('They may incur charges until you remove them:');
    expect(text).toContain(`Remove: fly apps destroy ${NAME}`);
    expect(text).toContain('Remove: neonctl projects delete project-1');
    expect(await readLaunchJournal(journalPath)).not.toBeNull();

    world.world.fly = null;
    world.world.neon = null;
    // Even with both gone, a create sent moments ago could still land.
    expect(await runForgetLaunch(deps(SOON))).toMatchObject({ outcome: 'wait' });
    expect(await readLaunchJournal(journalPath)).not.toBeNull();

    expect(await runForgetLaunch(deps(LATER))).toMatchObject({ outcome: 'forgotten' });
    expect(await readLaunchJournal(journalPath)).toBeNull();
  });

  it('never forgets a run whose resources cannot be read, or whose create may have landed', async () => {
    const world = await interruptAt('neon');
    const deps = (checks: Partial<LaunchResourceChecks>) => ({
      readJournal: () => readLaunchJournal(journalPath),
      discard: (expected: number) => deleteLaunchJournal(journalPath, expected),
      checks: { ...world.checks, ...checks },
      now: () => LATER,
    });
    world.world.fly = null;
    await expect(
      runForgetLaunch(
        deps({
          flyAppGone: async () => {
            throw new Error('unreadable');
          },
        })
      )
    ).resolves.toMatchObject({ outcome: 'still-there', remaining: [{ status: 'unreadable' }] });
    await expect(
      runForgetLaunch(deps({ intendedCreateAbsent: async () => false }))
    ).resolves.toEqual({ outcome: 'pending-create', provider: 'neon', status: 'present' });
    expect(await readLaunchJournal(journalPath)).not.toBeNull();
  });

  it('leaves a removal in progress and a finished launch alone', async () => {
    const current = await read();
    const removing: LaunchJournal = {
      ...current,
      revision: current.revision + 1,
      pendingRemoval: {
        provider: 'fly',
        token: '4817203',
        resourceName: NAME,
        proof: 'marker',
        requestedAt: STARTED,
      },
    };
    await writeLaunchJournal(journalPath, removing, current.revision);
    const deps = {
      readJournal: () => readLaunchJournal(journalPath),
      discard: (expected: number) => deleteLaunchJournal(journalPath, expected),
      checks: services().checks,
      now: () => LATER,
    };
    await expect(runForgetLaunch(deps)).resolves.toEqual({ outcome: 'removal-pending' });
    await writeLaunchJournal(
      journalPath,
      { ...removing, revision: removing.revision + 1, pendingRemoval: null, state: 'complete' },
      removing.revision
    );
    await expect(runForgetLaunch(deps)).resolves.toEqual({ outcome: 'complete' });
    expect(await readLaunchJournal(journalPath)).not.toBeNull();
  });
});

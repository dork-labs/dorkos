/**
 * Shared run, journal and in-memory Fly, Neon and Tigris for the DOR-2701 tests: a run stopped
 * right after it saved a create intent. Importing this registers a fresh journal for each test.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
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
import type { LaunchResourceChecks } from '../provenance/forget-launch.js';

export const RUN_ID = '802d9149-bbad-4f9e-a949-2058b5e836c4';
export const NAME = 'dor2701-app';
export const STARTED = '2026-10-03T23:10:23.824Z';
/** Past the create window and its ten-minute margin (DOR-2656's bar). */
export const LATER = '2026-10-03T23:45:00.000Z';
/** Inside the create window: a cut-off create could still land. */
export const SOON = '2026-10-03T23:11:35.000Z';

export const plan = createLaunchPlan({
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

export const STEPS = ['fly', 'neon', 'tigris'] as const;
export const DONE = {
  fly: 'fly_app_created',
  neon: 'neon_project_created',
  tigris: 'bucket_created',
};

let root: string;
let journalPath: string;

/** The run's journal file for the current test. */
export const journalFile = () => journalPath;

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

export const read = async () => (await readLaunchJournal(journalPath))!;

/** Fly, Neon and Tigris as plain records. `interrupt` names the one create that never lands. */
export function services(interrupt?: RemovalProvider) {
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
  // What `--forget` reads for the unresolved create: nothing by default.
  const intended = { found: { kind: 'absent' } as ProbeResult, nameHeld: false };
  const checks: LaunchResourceChecks = {
    flyAppGone: async () => world.fly === null,
    neonProjectGone: async () => world.neon === null,
    tigrisBucketGone: async () => world.tigris === null,
    findIntended: async () => intended.found,
    tigrisNameHeld: async () => intended.nameHeld,
  };
  return { world, creation, fly, neon, tigris, probe, checks, intended };
}

/** Something with the run's name that does not carry its marker. */
export function unprovedFind(provider: RemovalProvider): ProbeResult {
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

/** Run `--remove-uncertain` on the test's journal at `now`, declining any removal offer. */
export function removal(probe: UncertainResourceProbe, now: string) {
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
export async function interruptAt(service: RemovalProvider) {
  const world = services(service);
  await expect(executeCommunityCreationPhase(plan, await read(), world.creation)).rejects.toEqual(
    new CommunityCreationUncertainError(service)
  );
  return world;
}

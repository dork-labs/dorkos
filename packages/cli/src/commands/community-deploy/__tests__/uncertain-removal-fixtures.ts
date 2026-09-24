/** Shared shape-A journals and service facts for the uncertain-removal tests. */
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import type {
  FlyAppFacts,
  NeonProjectFacts,
  PendingIntent,
  ProbeResult,
  TigrisFacts,
} from '../provenance/uncertain-verdict.js';

export const RUN_ID = '3f2c9a1e-1111-4111-8111-111111111111';
export const MARKER = '7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a';
export const OTHER_MARKER = '0'.repeat(32);
export const NETWORK = `dorkos-${MARKER}`;
export const APP_NETWORK = `dorkos-${'a'.repeat(32)}`;
export const ROLE = `community_${MARKER}`;
export const REQUESTED_AT = '2026-09-23T10:31:03.000Z';
export const CREATED_AT = '2026-09-23T10:31:07Z';
export const OPEN = { fly: true, neon: true };

export const context = {
  version: '0.82.0',
  flyOrganization: 'acme',
  flyRegion: 'ord',
  appName: 'community-acme',
  machineSize: 'shared-cpu-1x',
  neonOrganization: 'org-acme',
  neonRegion: 'aws-us-east-2',
  neonProjectName: 'community-acme',
  bucketName: 'community-acme',
};

/** A creation intent carrying this run's marker and request time. */
export function intentFor(
  provider: PendingIntent['provider'],
  update: Partial<PendingIntent> = {}
) {
  return {
    provider,
    organizationId: provider === 'neon' ? 'org-acme' : 'acme',
    resourceName: 'community-acme',
    provenanceMarker: MARKER,
    requestedAt: REQUESTED_AT,
    ...update,
  };
}

/** A shape-A journal: the create's intent is recorded and its id is not. */
export function shapeA(
  provider: PendingIntent['provider'],
  update: Partial<LaunchJournal> = {}
): LaunchJournal {
  const earlier: Pick<LaunchJournal, 'resources' | 'completedSteps' | 'provenance'> =
    provider === 'fly'
      ? { resources: {}, completedSteps: ['planned'] }
      : provider === 'neon'
        ? {
            resources: { flyAppId: 'community-acme' },
            completedSteps: ['planned', 'fly_app_created'],
            provenance: { flyNetwork: APP_NETWORK },
          }
        : {
            resources: {
              flyAppId: 'community-acme',
              neonProjectId: 'project-1',
              neonRoleId: ROLE,
            },
            completedSteps: ['planned', 'fly_app_created', 'neon_project_created'],
            provenance: { flyNetwork: APP_NETWORK },
          };
  return LaunchJournalSchema.parse({
    schemaVersion: 1,
    runId: RUN_ID,
    revision: 0,
    planHash: 'b'.repeat(64),
    releaseDigest: `sha256:${'a'.repeat(64)}`,
    recoveryContext: context,
    state: 'uncertain',
    pendingIntent: intentFor(provider),
    verifiedBindings: [],
    lastSafeError: { category: 'uncertain', code: 'CREATION_OUTCOME_UNCERTAIN' },
    createdAt: '2026-09-23T10:30:00.000Z',
    updatedAt: '2026-09-23T10:31:10.000Z',
    ...earlier,
    ...update,
  });
}

/** A marked, empty Fly app created inside the window. */
export function flyApp(update: Partial<FlyAppFacts> = {}): FlyAppFacts {
  return {
    token: '4817203',
    name: 'community-acme',
    organization: 'acme',
    network: NETWORK,
    createdAt: CREATED_AT,
    machines: 0,
    volumes: 0,
    ipAddresses: 0,
    certificates: 0,
    secretNames: [],
    ...update,
  };
}

/** A marked Neon project with only the default branch, role and database. */
export function neonProject(update: Partial<NeonProjectFacts> = {}): NeonProjectFacts {
  return {
    token: 'project-9',
    name: 'community-acme',
    organization: 'org-acme',
    region: 'aws-us-east-2',
    createdAt: CREATED_AT,
    branchCount: 1,
    defaultBranchCount: 1,
    roles: [ROLE],
    databases: ['community'],
    ...update,
  };
}

/** The run's re-proved app with one Tigris add-on created inside the window. */
export function tigrisFacts(update: Partial<TigrisFacts> = {}): TigrisFacts {
  return {
    app: { name: 'community-acme', organization: 'acme', network: APP_NETWORK },
    totalCount: 1,
    addOns: [
      { token: 'addon-5', name: 'community-acme', organization: 'acme', createdAt: CREATED_AT },
    ],
    ...update,
  };
}

export const found = {
  fly: (update?: Partial<FlyAppFacts>): ProbeResult => ({ kind: 'fly', app: flyApp(update) }),
  neon: (...projects: NeonProjectFacts[]): ProbeResult => ({
    kind: 'neon',
    projects: projects.length ? projects : [neonProject()],
  }),
  tigris: (update?: Partial<TigrisFacts>): ProbeResult => ({
    kind: 'tigris',
    facts: tigrisFacts(update),
  }),
};

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isProviderAccessRefusal,
  isProviderKeyKindLimit,
  ProviderCommandError,
} from '../provider-process.js';
import { readDefaultCommunityPreflight } from '../runtime/default-services.js';
import {
  assertCommunityCliVersions,
  CommunityProviderPreflightError,
} from '../runtime/versions.js';
import { NEON_ORG_KEY_OUTPUT, NEON_SCOPE_OUTPUT } from './fake-launch-tools.js';

/** A promise the test settles by hand, so the order reads finish in is chosen, not timed. */
interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const reads = vi.hoisted(() => ({
  readFlyOrganizations: vi.fn(),
  readFlyRegions: vi.fn(),
  readFlyApps: vi.fn(),
  readNeonOrganizations: vi.fn(),
  readNeonRegionsForKey: vi.fn(),
  readNeonProjects: vi.fn(),
  runProviderCommand: vi.fn(),
}));

vi.mock('../fly-read.js', () => ({
  readFlyOrganizations: reads.readFlyOrganizations,
  readFlyRegions: reads.readFlyRegions,
  readFlyApps: reads.readFlyApps,
  readFlyOrganizationId: vi.fn(),
}));
vi.mock('../neon-read.js', () => ({
  readNeonOrganizations: reads.readNeonOrganizations,
  readNeonRegionsForKey: reads.readNeonRegionsForKey,
  readNeonProjects: reads.readNeonProjects,
  readNeonBranches: vi.fn(),
  readNeonBranchTopology: vi.fn(),
  readNeonEndpoints: vi.fn(),
}));
vi.mock('../provider-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../provider-process.js')>()),
  runProviderCommand: reads.runProviderCommand,
}));

type ReadName = Exclude<keyof typeof reads, 'runProviderCommand'>;

let pending: Record<ReadName, Deferred>;

beforeEach(() => {
  pending = {
    readFlyOrganizations: deferred(),
    readFlyRegions: deferred(),
    readFlyApps: deferred(),
    readNeonOrganizations: deferred(),
    readNeonRegionsForKey: deferred(),
    readNeonProjects: deferred(),
  };
  for (const name of Object.keys(pending) as ReadName[]) {
    reads[name].mockReset().mockReturnValue(pending[name].promise);
  }
});

const options = {
  fly: { executable: 'fly', env: {}, timeoutMs: 1000 },
  neon: { executable: 'neonctl', env: { NEON_API_KEY: 'napi_secret_value' }, timeoutMs: 1000 },
  graphqlTimeoutMs: 1000,
};
const selection = {
  flyOrganization: 'personal',
  flyRegion: 'iad',
  appName: 'dorkos-space',
  machineSize: 'shared-cpu-1x',
  neonOrganization: 'org-old-resonance-74926512',
  neonRegion: 'aws-us-east-2',
  neonProjectName: 'dorkos-space',
  bucketName: 'dorkos-space',
};

const NEON_REFUSED =
  "The Neon key in NEON_API_KEY can't read organization org-old-resonance-74926512. Setup needs a key or sign-in that can create projects in it.";
const NEON_UNAVAILABLE =
  'Neon preflight is unavailable. Check provider status, CLI compatibility, and sign-in with neonctl auth, then retry. https://neon.com/docs/reference/neon-cli';
const FLY_REFUSED =
  "Your Fly sign-in can't read organization personal. It may have expired, or it may not have access there. Setup needs a token or sign-in that can create apps in it.";

/** The error a real neonctl exit with this stderr becomes at the process boundary. */
const neonExit = (stderr: string) =>
  new ProviderCommandError('EXIT', isProviderAccessRefusal(stderr), isProviderKeyKindLimit(stderr));

/** Let every settled read's handlers run before the next one settles. */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Settle the reads one at a time in the given order, and return what preflight threw. */
async function preflightFailure(
  order: readonly [ReadName, (read: Deferred) => void][]
): Promise<unknown> {
  const outcome = readDefaultCommunityPreflight(options, selection).then(
    () => undefined,
    (error: unknown) => error
  );
  for (const [name, settle] of order) {
    settle(pending[name]);
    await drain();
  }
  return outcome;
}

const ok =
  (value: unknown[] = []) =>
  (read: Deferred) =>
    read.resolve(value);
const fails = (error: unknown) => (read: Deferred) => read.reject(error);

/** Every Fly read succeeds, before any Neon read settles. */
const flyFine: [ReadName, (read: Deferred) => void][] = [
  ['readFlyOrganizations', ok()],
  ['readFlyRegions', ok()],
  ['readFlyApps', ok()],
];

describe('preflight reads report the same failure whatever order they finish in (DOR-2700)', () => {
  // The live case: a project-scoped Neon key. `projects list --org-id` refuses it, and the region
  // read is answered "not allowed for organization API keys"; that read now falls back on its
  // own, but a key-kind limit reaching preflight from any read must still lose to the refusal.
  // Catches the race, or the key-kind limit, picking the message.
  it.each([
    ['regions first', ['readNeonRegionsForKey', 'readNeonProjects'] as const],
    ['projects first', ['readNeonProjects', 'readNeonRegionsForKey'] as const],
  ])('names the Neon key for a project-scoped key, %s', async (_label, [first, second]) => {
    const failures = {
      readNeonRegionsForKey: neonExit(NEON_ORG_KEY_OUTPUT),
      readNeonProjects: neonExit(NEON_SCOPE_OUTPUT),
    };
    const error = await preflightFailure([
      ...flyFine,
      ['readNeonOrganizations', ok()],
      [first, fails(failures[first])],
      [second, fails(failures[second])],
    ]);
    expect(error).toBeInstanceOf(CommunityProviderPreflightError);
    expect(error).toMatchObject({ provider: 'neon', code: 'ACCESS_DENIED', message: NEON_REFUSED });
  });

  // Neon may also answer another read "not allowed for organization API keys" (its CLI docs
  // say so of `orgs list`). That says nothing about the organization. Catches it being worded
  // as "can't read organization", or losing to an unrelated outage.
  it.each([
    ['limit first', true],
    ['outage first', false],
  ])('says the key kind is not accepted, %s', async (_label, limitFirst) => {
    const limit: [ReadName, (read: Deferred) => void] = [
      'readNeonOrganizations',
      fails(neonExit(NEON_ORG_KEY_OUTPUT)),
    ];
    const outage: [ReadName, (read: Deferred) => void] = [
      'readNeonRegionsForKey',
      fails(new ProviderCommandError('TIMEOUT')),
    ];
    const error = await preflightFailure([
      ...flyFine,
      ...(limitFirst ? [limit, outage] : [outage, limit]),
      ['readNeonProjects', ok()],
    ]);
    expect(error).toMatchObject({
      provider: 'neon',
      code: 'KEY_KIND_UNSUPPORTED',
      message:
        'Neon turned down one of the reads setup needs because of the kind of key in NEON_API_KEY. Setup works with an organization key, a personal key, or a neonctl auth sign-in. https://neon.com/docs/reference/cli-auth',
    });
    expect((error as Error).message).not.toContain("can't read organization");
  });

  // Catches "unavailable" winning when it merely finished first: one read refused, the other
  // genuinely failed.
  it.each([
    ['unavailable first', true],
    ['refusal first', false],
  ])('prefers a refusal over an unavailable read, %s', async (_label, unavailableFirst) => {
    const refusal: [ReadName, (read: Deferred) => void] = [
      'readNeonProjects',
      fails(neonExit(NEON_SCOPE_OUTPUT)),
    ];
    const outage: [ReadName, (read: Deferred) => void] = [
      'readNeonRegionsForKey',
      fails(new ProviderCommandError('TIMEOUT')),
    ];
    const error = await preflightFailure([
      ...flyFine,
      ['readNeonOrganizations', ok()],
      ...(unavailableFirst ? [outage, refusal] : [refusal, outage]),
    ]);
    expect(error).toMatchObject({ code: 'ACCESS_DENIED', message: NEON_REFUSED });
  });

  // Catches the fix overreaching: an outage or an old CLI is not a permission problem.
  it.each([
    'ERROR: Request timed out',
    'ERROR: internal server error',
    'ERROR: Unknown command: api',
    'ERROR: not found',
  ])('keeps %j unavailable', async (stderr) => {
    const error = await preflightFailure([
      ...flyFine,
      ['readNeonRegionsForKey', fails(neonExit(stderr))],
      ['readNeonOrganizations', ok()],
      ['readNeonProjects', fails(new ProviderCommandError('TIMEOUT'))],
    ]);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: NEON_UNAVAILABLE });
  });

  // Fly ran its three reads the same way. Catches the same race there.
  it.each([
    ['unavailable first', true],
    ['refusal first', false],
  ])('prefers a Fly refusal over an unavailable Fly read, %s', async (_label, unavailableFirst) => {
    const refusal: [ReadName, (read: Deferred) => void] = [
      'readFlyApps',
      fails(new ProviderCommandError('EXIT', true)),
    ];
    const outage: [ReadName, (read: Deferred) => void] = [
      'readFlyRegions',
      fails(new ProviderCommandError('EXIT')),
    ];
    const error = await preflightFailure([
      ['readFlyOrganizations', ok()],
      ...(unavailableFirst ? [outage, refusal] : [refusal, outage]),
      ['readNeonOrganizations', ok()],
      ['readNeonRegionsForKey', ok()],
      ['readNeonProjects', ok()],
    ]);
    expect(error).toMatchObject({ provider: 'fly', code: 'ACCESS_DENIED', message: FLY_REFUSED });
  });

  // The two services also raced each other. Catches Fly's "unavailable" hiding Neon's refusal.
  it.each([
    ['Fly first', true],
    ['Neon first', false],
  ])('prefers a Neon refusal over Fly being unavailable, %s', async (_label, flyFirst) => {
    const fly: [ReadName, (read: Deferred) => void][] = [
      ['readFlyOrganizations', fails(new ProviderCommandError('TIMEOUT'))],
      ['readFlyRegions', ok()],
      ['readFlyApps', ok()],
    ];
    const neon: [ReadName, (read: Deferred) => void][] = [
      ['readNeonOrganizations', ok()],
      ['readNeonRegionsForKey', ok()],
      ['readNeonProjects', fails(neonExit(NEON_SCOPE_OUTPUT))],
    ];
    const error = await preflightFailure(flyFirst ? [...fly, ...neon] : [...neon, ...fly]);
    expect(error).toMatchObject({ provider: 'neon', code: 'ACCESS_DENIED' });
  });

  // A missing CLI is the first thing to fix, so it outranks a refusal. Catches the two ranks
  // being swapped, in either completion order.
  it.each([
    ['missing CLI first', true],
    ['refusal first', false],
  ])('names a missing Fly CLI before a Neon refusal, %s', async (_label, missingFirst) => {
    const fly: [ReadName, (read: Deferred) => void][] = [
      ['readFlyOrganizations', fails(new ProviderCommandError('SPAWN'))],
      ['readFlyRegions', fails(new ProviderCommandError('SPAWN'))],
      ['readFlyApps', fails(new ProviderCommandError('SPAWN'))],
    ];
    const neon: [ReadName, (read: Deferred) => void][] = [
      ['readNeonOrganizations', ok()],
      ['readNeonRegionsForKey', ok()],
      ['readNeonProjects', fails(neonExit(NEON_SCOPE_OUTPUT))],
    ];
    const error = await preflightFailure(missingFirst ? [...fly, ...neon] : [...neon, ...fly]);
    expect(error).toMatchObject({ provider: 'fly', code: 'CLI_NOT_FOUND' });
  });

  it('returns every inventory when every read answers', async () => {
    const outcome = readDefaultCommunityPreflight(options, selection);
    for (const [name, read] of Object.entries(pending)) {
      read.resolve(
        name === 'readNeonRegionsForKey' ? { regions: [name], savedList: false } : [name]
      );
    }
    await expect(outcome).resolves.toEqual({
      flyOrganizations: ['readFlyOrganizations'],
      flyRegions: ['readFlyRegions'],
      flyApps: ['readFlyApps'],
      neonOrganizations: ['readNeonOrganizations'],
      neonRegions: ['readNeonRegionsForKey'],
      neonProjects: ['readNeonProjects'],
    });
  });
});

describe('CLI version checks report the same failure whatever order they finish in', () => {
  // Catches the version check's own race: a missing Neon CLI hidden by Fly being unavailable.
  it.each([
    ['Fly first', true],
    ['Neon first', false],
  ])('names the missing Neon CLI, %s', async (_label, flyFirst) => {
    const fly = deferred();
    const neon = deferred();
    reads.runProviderCommand
      .mockReset()
      .mockImplementation((command: { executable: string }) =>
        command.executable === 'fly' ? fly.promise : neon.promise
      );
    const outcome = assertCommunityCliVersions(options.fly, options.neon, {
      fly: '0.4.0',
      neon: '7.0.0',
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    const settleFly = () => fly.reject(new ProviderCommandError('TIMEOUT'));
    const settleNeon = () => neon.reject(new ProviderCommandError('SPAWN'));
    (flyFirst ? settleFly : settleNeon)();
    await drain();
    (flyFirst ? settleNeon : settleFly)();
    expect(await outcome).toMatchObject({ provider: 'neon', code: 'CLI_NOT_FOUND' });
  });
});

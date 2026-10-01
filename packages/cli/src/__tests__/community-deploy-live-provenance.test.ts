import { describe, expect, it, vi } from 'vitest';
import {
  failedProvenanceReceipt,
  failureCode,
  guardCommunityLiveProvenance,
  probeCommunityLiveProvenance,
  readFlyGraphql,
  summarizeGraphqlEnvelope,
  type CommunityLiveProvenanceDependencies,
} from '../../scripts/community-deploy-live-provenance.js';
import { FLY_APP_PROVENANCE_QUERY } from '../commands/community-deploy/fly-graphql-contract.js';
import { FlyGraphqlClientError } from '../commands/community-deploy/fly-graphql-client.js';

const MARKER = '0123456789abcdef0123456789abcdef';
const NETWORK = `dorkos-${MARKER}`;
const ROLE = `community_${'f'.repeat(32)}`;
const APP = 'dorkos-gate-012345abcdef';
const UNKNOWN = 'dorkos-gate-absent-000000000000000000000000';

const journal = {
  recoveryContext: { appName: APP, neonOrganization: 'neon-org' },
  resources: {
    flyAppId: APP,
    neonProjectId: 'project-1',
    neonBranchId: 'branch-1',
    neonRoleId: ROLE,
    tigrisBucketId: 'addon-1',
  },
  provenance: { flyNetwork: NETWORK },
};

const unknownEnvelope = {
  data: { app: null },
  errors: [
    {
      message: `Could not find App "${UNKNOWN}"`,
      path: ['app'],
      extensions: { code: 'NOT_FOUND' },
    },
  ],
};

function dependencies(): CommunityLiveProvenanceDependencies & {
  [K in keyof CommunityLiveProvenanceDependencies]: ReturnType<typeof vi.fn>;
} {
  return {
    readAppProvenance: vi.fn(async (name: string) =>
      name === APP
        ? {
            id: APP,
            internalNumericId: '4817203',
            name: APP,
            network: NETWORK,
            createdAt: '2026-09-24T10:31:07Z',
            organizationSlug: 'gate-org',
            machineCount: 1,
            volumeCount: 0,
            ipAddressCount: 2,
            certificateCount: 0,
            secretNames: ['AWS_ACCESS_KEY_ID'],
          }
        : null
    ),
    flyGraphql: vi.fn(async () => unknownEnvelope),
    readNeonRoleNames: vi.fn(async () => [ROLE]),
    readNeonProjects: vi.fn(async () => [
      { id: 'project-1', createdAt: '2026-09-24T10:31:40Z' },
      { id: 'project-2' },
    ]),
    readTigris: vi.fn(async () => ({ appId: APP, appName: APP })),
    readSecretNames: vi.fn(async () => ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OTHER']),
    runSshNoOp: vi.fn(async () => undefined),
    unknownAppName: vi.fn(() => UNKNOWN),
  };
}

describe('live gate provenance receipt', () => {
  it('records the marker round trip, the binding, the secrets, SSH and the unknown-app answer', async () => {
    const boundary = dependencies();
    const receipt = await probeCommunityLiveProvenance(journal, boundary);
    expect(receipt).toEqual({
      schema: 3,
      fly: {
        ok: true,
        network: NETWORK,
        journaledNetwork: NETWORK,
        networkIsMarked: true,
        networkMatchesJournal: true,
        internalNumericIdPresent: true,
        createdAt: '2026-09-24T10:31:07Z',
      },
      neon: {
        ok: true,
        journaledRole: ROLE,
        roleIsMarked: true,
        roleFoundOnBranch: true,
        projectCreatedAt: '2026-09-24T10:31:40Z',
      },
      tigrisBinding: { ok: true, boundToJournaledApp: true },
      tigrisSecrets: { ok: true, accessKeyIdPresent: true, secretAccessKeyPresent: true },
      sshOnCustomNetwork: { ok: true, works: true },
      unknownApp: {
        launcherRead: { result: 'null' },
        envelope: {
          ok: true,
          summary: {
            keys: ['data', 'errors'],
            data: 'object',
            field: 'null',
            errorCount: 1,
            errorCodes: ['NOT_FOUND'],
            errorPaths: ['app'],
          },
        },
      },
    });
    expect(boundary.runSshNoOp).toHaveBeenCalledWith(APP);
    expect(boundary.readNeonRoleNames).toHaveBeenCalledWith('project-1', 'branch-1');
    expect(boundary.flyGraphql).toHaveBeenCalledWith(FLY_APP_PROVENANCE_QUERY, {
      name: UNKNOWN,
    });
    // The error message repeats the name back; the receipt keeps codes and paths only.
    expect(JSON.stringify(receipt)).not.toContain('Could not find');
  });

  it('sends the launcher provenance query for the unknown app, not a copy', async () => {
    const boundary = dependencies();
    await probeCommunityLiveProvenance(journal, boundary);
    expect(boundary.flyGraphql).toHaveBeenCalledTimes(1);
    expect(boundary.flyGraphql.mock.calls[0]?.[0]).toBe(FLY_APP_PROVENANCE_QUERY);
  });

  it('records a network that differs from the journal, or is unmarked, without failing', async () => {
    const boundary = dependencies();
    boundary.readAppProvenance.mockImplementation(async (name: string) =>
      name === APP
        ? {
            ...(await dependencies().readAppProvenance(APP))!,
            network: 'default',
          }
        : null
    );
    boundary.readNeonRoleNames.mockResolvedValue(['community_owner']);
    const receipt = await probeCommunityLiveProvenance(journal, boundary);
    expect(receipt.fly).toMatchObject({
      ok: true,
      network: 'default',
      networkIsMarked: false,
      networkMatchesJournal: false,
    });
    expect(receipt.neon).toMatchObject({ ok: true, roleFoundOnBranch: false });
  });

  it('records every failed read as a stable code and still runs every other probe', async () => {
    const boundary = dependencies();
    const withText = (code: string) =>
      Object.assign(new Error(`token=secret-value output`), { code });
    boundary.readAppProvenance.mockRejectedValue(new FlyGraphqlClientError('INVALID_RESPONSE'));
    boundary.flyGraphql.mockRejectedValue(withText('FLY_GRAPHQL_HTTP_500'));
    boundary.readNeonRoleNames.mockRejectedValue(withText('EXIT'));
    boundary.readTigris.mockRejectedValue(new Error('free text only'));
    boundary.readSecretNames.mockRejectedValue(withText('TIMEOUT'));
    boundary.runSshNoOp.mockRejectedValue(withText('EXIT'));
    const receipt = await probeCommunityLiveProvenance(journal, boundary);
    expect(receipt).toEqual({
      schema: 3,
      fly: { ok: false, code: 'gql:INVALID_RESPONSE' },
      neon: { ok: false, code: 'err:EXIT' },
      tigrisBinding: { ok: false, code: 'err:ERROR' },
      tigrisSecrets: { ok: false, code: 'err:TIMEOUT' },
      sshOnCustomNetwork: { ok: false, code: 'err:EXIT' },
      unknownApp: {
        launcherRead: { result: 'error', code: 'gql:INVALID_RESPONSE' },
        envelope: { ok: false, code: 'err:FLY_GRAPHQL_HTTP_500' },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('secret-value');
  });

  it('records a partial Tigris secret set and an unbound add-on as observations', async () => {
    const boundary = dependencies();
    boundary.readSecretNames.mockResolvedValue(['AWS_ACCESS_KEY_ID']);
    boundary.readTigris.mockResolvedValue({ appId: 'another-app', appName: APP });
    const receipt = await probeCommunityLiveProvenance(journal, boundary);
    expect(receipt.tigrisSecrets).toEqual({
      ok: true,
      accessKeyIdPresent: true,
      secretAccessKeyPresent: false,
    });
    expect(receipt.tigrisBinding).toEqual({ ok: true, boundToJournaledApp: false });
  });

  it('records a launch from before markers without a journaled network or role', async () => {
    const boundary = dependencies();
    const receipt = await probeCommunityLiveProvenance(
      {
        ...journal,
        provenance: undefined,
        resources: { ...journal.resources, neonRoleId: 'community_owner' },
      },
      boundary
    );
    expect(receipt.fly).toMatchObject({ journaledNetwork: null, networkMatchesJournal: false });
    expect(receipt.neon).toMatchObject({ journaledRole: 'community_owner', roleIsMarked: false });
  });

  it('never probes without the journal identities it needs', async () => {
    const boundary = dependencies();
    const receipt = await probeCommunityLiveProvenance({ resources: {} }, boundary);
    expect(receipt.fly).toEqual({ ok: false, code: 'journal:JOURNAL_APP_NAME' });
    expect(receipt.neon).toEqual({ ok: false, code: 'journal:JOURNAL_NEON_IDENTITY' });
    expect(receipt.tigrisBinding).toEqual({ ok: false, code: 'journal:JOURNAL_TIGRIS_IDENTITY' });
    expect(receipt.sshOnCustomNetwork).toEqual({ ok: false, code: 'journal:JOURNAL_APP_NAME' });
    expect(boundary.runSshNoOp).not.toHaveBeenCalled();
    expect(boundary.readTigris).not.toHaveBeenCalled();
  });

  it('records a data:null answer for an unknown app distinctly from app:null', () => {
    expect(summarizeGraphqlEnvelope({ data: null, errors: [{ message: 'x' }] }, 'app')).toEqual({
      keys: ['data', 'errors'],
      data: 'null',
      field: 'absent',
      errorCount: 1,
      errorCodes: [],
      errorPaths: [],
    });
    expect(summarizeGraphqlEnvelope({ data: { app: null } }, 'app')).toMatchObject({
      data: 'object',
      field: 'null',
      errorCount: 0,
    });
    expect(
      summarizeGraphqlEnvelope(
        { errors: [{ extensions: { code: 'has spaces' }, path: ['app', '<x>'] }] },
        'app'
      )
    ).toMatchObject({ data: 'absent', errorCodes: [], errorPaths: [] });
  });
});

describe('live gate raw Fly read', () => {
  it('sends the token only as a bearer header and keeps it out of every failure', async () => {
    const fetch = vi.fn(async () => new Response('{"data":{"app":null}}', { status: 200 }));
    await expect(
      readFlyGraphql({ accessToken: 'tok-123', query: 'q', variables: { name: 'n' }, fetch })
    ).resolves.toEqual({ data: { app: null } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fly.io/graphql');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    expect(String(init.body)).not.toContain('tok-123');

    for (const response of [
      new Response('tok-123 denied', { status: 500 }),
      new Response('not json tok-123', { status: 200 }),
    ]) {
      const failed = await readFlyGraphql({
        accessToken: 'tok-123',
        query: 'q',
        variables: {},
        fetch: vi.fn(async () => response),
      }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(Error);
      expect(String((failed as Error).message)).not.toContain('tok-123');
      expect((failed as { code: string }).code).toMatch(/^FLY_GRAPHQL_/u);
    }
  });
});

describe('live gate receipt codes', () => {
  it('prefixes every failure code with where it came from', async () => {
    const { ProviderCommandError } =
      await import('../commands/community-deploy/provider-process.js');
    const { TigrisSessionError } = await import('../commands/community-deploy/tigris-session.js');
    expect(failureCode(new ProviderCommandError('TIMEOUT'))).toBe('proc:TIMEOUT');
    expect(failureCode(new FlyGraphqlClientError('PROVIDER_UNAVAILABLE'))).toBe(
      'gql:PROVIDER_UNAVAILABLE'
    );
    expect(failureCode(new TigrisSessionError('INVALID_INPUT'))).toBe('session:INVALID_INPUT');
    const raw = await readFlyGraphql({
      accessToken: 't',
      query: 'q',
      variables: {},
      fetch: vi.fn(async () => new Response('', { status: 502 })),
    }).catch((error: unknown) => error);
    expect(failureCode(raw)).toBe('http:FLY_GRAPHQL_HTTP_502');
    expect(failureCode(new Error('text only'))).toBe('err:ERROR');
    expect(failureCode(Object.assign(new Error('x'), { code: 'has spaces' }))).toBe('err:ERROR');
  });
});

describe('live gate probe guard', () => {
  it('passes a finished receipt through unchanged', async () => {
    const receipt = await probeCommunityLiveProvenance(journal, dependencies());
    await expect(guardCommunityLiveProvenance(async () => receipt, 1_000)).resolves.toBe(receipt);
  });

  it('turns a rejected, a synchronously thrown and a throwing name probe into PROBE_THREW', async () => {
    const throwingName = dependencies();
    throwingName.unknownAppName.mockImplementation(() => {
      throw new Error('boom');
    });
    for (const run of [
      async () => {
        throw new Error('boom');
      },
      () => {
        throw new Error('sync boom');
      },
      () => probeCommunityLiveProvenance(journal, throwingName),
    ]) {
      await expect(
        guardCommunityLiveProvenance(run as () => Promise<never>, 1_000)
      ).resolves.toEqual(failedProvenanceReceipt('guard:PROBE_THREW'));
    }
  });

  it('gives up on a probe run that never settles at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = guardCommunityLiveProvenance(() => new Promise(() => undefined), 8 * 60_000);
      await vi.advanceTimersByTimeAsync(8 * 60_000);
      await expect(pending).resolves.toEqual(failedProvenanceReceipt('guard:PROBE_DEADLINE'));
    } finally {
      vi.useRealTimers();
    }
  });

  // The same order main uses: guard, then cleanup. A throwing or hanging probe still reaches it.
  it.each([
    ['throws', () => Promise.reject(new Error('boom'))],
    ['never settles', () => new Promise<never>(() => undefined)],
  ])('still reaches cleanup when the probe run %s', async (_label, run) => {
    const cleanup = vi.fn(async () => ({ cleaned: ['x'], retained: [] }));
    const flow = async () => {
      const provenance = await guardCommunityLiveProvenance(run, 50);
      const receipt = await cleanup();
      return { provenance, receipt };
    };
    const result = await flow();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result.provenance.fly).toMatchObject({
      ok: false,
      code: expect.stringMatching(/^guard:/u),
    });
  });
});

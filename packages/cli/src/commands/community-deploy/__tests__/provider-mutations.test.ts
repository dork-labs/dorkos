/** @vitest-environment node */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlyAppProvenance } from '../fly-graphql-contract.js';
import {
  assertFlyAppNameAvailable,
  createFlyApp,
  deployFlyImage,
  destroyFlyApp,
  stageFlySecrets,
  verifyFlyDeployment,
  verifyDeployedFlySecrets,
  verifyStagedFlySecrets,
} from '../fly-mutate.js';
import {
  assertNeonProjectNameAvailable,
  createNeonProject,
  deleteNeonProject,
} from '../neon-mutate.js';
import { mutateTrustedProviderFields } from './provider-contract-harness.js';

const temporaryDirectories: string[] = [];
const network = 'dorkos-7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a';

function provenance(update: Partial<FlyAppProvenance> = {}): FlyAppProvenance {
  return {
    id: 'community-space',
    internalNumericId: '4817203',
    name: 'community-space',
    network,
    createdAt: '2026-09-23T10:31:07Z',
    organizationSlug: 'dork-labs',
    machineCount: 0,
    volumeCount: 0,
    ipAddressCount: 0,
    certificateCount: 0,
    secretNames: [],
    ...update,
  };
}
const digest = `sha256:${'a'.repeat(64)}`;

async function fakeProvider(source: string): Promise<{ executable: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-provider-mutation-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'provider');
  await writeFile(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, directory };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const options = (executable: string, env: Readonly<Record<string, string>> = {}) => ({
  executable,
  env,
  timeoutMs: 10_000,
});

describe('provider mutation boundaries', () => {
  // `fly apps create --json` (flyctl v0.4.104) reads the app back over GraphQL without asking for
  // the organization's name, so it arrives blank. That shape created the app and then failed.
  it('binds the app flyctl actually prints on create by name and organization slug', async () => {
    const document = await readFile(
      new URL('./fixtures/fly/app-create.json', import.meta.url),
      'utf8'
    );
    const { executable } = await fakeProvider(`
test "$*" = "apps create community-fixture-app --org fixture-org --network ${network} --json --yes" || exit 9
printf '%s' "$FIXTURE_JSON"
`);
    const readProvenance = vi.fn();
    await expect(
      createFlyApp(
        options(executable, { FIXTURE_JSON: document }),
        'community-fixture-app',
        'fixture-org',
        network,
        readProvenance
      )
    ).resolves.toEqual({
      id: 'community-fixture-app',
      name: 'community-fixture-app',
      organizationSlug: 'fixture-org',
      status: 'pending',
    });
    // A readable create needs no fallback; exact-ID inspection checks the network afterwards.
    expect(readProvenance).not.toHaveBeenCalled();
  });

  it('identifies a created app by name, slug and marker network when the create output is unreadable', async () => {
    for (const output of ["printf '%s' '{}'", "printf '%s' 'New app created'", ':']) {
      const { executable } = await fakeProvider(`
case "$*" in
  "apps create community-space --org dork-labs --network ${network} --json --yes") ${output} ;;
  *) exit 9 ;;
esac
`);
      const readProvenance = vi.fn(async () => provenance());
      await expect(
        createFlyApp(options(executable), 'community-space', 'dork-labs', network, readProvenance),
        output
      ).resolves.toEqual({
        id: 'community-space',
        name: 'community-space',
        organizationSlug: 'dork-labs',
        status: '',
      });
      // The fallback never lists apps: `apps list --json` always reports an empty network.
      expect(readProvenance).toHaveBeenCalledExactlyOnceWith('community-space');
    }
  });

  it("never adopts a same-name app whose network does not carry this run's marker", async () => {
    const { executable } = await fakeProvider(`printf '%s' '{}'`);
    const candidates = [
      // What `apps list` reports for every app, and what an app on the default network looks like.
      provenance({ network: '' }),
      provenance({ network: null }),
      // Another run's marker, or a network someone else chose.
      provenance({ network: `dorkos-${'0'.repeat(32)}` }),
      provenance({ network: 'default' }),
      // The right marker, but a foreign organization or name.
      provenance({ organizationSlug: 'personal' }),
      provenance({ name: 'community-other' }),
      // Nothing by that name.
      null,
    ];
    for (const candidate of candidates) {
      await expect(
        createFlyApp(
          options(executable),
          'community-space',
          'dork-labs',
          network,
          async () => candidate
        ),
        JSON.stringify(candidate)
      ).rejects.toMatchObject({ code: 'CREATION_OUTCOME_UNCERTAIN' });
    }
  });

  it('classifies lost, unidentifiable, or foreign create outcomes as uncertain', async () => {
    const sources = [
      // The command failed: nothing is looked up or adopted by name.
      "printf '%s' 'lost' >&2; exit 12",
      // Unreadable output, and the provenance read fails.
      `printf '%s' '{}'`,
      // Readable output naming a different organization is never adopted.
      `printf '%s' '{"ID":"community-space","Name":"community-space","Status":"pending","Organization":{"ID":"org_123","Slug":"personal","Name":""}}'`,
      // Readable output naming a different app is never adopted.
      `printf '%s' '{"ID":"community-other","Name":"community-other","Status":"pending","Organization":{"ID":"org_123","Slug":"dork-labs","Name":""}}'`,
    ];
    for (const source of sources) {
      const { executable } = await fakeProvider(source);
      const readProvenance = vi.fn(async () => {
        throw new Error('provenance read failed');
      });
      await expect(
        createFlyApp(options(executable), 'community-space', 'dork-labs', network, readProvenance),
        source
      ).rejects.toMatchObject({
        code: 'CREATION_OUTCOME_UNCERTAIN',
        message: expect.not.stringContaining('lost'),
      });
    }
  });

  it('rejects every mutation of trusted Fly and Neon creation identity fields', async () => {
    const flyFixture = JSON.parse(
      await readFile(new URL('./fixtures/fly/app-create.json', import.meta.url), 'utf8')
    ) as unknown;
    const neonFixture = JSON.parse(
      await readFile(new URL('./fixtures/neon/project-create.json', import.meta.url), 'utf8')
    ) as unknown;
    // The follow-up provenance read finds nothing, so a mutated create response cannot be rescued.
    const { executable: flyExecutable } = await fakeProvider(`printf '%s' "$FIXTURE_JSON"`);
    const { executable } = await fakeProvider(`printf '%s' "$FIXTURE_JSON"`);
    await Promise.all(
      mutateTrustedProviderFields(flyFixture, [
        ['ID'],
        ['Name'],
        ['Status'],
        ['Organization', 'Slug'],
      ]).map((mutation) =>
        expect(
          createFlyApp(
            options(flyExecutable, { FIXTURE_JSON: JSON.stringify(mutation.value) }),
            'community-fixture-app',
            'fixture-org',
            network,
            async () => null
          ),
          mutation.label
        ).rejects.toMatchObject({ code: 'CREATION_OUTCOME_UNCERTAIN' })
      )
    );
    await Promise.all(
      mutateTrustedProviderFields(neonFixture, [
        ['project', 'id'],
        ['project', 'org_id'],
        ['project', 'name'],
        ['project', 'region_id'],
        ['project', 'pg_version'],
      ]).map((mutation) =>
        expect(
          createNeonProject(options(executable, { FIXTURE_JSON: JSON.stringify(mutation.value) }), {
            organizationId: 'org_fixture_01',
            name: 'Community Fixture',
            regionId: 'aws-us-east-2',
            databaseName: 'community',
            roleName: 'community_owner',
            postgresVersion: 17,
          }),
          mutation.label
        ).rejects.toMatchObject({ code: 'CREATION_OUTCOME_UNCERTAIN' })
      )
    );
  });

  it('streams Fly secrets only through stdin and requires staged readback', async () => {
    const canary = 'CANARY_DATABASE_URL_PASSWORD';
    const { executable, directory } = await fakeProvider(`
printf '%s' "$*" > "$CAPTURE_ARGS"
cat > "$CAPTURE_STDIN"
`);
    const env = {
      CAPTURE_ARGS: join(directory, 'args'),
      CAPTURE_STDIN: join(directory, 'stdin'),
    };
    await expect(
      stageFlySecrets(options(executable, env), 'community-space', {
        COMMUNITY_DATABASE_URL: canary,
        COMMUNITY_AUTH_SECRET: 'auth-canary',
      })
    ).resolves.toEqual({ operation: 'secrets-stage' });
    const args = await readFile(env.CAPTURE_ARGS, 'utf8');
    expect(args).toBe('secrets import --app community-space --stage');
    expect(args).not.toContain(canary);
    expect(Object.values(env)).not.toContain(canary);
    expect(await readFile(env.CAPTURE_STDIN, 'utf8')).toContain(`COMMUNITY_DATABASE_URL=${canary}`);
    expect(
      verifyStagedFlySecrets(
        [
          { name: 'COMMUNITY_AUTH_SECRET', digest: 'digest-a', status: 'Staged' },
          { name: 'COMMUNITY_DATABASE_URL', digest: 'digest-b', status: 'Staged' },
        ],
        ['COMMUNITY_DATABASE_URL', 'COMMUNITY_AUTH_SECRET'],
        [{ name: 'COMMUNITY_DATABASE_URL', digest: 'old-digest', status: 'Deployed' }]
      )
    ).toHaveLength(2);
    expect(
      verifyDeployedFlySecrets(
        [
          { name: 'COMMUNITY_AUTH_SECRET', digest: 'digest-a', status: 'Deployed' },
          { name: 'COMMUNITY_DATABASE_URL', digest: 'digest-b', status: 'Deployed' },
        ],
        [
          { name: 'COMMUNITY_DATABASE_URL', digest: 'digest-b', status: 'Staged' },
          { name: 'COMMUNITY_AUTH_SECRET', digest: 'digest-a', status: 'Staged' },
        ]
      )
    ).toHaveLength(2);
    expect(() =>
      verifyStagedFlySecrets(
        [{ name: 'COMMUNITY_DATABASE_URL', digest: 'digest-b', status: 'Deployed' }],
        ['COMMUNITY_DATABASE_URL']
      )
    ).toThrow();
  });

  it('deploys only an immutable image with HA disabled and verifies exact runtime state', async () => {
    const { executable, directory } = await fakeProvider(`printf '%s' "$*" > "$CAPTURE_ARGS"`);
    const argsPath = join(directory, 'args');
    await expect(
      deployFlyImage(
        options(executable, { CAPTURE_ARGS: argsPath }),
        'community-space',
        `ghcr.io/dork-labs/dorkos-community@${digest}`
      )
    ).resolves.toEqual({ operation: 'deploy' });
    expect(await readFile(argsPath, 'utf8')).toBe(
      `deploy --app community-space --image ghcr.io/dork-labs/dorkos-community@${digest} --ha=false --yes`
    );
    const inventory = {
      machines: [
        {
          id: 'machine_01',
          name: 'machine',
          state: 'started',
          region: 'ord',
          imageDigest: digest,
          imageRepository: 'ghcr.io/dork-labs/dorkos-community',
          checks: [{ name: 'health', status: 'passing' }],
        },
      ],
      releases: [
        {
          id: 'release_01',
          imageRef: `ghcr.io/dork-labs/dorkos-community@${digest}`,
          status: 'complete',
          stable: false,
          version: 4,
        },
      ],
      addresses: [{ id: 'ip_01', address: '203.0.113.1', type: 'shared_v4', region: 'global' }],
    };
    const previousReleases = [
      {
        id: 'release_00',
        imageRef: `ghcr.io/dork-labs/dorkos-community@sha256:${'b'.repeat(64)}`,
        status: 'complete',
        stable: false,
        version: 3,
      },
    ];
    expect(
      verifyFlyDeployment(inventory, previousReleases, 'ghcr.io/dork-labs/dorkos-community', digest)
    ).toBe(inventory);
    expect(() =>
      verifyFlyDeployment(
        { ...inventory, machines: [...inventory.machines, inventory.machines[0]!] },
        previousReleases,
        'ghcr.io/dork-labs/dorkos-community',
        digest
      )
    ).toThrow();
    for (const invalid of [
      {
        ...inventory,
        machines: [{ ...inventory.machines[0]!, imageDigest: `sha256:${'c'.repeat(64)}` }],
      },
      {
        ...inventory,
        machines: [{ ...inventory.machines[0]!, checks: [{ name: 'health', status: 'failing' }] }],
      },
      {
        ...inventory,
        releases: [
          {
            ...inventory.releases[0]!,
            imageRef: `ghcr.io/dork-labs/dorkos-community@sha256:${'c'.repeat(64)}`,
          },
        ],
      },
    ]) {
      expect(() =>
        verifyFlyDeployment(invalid, previousReleases, 'ghcr.io/dork-labs/dorkos-community', digest)
      ).toThrow();
    }
    expect(() =>
      verifyFlyDeployment(
        inventory,
        [{ ...inventory.releases[0]! }],
        'ghcr.io/dork-labs/dorkos-community',
        digest
      )
    ).toThrow();
  });

  it('exposes exact Fly and Neon cleanup command boundaries without inferring deletion', async () => {
    const { executable, directory } = await fakeProvider(`printf '%s' "$*" > "$CAPTURE_ARGS"`);
    const argsPath = join(directory, 'args');
    await expect(
      destroyFlyApp(options(executable, { CAPTURE_ARGS: argsPath }), 'community-space')
    ).resolves.toEqual({ operation: 'destroy' });
    expect(await readFile(argsPath, 'utf8')).toBe('apps destroy community-space --yes');
    await expect(
      deleteNeonProject(options(executable, { CAPTURE_ARGS: argsPath }), 'project_123')
    ).resolves.toEqual({ operation: 'delete', projectId: 'project_123' });
    expect(await readFile(argsPath, 'utf8')).toBe('projects delete project_123 --output json');
  });

  it('creates Neon without credential output and records only the exact project identity', async () => {
    const { executable, directory } = await fakeProvider(`
printf '%s' "$*" > "$CAPTURE_ARGS"
printf '%s' '{"project":{"id":"project_123","org_id":"org_123","name":"Community Space","region_id":"aws-us-east-2","pg_version":17}}'
`);
    const argsPath = join(directory, 'args');
    await expect(
      createNeonProject(options(executable, { CAPTURE_ARGS: argsPath }), {
        organizationId: 'org_123',
        name: 'Community Space',
        regionId: 'aws-us-east-2',
        databaseName: 'community',
        roleName: 'community_owner',
        postgresVersion: 17,
      })
    ).resolves.toEqual({
      id: 'project_123',
      organizationId: 'org_123',
      name: 'Community Space',
      regionId: 'aws-us-east-2',
      postgresVersion: 17,
    });
    expect(await readFile(argsPath, 'utf8')).toBe(
      'projects create --name Community Space --org-id org_123 --region-id aws-us-east-2 --database community --role community_owner --pg-version 17 --no-secrets --output json'
    );
  });

  it('treats wrong Neon bindings and lost responses as uncertain without leaking output', async () => {
    const canary = 'CANARY_NEON_PROVIDER_PASSWORD';
    for (const source of [
      `printf '%s' '{"project":{"id":"project_123","org_id":"other","name":"Community Space","region_id":"aws-us-east-2","pg_version":17}}'`,
      `printf '%s' '${canary}' >&2; exit 7`,
    ]) {
      const { executable } = await fakeProvider(source);
      await expect(
        createNeonProject(options(executable), {
          organizationId: 'org_123',
          name: 'Community Space',
          regionId: 'aws-us-east-2',
          databaseName: 'community',
          roleName: 'community_owner',
          postgresVersion: 17,
        })
      ).rejects.toMatchObject({
        code: 'CREATION_OUTCOME_UNCERTAIN',
        message: expect.not.stringContaining(canary),
      });
    }
  });

  it('stops on same-name Fly and Neon inventory without adopting either resource', () => {
    expect(() =>
      assertFlyAppNameAvailable(
        [
          {
            id: 'foreign-app',
            name: 'community-space',
            organizationSlug: 'dork-labs',
            status: 'deployed',
          },
        ],
        'community-space'
      )
    ).toThrowError(expect.objectContaining({ code: 'CREATION_OUTCOME_UNCERTAIN' }));
    expect(() =>
      assertNeonProjectNameAvailable(
        [
          {
            id: 'foreign-project',
            organizationId: 'org_123',
            name: 'Community Space',
            regionId: 'aws-us-east-2',
            postgresVersion: 17,
          },
        ],
        'Community Space'
      )
    ).toThrowError(expect.objectContaining({ code: 'CREATION_OUTCOME_UNCERTAIN' }));
  });
});

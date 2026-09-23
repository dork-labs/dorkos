/** @vitest-environment node */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readFlyApps,
  readFlyIdentity,
  readFlyOrganizationId,
  readFlyOrganizations,
  readFlyRegions,
  readFlyRuntimeInventory,
} from '../fly-read.js';
import { mutateTrustedProviderFields } from './provider-contract-harness.js';

const temporaryDirectories: string[] = [];

async function fakeFlyctl(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-fly-read-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'fly');
  await writeFile(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const options = (executable: string, env: Readonly<Record<string, string>> = {}) => ({
  executable,
  env,
  timeoutMs: 10_000,
});

describe('Fly read-only contracts', () => {
  it('uses pinned JSON commands and returns only selected non-secret fields', async () => {
    const identity = await fakeFlyctl(`
test "$1 $2 $3" = "auth whoami --json" || exit 9
printf '%s' '{"email":"operator@example.test"}'
`);
    await expect(readFlyIdentity(options(identity))).resolves.toEqual({
      email: 'operator@example.test',
    });

    const organizations = await fakeFlyctl(`
test "$1 $2 $3" = "orgs list --json" || exit 9
printf '%s' '{"personal":"Personal","dork-labs":"Dork Labs"}'
`);
    await expect(readFlyOrganizations(options(organizations))).resolves.toEqual([
      { slug: 'dork-labs', name: 'Dork Labs' },
      { slug: 'personal', name: 'Personal' },
    ]);

    const regions = await fakeFlyctl(`
test "$1 $2 $3" = "platform regions --json" || exit 9
printf '%s' '[{"code":"ord","name":"Chicago, Illinois (US)","latitude":41.88,"longitude":-87.63,"gateway_available":true,"requires_paid_plan":false,"deprecated":false,"mpg_available":true}]'
`);
    await expect(readFlyRegions(options(regions))).resolves.toEqual([
      {
        code: 'ord',
        name: 'Chicago, Illinois (US)',
        latitude: 41.88,
        longitude: -87.63,
        gatewayAvailable: true,
        requiresPaidPlan: false,
        deprecated: false,
      },
    ]);
  });

  it('binds app identity to the explicitly selected organization', async () => {
    const executable = await fakeFlyctl(`
test "$1 $2 $3 $4 $5" = "apps list --org dork-labs --json" || exit 9
printf '%s' '[{"ID":"community-space","Name":"community-space","Status":"deployed","Organization":{"ID":"","Slug":"dork-labs","Name":"Dork Labs","PaidPlan":true},"Secrets":{"SHOULD_NOT_ESCAPE":"CANARY_SECRET"}}]'
`);
    const result = await readFlyApps(options(executable), 'dork-labs');
    expect(result).toEqual([
      {
        id: 'community-space',
        name: 'community-space',
        organizationSlug: 'dork-labs',
        status: 'deployed',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('CANARY_SECRET');
  });

  // flyctl v0.4.104 lists apps through the Machines API, which blanks the organization ID; the
  // GraphQL listing it replaced filled both. An organization with apps must read under either.
  it.each([
    ['Machines API listing (organization ID blank)', 'apps.json'],
    ['GraphQL listing (organization ID and name present)', 'apps-graphql.json'],
  ])('reads an organization that already has apps from the %s', async (_label, fixture) => {
    const document = await readFile(new URL(`./fixtures/fly/${fixture}`, import.meta.url), 'utf8');
    const executable = await fakeFlyctl(`
test "$1 $2 $3 $4 $5" = "apps list --org fixture-org --json" || exit 9
printf '%s' "$FIXTURE_JSON"
`);
    await expect(
      readFlyApps(options(executable, { FIXTURE_JSON: document }), 'fixture-org')
    ).resolves.toEqual([
      {
        id: 'community-fixture',
        name: 'community-fixture',
        organizationSlug: 'fixture-org',
        status: 'deployed',
      },
    ]);
  });

  it('never reads the organization ID or name, whether blank, missing, or set', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/fly/apps.json', import.meta.url), 'utf8')
    ) as Array<{ Organization: Record<string, unknown> }>;
    const executable = await fakeFlyctl(`printf '%s' "$FIXTURE_JSON"`);
    for (const organization of [
      { ID: '', Name: '' },
      { ID: undefined, Name: undefined },
      { ID: 'org_fixture_01', Name: 'Fixture Organization' },
    ]) {
      const variant = structuredClone(fixture);
      Object.assign(variant[0]!.Organization, organization);
      await expect(
        readFlyApps(options(executable, { FIXTURE_JSON: JSON.stringify(variant) }), 'fixture-org')
      ).resolves.toHaveLength(1);
    }
  });

  it('resolves the selected organization ID and binds it to the slug', async () => {
    const executable = await fakeFlyctl(`
test "$1 $2 $3 $4" = "orgs show personal --json" || exit 9
printf '%s' '{"ID":"org_fixture_01","InternalNumericID":"1","Name":"Operator","Slug":"personal","Type":"PERSONAL","Members":{"Edges":[]}}'
`);
    await expect(readFlyOrganizationId(options(executable), 'personal')).resolves.toBe(
      'org_fixture_01'
    );

    const otherOrganization = await fakeFlyctl(
      `printf '%s' '{"ID":"org_fixture_02","Slug":"dork-labs"}'`
    );
    await expect(
      readFlyOrganizationId(options(otherOrganization), 'personal')
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects duplicate identities, controls, and malformed trusted fields', async () => {
    const duplicate = await fakeFlyctl(
      `printf '%s' '[{"code":"ord","name":"Chicago","latitude":1,"longitude":2,"gateway_available":true,"requires_paid_plan":false,"deprecated":false},{"code":"ord","name":"Duplicate","latitude":1,"longitude":2,"gateway_available":true,"requires_paid_plan":false,"deprecated":false}]'`
    );
    await expect(readFlyRegions(options(duplicate))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const control = await fakeFlyctl(`printf '%s' '{"safe":"bad\\u001b[2J"}'`);
    await expect(readFlyOrganizations(options(control))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const wrongOrganization = await fakeFlyctl(
      `printf '%s' '[{"ID":"community-space","Name":"community-space","Status":"deployed","Organization":{"ID":"","Slug":"personal","Name":"Personal"}}]'`
    );
    await expect(readFlyApps(options(wrongOrganization), 'dork-labs')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('rejects every mutation of trusted app identity fields', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/fly/apps.json', import.meta.url), 'utf8')
    ) as unknown;
    const paths = [
      [0, 'ID'],
      [0, 'Name'],
      [0, 'Status'],
      [0, 'Organization', 'Slug'],
    ] as const;
    const executable = await fakeFlyctl(`printf '%s' "$FIXTURE_JSON"`);
    await Promise.all(
      mutateTrustedProviderFields(fixture, paths).map((mutation) =>
        expect(
          readFlyApps(
            options(executable, { FIXTURE_JSON: JSON.stringify(mutation.value) }),
            'fixture-org'
          ),
          mutation.label
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      )
    );
  });

  it('reads exact app runtime state while discarding health output', async () => {
    const executable = await fakeFlyctl(`
case "$1 $2" in
  "machine list")
    test "$3 $4 $5" = "--app community-space --json" || exit 9
    printf '%s' '[{"id":"machine_01","name":"community-space-01","state":"started","region":"ord","image_ref":{"digest":"sha256:${'a'.repeat(64)}","registry":"ghcr.io","repository":"dork-labs/dorkos-community"},"checks":[{"name":"health","status":"passing","output":"CANARY_HEALTH_OUTPUT"}]}]'
    ;;
  "releases --app")
    test "$3 $4" = "community-space --json" || exit 9
    printf '%s' '[{"ID":"release_01","ImageRef":"ghcr.io/dork-labs/dorkos-community@sha256:${'a'.repeat(64)}","Status":"complete","Stable":false,"Version":1}]'
    ;;
  "ips list")
    test "$3 $4 $5" = "--app community-space --json" || exit 9
    printf '%s' '[{"ID":"ip_01","Address":"203.0.113.1","Type":"shared_v4","Region":"global"}]'
    ;;
  *) exit 9 ;;
esac
`);
    const result = await readFlyRuntimeInventory(options(executable), 'community-space');
    expect(result).toEqual({
      machines: [
        {
          id: 'machine_01',
          name: 'community-space-01',
          state: 'started',
          region: 'ord',
          imageDigest: `sha256:${'a'.repeat(64)}`,
          imageRepository: 'ghcr.io/dork-labs/dorkos-community',
          checks: [{ name: 'health', status: 'passing' }],
        },
      ],
      releases: [
        {
          id: 'release_01',
          imageRef: `ghcr.io/dork-labs/dorkos-community@sha256:${'a'.repeat(64)}`,
          status: 'complete',
          stable: false,
          version: 1,
        },
      ],
      addresses: [{ id: 'ip_01', address: '203.0.113.1', type: 'shared_v4', region: 'global' }],
    });
    expect(JSON.stringify(result)).not.toContain('CANARY_HEALTH_OUTPUT');
  });

  it.each([
    [
      'machine digest',
      `[{"id":"machine_01","name":"machine","state":"started","region":"ord","image_ref":{"registry":"ghcr.io","repository":"dork-labs/dorkos-community"}}]`,
      '[]',
      '[]',
    ],
    [
      'duplicate machine',
      `[{"id":"machine_01","name":"one","state":"started","region":"ord","image_ref":{"digest":"sha256:${'a'.repeat(64)}","registry":"ghcr.io","repository":"repo"}},{"id":"machine_01","name":"two","state":"started","region":"ord","image_ref":{"digest":"sha256:${'a'.repeat(64)}","registry":"ghcr.io","repository":"repo"}}]`,
      '[]',
      '[]',
    ],
    [
      'duplicate release',
      '[]',
      `[{"ID":"release_01","ImageRef":"repo@sha256:${'a'.repeat(64)}","Status":"complete","Stable":true,"Version":1},{"ID":"release_01","ImageRef":"repo@sha256:${'a'.repeat(64)}","Status":"complete","Stable":true,"Version":2}]`,
      '[]',
    ],
    [
      'duplicate release version',
      '[]',
      `[{"ID":"release_01","ImageRef":"repo@sha256:${'a'.repeat(64)}","Status":"complete","Stable":false,"Version":2},{"ID":"release_02","ImageRef":"other@sha256:${'b'.repeat(64)}","Status":"failed","Stable":false,"Version":2}]`,
      '[]',
    ],
    [
      'duplicate address',
      '[]',
      '[]',
      '[{"ID":"ip_01","Address":"203.0.113.1","Type":"shared_v4","Region":"global"},{"ID":"ip_01","Address":"2001:db8::1","Type":"v6","Region":"global"}]',
    ],
  ])('fails closed on invalid runtime %s', async (_label, machines, releases, addresses) => {
    const executable = await fakeFlyctl(`
case "$1 $2" in
  "machine list") printf '%s' '${machines}' ;;
  "releases --app") printf '%s' '${releases}' ;;
  "ips list") printf '%s' '${addresses}' ;;
  *) exit 9 ;;
esac
`);
    await expect(
      readFlyRuntimeInventory(options(executable), 'community-space')
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});

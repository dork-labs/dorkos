/** @vitest-environment node */
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readNeonBranches,
  readNeonBranchTopology,
  readNeonOrganizations,
  readNeonProjects,
  readNeonRegions,
  readNeonDirectConnection,
  readNeonEndpoints,
  verifyNeonDirectEndpoint,
} from '../neon-read.js';
import { mutateTrustedProviderFields } from './provider-contract-harness.js';

const temporaryDirectories: string[] = [];

async function fakeNeon(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-neon-read-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'neon');
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

describe('Neon read-only contracts', () => {
  it('reads active provider regions from the authenticated API command', async () => {
    const executable = await fakeNeon(`
test "$1 $2 $3 $4" = "api /regions --output json" || exit 9
cat "$FIXTURE_PATH"
`);
    await expect(
      readNeonRegions(
        options(executable, {
          FIXTURE_PATH: fileURLToPath(new URL('./fixtures/neon/regions.json', import.meta.url)),
        })
      )
    ).resolves.toEqual([
      {
        id: 'aws-us-east-2',
        name: 'AWS US East 2',
        isDefault: true,
        latitude: 39.96,
        longitude: -83,
      },
    ]);
  });
  it('rejects every mutation of trusted active-region fields', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/neon/regions.json', import.meta.url), 'utf8')
    ) as unknown;
    const paths = [
      ['regions', 0, 'region_id'],
      ['regions', 0, 'name'],
      ['regions', 0, 'default'],
      ['regions', 0, 'geo_lat'],
      ['regions', 0, 'geo_long'],
    ] as const;
    const executable = await fakeNeon(`printf '%s' "$FIXTURE_JSON"`);
    await Promise.all(
      mutateTrustedProviderFields(fixture, paths).map((mutation) =>
        expect(
          readNeonRegions(options(executable, { FIXTURE_JSON: JSON.stringify(mutation.value) })),
          mutation.label
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      )
    );
  });
  it('binds the direct credential hostname to exact endpoint inventory', async () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/neon/endpoints.json', import.meta.url));
    const executable = await fakeNeon(`
case "$1" in
  api)
    test "$*" = "api /projects/project-example/branches/branch-example/endpoints --output json" || exit 9
    cat "$FIXTURE_PATH"
    ;;
  connection-string) printf '%s' 'postgresql://community_owner:CANARY_PASSWORD@ep-example-123.us-east-2.aws.neon.tech/community?sslmode=require&channel_binding=require' ;;
  *) exit 9 ;;
esac
`);
    const readOptions = options(executable, { FIXTURE_PATH: fixturePath });
    const endpoints = await readNeonEndpoints(readOptions, 'project-example', 'branch-example');
    const connection = await readNeonDirectConnection(
      readOptions,
      'project-example',
      'branch-example',
      'community',
      'community_owner'
    );
    expect(verifyNeonDirectEndpoint(connection, endpoints, 'aws-us-east-2')).toEqual({
      id: 'ep-example-123',
      projectId: 'project-example',
      branchId: 'branch-example',
      regionId: 'aws-us-east-2',
      host: 'ep-example-123.us-east-2.aws.neon.tech',
      type: 'read_write',
    });
    expect(JSON.stringify(endpoints)).not.toContain('CANARY_PASSWORD');
    connection.credential.dispose();
  });

  it('rejects every mutation of trusted endpoint binding fields', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/neon/endpoints.json', import.meta.url), 'utf8')
    ) as unknown;
    const paths = [
      ['endpoints', 0, 'id'],
      ['endpoints', 0, 'project_id'],
      ['endpoints', 0, 'branch_id'],
      ['endpoints', 0, 'region_id'],
      ['endpoints', 0, 'host'],
      ['endpoints', 0, 'type'],
    ] as const;
    const executable = await fakeNeon(`printf '%s' "$FIXTURE_JSON"`);
    await Promise.all(
      mutateTrustedProviderFields(fixture, paths).map((mutation) =>
        expect(
          readNeonEndpoints(
            options(executable, { FIXTURE_JSON: JSON.stringify(mutation.value) }),
            'project-example',
            'branch-example'
          ),
          mutation.label
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      )
    );
  });
  it('uses the pinned machine-readable organization and project commands', async () => {
    const organizations = await fakeNeon(`
test "$1 $2 $3 $4" = "orgs list --output json" || exit 9
printf '%s' '[{"id":"org-example","name":"Dorian","handle":"dorian"}]'
`);
    await expect(readNeonOrganizations(options(organizations))).resolves.toEqual([
      { id: 'org-example', name: 'Dorian' },
    ]);

    const projects = await fakeNeon(`
test "$1 $2 $3 $4 $5 $6" = "projects list --org-id org-example --output json" || exit 9
printf '%s' '[{"id":"project-example","org_id":"org-example","name":"Community","region_id":"aws-us-east-2","pg_version":17,"proxy_host":"CANARY_SHOULD_NOT_ESCAPE"}]'
`);
    const result = await readNeonProjects(options(projects), 'org-example');
    expect(result).toEqual([
      {
        id: 'project-example',
        organizationId: 'org-example',
        name: 'Community',
        regionId: 'aws-us-east-2',
        postgresVersion: 17,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('CANARY_SHOULD_NOT_ESCAPE');
  });

  it('reads exact branch, database, and role identity without requesting credentials', async () => {
    const branches = await fakeNeon(`
test "$1 $2 $3 $4 $5 $6" = "branches list --project-id project-example --output json" || exit 9
printf '%s' '[{"id":"br-example","project_id":"project-example","name":"main","default":true,"current_state":"ready"}]'
`);
    await expect(readNeonBranches(options(branches), 'project-example')).resolves.toEqual([
      { id: 'br-example', projectId: 'project-example', name: 'main', isDefault: true },
    ]);

    const topology = await fakeNeon(`
case "$1 $2" in
  "databases list") printf '%s' '[{"id":"db-example","branch_id":"br-example","name":"community","owner_name":"community_owner","created_at":"2026-09-21T00:00:00Z"}]' ;;
  "roles list") printf '%s' '[{"branch_id":"br-example","name":"community_owner","created_at":"2026-09-21T00:00:00Z"}]' ;;
  *) exit 9 ;;
esac
test "$3 $4 $5 $6 $7 $8" = "--project-id project-example --branch br-example --output json" || exit 9
`);
    await expect(
      readNeonBranchTopology(options(topology), 'project-example', 'br-example')
    ).resolves.toEqual({
      databases: [
        {
          id: 'db-example',
          branchId: 'br-example',
          name: 'community',
          ownerName: 'community_owner',
        },
      ],
      roles: [{ branchId: 'br-example', name: 'community_owner' }],
    });
  });

  it('fails closed on duplicate IDs and terminal controls', async () => {
    const duplicate = await fakeNeon(
      `printf '%s' '[{"id":"org-example","name":"One"},{"id":"org-example","name":"Two"}]'`
    );
    await expect(readNeonOrganizations(options(duplicate))).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const control = await fakeNeon(
      `printf '%s' '[{"id":"project-example","org_id":"org-example","name":"bad\\u001b[2J","region_id":"aws-us-east-2","pg_version":17}]'`
    );
    await expect(readNeonProjects(options(control), 'org-example')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });

    const wrongOrganization = await fakeNeon(
      `printf '%s' '[{"id":"project-example","org_id":"org-other","name":"Community","region_id":"aws-us-east-2","pg_version":17}]'`
    );
    await expect(readNeonProjects(options(wrongOrganization), 'org-example')).rejects.toMatchObject(
      { code: 'INVALID_RESPONSE' }
    );
  });

  it('rejects every mutation of trusted project identity fields', async () => {
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/neon/projects.json', import.meta.url), 'utf8')
    ) as unknown;
    const paths = [
      [0, 'id'],
      [0, 'org_id'],
      [0, 'name'],
      [0, 'region_id'],
      [0, 'pg_version'],
    ] as const;
    const executable = await fakeNeon(`printf '%s' "$FIXTURE_JSON"`);
    await Promise.all(
      mutateTrustedProviderFields(fixture, paths).map((mutation) =>
        expect(
          readNeonProjects(
            options(executable, { FIXTURE_JSON: JSON.stringify(mutation.value) }),
            'org_fixture_01'
          ),
          mutation.label
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      )
    );
  });

  it('returns a redacting direct TLS credential bound to the requested topology', async () => {
    const canary = 'CANARY_NEON_PASSWORD';
    const executable = await fakeNeon(`
test "$*" = "connection-string br-example --project-id project-example --database-name community --role-name community_owner --no-pooled --ssl require" || exit 9
printf '%s' 'postgresql://community_owner:${canary}@ep-example-123.us-east-2.aws.neon.tech/community?sslmode=require&channel_binding=require'
`);
    const result = await readNeonDirectConnection(
      options(executable),
      'project-example',
      'br-example',
      'community',
      'community_owner'
    );
    expect(result.endpoint).toEqual({
      id: 'ep-example-123',
      host: 'ep-example-123.us-east-2.aws.neon.tech',
      projectId: 'project-example',
      branchId: 'br-example',
      databaseName: 'community',
      roleName: 'community_owner',
    });
    await expect(result.credential.use(async (url) => url.includes(canary))).resolves.toBe(true);
    expect(String(result.credential)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain(canary);
    result.credential.dispose();
    await expect(result.credential.use(async () => true)).rejects.toMatchObject({
      code: 'CREDENTIAL_DISPOSED',
      message: expect.not.stringContaining(canary),
    });
  });

  it.each([
    [
      'pooled host',
      'postgresql://community_owner:CANARY@ep-example-pooler.us-east-2.aws.neon.tech/community?sslmode=require&channel_binding=require',
    ],
    [
      'missing TLS mode',
      'postgresql://community_owner:CANARY@ep-example.us-east-2.aws.neon.tech/community?channel_binding=require',
    ],
    [
      'wrong role',
      'postgresql://other:CANARY@ep-example.us-east-2.aws.neon.tech/community?sslmode=require&channel_binding=require',
    ],
    [
      'wrong database',
      'postgresql://community_owner:CANARY@ep-example.us-east-2.aws.neon.tech/other?sslmode=require&channel_binding=require',
    ],
    [
      'missing endpoint identity',
      'postgresql://community_owner:CANARY@db.example.test/community?sslmode=require&channel_binding=require',
    ],
  ])('rejects a direct URL with %s without disclosing it', async (_label, url) => {
    const executable = await fakeNeon(`printf '%s' '${url}'`);
    await expect(
      readNeonDirectConnection(
        options(executable),
        'project-example',
        'br-example',
        'community',
        'community_owner'
      )
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.not.stringContaining('CANARY'),
    });
  });
});

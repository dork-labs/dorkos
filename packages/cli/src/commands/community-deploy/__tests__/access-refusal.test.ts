/** @vitest-environment node */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityCreationRefusedError,
  executeCommunityCreationPhase,
  type CommunityCreationDependencies,
} from '../execute.js';
import type { FlyAppProvenance } from '../fly-graphql-contract.js';
import { createFlyApp } from '../fly-mutate.js';
import { LaunchJournalSchema, type LaunchJournal } from '../journal.js';
import { createNeonProject } from '../neon-mutate.js';
import { createLaunchPlan } from '../plan.js';
import { ProviderMutationError, runProviderMutation } from '../provider-mutation.js';
import { isProviderAccessRefusal } from '../provider-process.js';
import { FLY_REFUSAL_OUTPUT, NEON_CREATE_OUTPUT, NEON_SCOPE_OUTPUT } from './fake-launch-tools.js';

const temporaryDirectories: string[] = [];
const network = 'dorkos-7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fakeProvider(source: string): Promise<{ executable: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-access-refusal-'));
  temporaryDirectories.push(directory);
  const executable = join(directory, 'provider');
  await writeFile(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable };
}

const options = (executable: string) => ({ executable, env: {}, timeoutMs: 10_000 });

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

describe('access refusals at a create (DOR-2656)', () => {
  // Catches a refusal shape that real flyctl or neonctl prints going unrecognised.
  it.each([
    FLY_REFUSAL_OUTPUT,
    'Error: unauthorized',
    '\u001b[31mError: \u001b[0munauthorized (Request ID: 01M3-ord) (Trace ID: 4bf92f3577b34da6)',
    'Error: forbidden',
    NEON_SCOPE_OUTPUT,
    NEON_CREATE_OUTPUT,
    `INFO: some notice\n${NEON_CREATE_OUTPUT}\n`,
  ])('recognises %j as a refusal', (stderr) => {
    expect(isProviderAccessRefusal(stderr)).toBe(true);
  });

  // Catches an over-broad rule: each of these says nothing certain about whether a create ran.
  it.each([
    '',
    'Error: context deadline exceeded',
    'Error: failed to create app: unauthorized',
    'Error: open /home/person/.fly/config.yml: permission denied',
    'Error: unauthorized to do that, but the app was saved',
    'Error: name has already been taken',
    'INFO: Authentication failed, deleting credentials...',
    'ERROR: Request timed out',
    'ERROR: internal server error',
    'error: unauthorized',
  ])('does not call %j a refusal', (stderr) => {
    expect(isProviderAccessRefusal(stderr)).toBe(false);
  });

  const failing = (stderr: string, exit = 1) =>
    fakeProvider(`printf '%s\n' '${stderr}' >&2\nexit ${exit}`);

  it('reports a refusal only to a create that opted in', async () => {
    const { executable } = await failing(FLY_REFUSAL_OUTPUT);
    const run = (refusalIsDefinite?: boolean) =>
      runProviderMutation({ ...options(executable), args: [], parse: () => 0, refusalIsDefinite });
    await expect(run(true)).rejects.toEqual(new ProviderMutationError('ACCESS_DENIED'));
    // Deploys, secrets and deletes share this boundary and never opt in.
    await expect(run()).rejects.toEqual(new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN'));
  });

  // Catches a timeout or an ambiguous exit being read as a refusal.
  it('keeps a timeout uncertain even when the output so far looked like a refusal', async () => {
    const { executable } = await fakeProvider(
      `printf '%s\n' '${FLY_REFUSAL_OUTPUT}' >&2\nexec sleep 5`
    );
    await expect(
      runProviderMutation({
        executable,
        env: {},
        timeoutMs: 200,
        args: [],
        parse: () => 0,
        refusalIsDefinite: true,
      })
    ).rejects.toEqual(new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN'));
  });

  it('keeps an ambiguous exit uncertain', async () => {
    const { executable } = await failing('Error: context deadline exceeded');
    await expect(
      runProviderMutation({
        ...options(executable),
        args: [],
        parse: () => 0,
        refusalIsDefinite: true,
      })
    ).rejects.toEqual(new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN'));
  });

  const neonInput = {
    organizationId: 'org-dorian',
    name: 'community-space',
    regionId: 'aws-us-east-2',
    databaseName: 'community',
    roleName: 'community_owner',
    postgresVersion: 17,
  };

  it('reports a refused Neon project create as ACCESS_DENIED', async () => {
    const { executable } = await failing(NEON_CREATE_OUTPUT);
    await expect(createNeonProject(options(executable), neonInput)).rejects.toEqual(
      new ProviderMutationError('ACCESS_DENIED')
    );
  });

  // Catches a garbled answer being excused by refusal-looking text beside it: exit 0 means Neon
  // answered, so the create may well have run.
  it('keeps a garbled Neon answer uncertain, whatever its error output says', async () => {
    const { executable } = await fakeProvider(
      `printf '%s\n' '${NEON_CREATE_OUTPUT}' >&2\nprintf '%s' '{"project":{"id":'`
    );
    await expect(createNeonProject(options(executable), neonInput)).rejects.toEqual(
      new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN')
    );
  });

  // flyctl creates the app, then waits for it; the wait can end in the same refusal. Catches the
  // refusal being trusted without the provenance read finding no app.
  it('trusts a Fly refusal only when the provenance read then finds no app', async () => {
    const { executable } = await failing(FLY_REFUSAL_OUTPUT);
    const create = (readProvenance: (name: string) => Promise<FlyAppProvenance | null>) =>
      createFlyApp(options(executable), 'community-space', 'dork-labs', network, readProvenance);

    await expect(create(async () => null)).rejects.toEqual(
      new ProviderMutationError('ACCESS_DENIED')
    );
    await expect(
      create(async () => {
        throw new Error('read failed');
      })
    ).rejects.toEqual(new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN'));
    await expect(create(async () => provenance({ network: 'default' }))).rejects.toEqual(
      new ProviderMutationError('CREATION_OUTCOME_UNCERTAIN')
    );
    await expect(create(async () => provenance())).resolves.toMatchObject({
      id: 'community-space',
      organizationSlug: 'dork-labs',
    });
  });
});

describe('a refused create in the creation phase (DOR-2656)', () => {
  const plan = createLaunchPlan({
    dorkosVersion: '0.76.0',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    fly: {
      organizationId: 'dork-labs',
      organizationName: 'Dork Labs',
      appName: 'dorkos-community-test',
      region: 'ord',
      machineSize: 'shared-cpu-1x',
    },
    neon: {
      organizationId: 'org-dorian',
      organizationName: 'Dorian',
      projectName: 'dorkos-community-test',
      region: 'aws-us-east-2',
    },
    tigris: { bucketName: 'dorkos-community-test', private: true },
  });

  function harness() {
    let persisted: LaunchJournal = LaunchJournalSchema.parse({
      schemaVersion: 1,
      runId: '11111111-1111-4111-8111-111111111111',
      revision: 0,
      planHash: 'b'.repeat(64),
      releaseDigest: plan.imageDigest,
      state: 'planned',
      pendingIntent: null,
      resources: {},
      verifiedBindings: [],
      completedSteps: ['planned'],
      lastSafeError: null,
      createdAt: '2026-09-21T00:00:00.000Z',
      updatedAt: '2026-09-21T00:00:00.000Z',
    });
    const network = { value: '' };
    const boundary = (id: string, organizationId: string, bindingId?: string) => ({
      create: vi.fn(async (marker: string) => {
        network.value = `dorkos-${marker}`;
        return { id, organizationId, name: 'dorkos-community-test', bindingId };
      }),
      inspect: vi.fn(async () => ({
        id,
        organizationId,
        name: 'dorkos-community-test',
        bindingId,
        provenance: { flyNetwork: network.value },
      })),
    });
    const value: CommunityCreationDependencies = {
      persist: vi.fn(async (next) => {
        persisted = LaunchJournalSchema.parse(next);
      }),
      fly: boundary('app-id', 'dork-labs'),
      neon: boundary('project-id', 'org-dorian'),
      tigris: boundary('bucket-id', 'dork-labs', 'app-id'),
      now: () => '2026-09-21T00:00:01.000Z',
      createProvenanceMarker: () => 'a'.repeat(32),
    };
    return { value, persisted: () => persisted };
  }

  // The refused create was recorded as uncertain, so the run offered a resume that could never
  // work. Catches a refusal reaching the uncertain path, for each service's create.
  it.each([
    ['fly', 'dork-labs', []],
    ['neon', 'org-dorian', ['fly_app_created']],
    ['tigris', 'dork-labs', ['fly_app_created', 'neon_project_created']],
  ] as const)(
    'records a refused %s create as an authorization stop, not an uncertain one',
    async (service, organizationId, before) => {
      const { value, persisted } = harness();
      vi.mocked(value[service].create).mockRejectedValue(
        new ProviderMutationError('ACCESS_DENIED')
      );

      const failure = await executeCommunityCreationPhase(plan, persisted(), value).catch(
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(CommunityCreationRefusedError);
      expect(failure).toMatchObject({
        service,
        organizationId,
        resourceName: 'dorkos-community-test',
      });
      expect(persisted()).toMatchObject({
        pendingIntent: null,
        lastSafeError: { category: 'authorization', code: 'ACCESS_DENIED' },
      });
      expect(persisted().state).not.toBe('uncertain');
      expect(persisted().completedSteps).toEqual(['planned', ...before]);
    }
  );
});

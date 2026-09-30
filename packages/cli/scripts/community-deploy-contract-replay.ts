/**
 * Read-only contract replay for the Community launcher: every Fly and Neon call the launcher and the
 * live gate make, sent to the real services and read back through the launcher's own parsers.
 *
 * Three paid live runs stopped on provider answers the fixtures had invented. This replay costs
 * nothing and answers, before a paid run, "does the launcher accept what the services really say?".
 * Run it with `pnpm --filter dorkos replay:community-contract`. It is not wired into any test,
 * turbo task or CI job, and it reads the operator's own signed-in `fly` and Neon profiles.
 *
 * Arms, each checked before any process starts:
 *
 * - `DORKOS_CONTRACT_REPLAY=1` with `DORKOS_CONTRACT_REPLAY_FLY_ORG` and
 *   `DORKOS_CONTRACT_REPLAY_NEON_ORG`: read-only calls only. Optional
 *   `DORKOS_CONTRACT_REPLAY_NEON_PROJECT` picks the existing Neon project whose branch, database,
 *   role and endpoint lists are read (default: the first project in the organization), and
 *   `DORKOS_CONTRACT_REPLAY_NEONCTL` names the Neon CLI (default `neonctl`).
 * - `DORKOS_CONTRACT_REPLAY_EMPTY_APP=1` additionally creates ONE empty Fly app named
 *   `dorkos-contract-<random>` (no image, no Machine, no volume, no IP, no storage), so the
 *   app-scoped calls have something to answer about: app create, secrets stage and list, `secrets
 *   deploy` (which refuses on an app with no Machines, proving its flags parse), Machines,
 *   releases, addresses, and destroy. The app is always destroyed and its absence verified. An
 *   empty Fly app has nothing that bills, which is why this is not a money path.
 *
 * Organizations: `dork-labs` is always refused. The empty app may be created only in an
 * organization on {@link EMPTY_APP_FLY_ORGS} (today just `personal`, the operator's own); adding one
 * is a reviewed change to that list, never a flag.
 *
 * Never run: anything that creates a Machine, a Neon project or a storage bucket, and any command
 * that prints a credential (`neonctl connection-string`). The Fly session token is read into the
 * launcher's redacting wrapper and never printed.
 *
 * Output: a table of call, where the launcher uses it, and whether the launcher's parser accepted
 * the real answer. With `DORKOS_CONTRACT_REPLAY_OUT=<dir>`, each answer's sanitized SHAPE (types
 * only, no value) is written there to regenerate fixtures from. With `--write-schema`, the trimmed
 * GraphQL schema snapshot the contract test checks against is regenerated from the live API.
 */
/* eslint-disable no-restricted-syntax -- A standalone operator script, like the live gate: its arms
   and choices are read from its own environment, and it runs outside any app's env.ts. */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import {
  createFlyApp,
  deployFlySecrets,
  destroyFlyApp,
  stageFlySecrets,
} from '../src/commands/community-deploy/fly-mutate.js';
import {
  readFlyApps,
  readFlyIdentity,
  readFlyOrganizationId,
  readFlyOrganizations,
  readFlyRegions,
  readFlyRuntimeInventory,
} from '../src/commands/community-deploy/fly-read.js';
import { FlyTigrisGraphqlClient } from '../src/commands/community-deploy/fly-graphql-client.js';
import {
  createProvenanceMarker,
  flyProvenanceNetwork,
} from '../src/commands/community-deploy/provenance/provenance-gate.js';
import {
  readNeonBranches,
  readNeonBranchTopology,
  readNeonEndpoints,
  readNeonOrganizations,
  readNeonProjects,
  readNeonRegions,
} from '../src/commands/community-deploy/neon-read.js';
import {
  readFlySecretInventory,
  readFlySessionCredential,
} from '../src/commands/community-deploy/tigris-session.js';
import { assertCommunityCliVersions } from '../src/commands/community-deploy/runtime/versions.js';
import {
  checkGraphqlDocument,
  FLY_INTROSPECTION_QUERY,
  FLY_SCHEMA_SNAPSHOT,
  LAUNCHER_GRAPHQL_DOCUMENTS,
  trimSchemaForDocuments,
  type IntrospectedSchema,
} from './community-deploy-contract-graphql.js';

/** Fly organizations the replay refuses outright, read-only calls included. */
const REFUSED_FLY_ORGS: readonly string[] = ['dork-labs'];

/** The only Fly organizations the empty app may be created in. */
export const EMPTY_APP_FLY_ORGS: readonly string[] = ['personal'];

/** Reduce a JSON answer to its shape: every value becomes its type name, keys are kept. */
function jsonShape(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [jsonShape(value[0])];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [
        key,
        jsonShape(inner),
      ])
    );
  }
  return typeof value;
}

interface Row {
  call: string;
  where: string;
  outcome: 'accepted' | 'rejected' | 'expected-refusal' | 'skipped';
  detail: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${name} must be set to a plain identifier`);
  }
  return value;
}

function safeCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'ERROR';
}

async function main(): Promise<void> {
  if (process.env.DORKOS_CONTRACT_REPLAY !== '1') {
    throw new Error('Set DORKOS_CONTRACT_REPLAY=1 to run the read-only contract replay.');
  }
  const flyOrg = required('DORKOS_CONTRACT_REPLAY_FLY_ORG');
  if (REFUSED_FLY_ORGS.includes(flyOrg)) {
    throw new Error(`The contract replay never runs against the ${flyOrg} organization.`);
  }
  if (
    process.env.DORKOS_CONTRACT_REPLAY_EMPTY_APP === '1' &&
    !EMPTY_APP_FLY_ORGS.includes(flyOrg)
  ) {
    throw new Error(
      `The empty app may only be created in: ${EMPTY_APP_FLY_ORGS.join(', ')}. Read-only runs may use any other.`
    );
  }
  const neonOrg = required('DORKOS_CONTRACT_REPLAY_NEON_ORG');
  const emptyApp = process.env.DORKOS_CONTRACT_REPLAY_EMPTY_APP === '1';
  const outDirectory = process.env.DORKOS_CONTRACT_REPLAY_OUT;
  const writeSchema = process.argv.includes('--write-schema');
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'FLY_CONFIG_DIR', 'XDG_CONFIG_HOME'].flatMap((name) =>
      typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : []
    )
  );
  const fly = { executable: 'fly', env, timeoutMs: 60_000 };
  const neon = {
    executable: process.env.DORKOS_CONTRACT_REPLAY_NEONCTL ?? 'neonctl',
    env,
    timeoutMs: 60_000,
  };
  const rows: Row[] = [];
  if (outDirectory) await mkdir(outDirectory, { recursive: true });

  /** Capture one raw answer's shape (never its values) for fixture regeneration. */
  const capture = async (name: string, executable: string, args: string[]) => {
    if (!outDirectory) return;
    const stdout = await new Promise<string>((done) =>
      execFile(executable, args, { env, maxBuffer: 16 * 1024 * 1024 }, (_error, out) =>
        done(String(out))
      )
    );
    let shape: unknown = 'not-json';
    try {
      shape = jsonShape(JSON.parse(stdout));
    } catch {
      // Recorded as not-json: a non-JSON answer to a --json command is itself a finding.
    }
    await writeFile(
      join(outDirectory, `${name}.shape.json`),
      `${JSON.stringify(shape, null, 2)}\n`
    );
  };

  const replay = async (
    call: string,
    where: string,
    run: () => Promise<string | void>,
    raw?: { name: string; executable: string; args: string[] }
  ) => {
    try {
      const detail = await run();
      rows.push({ call, where, outcome: 'accepted', detail: detail ?? '' });
    } catch (error) {
      rows.push({ call, where, outcome: 'rejected', detail: safeCode(error) });
    }
    if (raw) await capture(raw.name, raw.executable, raw.args).catch(() => undefined);
  };

  // --- CLI versions ---------------------------------------------------------------------------
  await replay('fly version --json; neonctl --version', 'runtime/versions.ts', () =>
    assertCommunityCliVersions(fly, neon, { fly: '0.4.104', neon: '5.0.0' })
  );

  // --- Fly CLI reads --------------------------------------------------------------------------
  await replay(
    'fly auth whoami --json',
    'fly-read.ts readFlyIdentity',
    async () => {
      await readFlyIdentity(fly);
    },
    { name: 'fly-auth-whoami', executable: 'fly', args: ['auth', 'whoami', '--json'] }
  );
  await replay(
    'fly orgs list --json',
    'fly-read.ts readFlyOrganizations',
    async () => {
      await readFlyOrganizations(fly);
    },
    { name: 'fly-orgs-list', executable: 'fly', args: ['orgs', 'list', '--json'] }
  );
  await replay(
    'fly orgs show <org> --json',
    'fly-read.ts readFlyOrganizationId',
    async () => {
      await readFlyOrganizationId(fly, flyOrg);
    },
    { name: 'fly-orgs-show', executable: 'fly', args: ['orgs', 'show', flyOrg, '--json'] }
  );
  await replay(
    'fly platform regions --json',
    'fly-read.ts readFlyRegions',
    async () => {
      await readFlyRegions(fly);
    },
    { name: 'fly-platform-regions', executable: 'fly', args: ['platform', 'regions', '--json'] }
  );
  await replay(
    'fly apps list --org <org> --json',
    'fly-read.ts readFlyApps; live gate',
    async () => {
      await readFlyApps(fly, flyOrg);
    },
    { name: 'fly-apps-list', executable: 'fly', args: ['apps', 'list', '--org', flyOrg, '--json'] }
  );

  // --- Fly session + GraphQL ------------------------------------------------------------------
  let credential: Awaited<ReturnType<typeof readFlySessionCredential>> | null = null;
  await replay(
    'fly auth token --json --quiet',
    'tigris-session.ts readFlySessionCredential',
    async () => {
      credential = await readFlySessionCredential(fly);
      return 'token held in the redacting wrapper, not printed';
    }
  );
  if (credential) {
    const held = credential as Awaited<ReturnType<typeof readFlySessionCredential>>;
    const client = (token: string) => new FlyTigrisGraphqlClient({ accessToken: token });
    await replay('GraphQL DorkosTigrisTerms', 'fly-graphql-client.ts hasAcceptedTerms', async () =>
      String(await held.use((token) => client(token).hasAcceptedTerms()))
    );
    // No bucket exists to read, so an id Fly has never issued proves the not-found answer the
    // launcher and the gate's cleanup must recognise.
    const unknownId = `A${randomBytes(10).toString('hex')}`;
    for (const [call, read] of [
      [
        'GraphQL DorkosReadTigris (unknown id)',
        (c: FlyTigrisGraphqlClient): Promise<unknown> => c.readTigris(unknownId),
      ],
      [
        'GraphQL DorkosReadTigrisCredentials (unknown id)',
        (c: FlyTigrisGraphqlClient): Promise<unknown> => c.readTigrisCredentials(unknownId),
      ],
    ] as const) {
      try {
        await held.use((token) => read(client(token)));
        rows.push({
          call,
          where: 'fly-graphql-client.ts',
          outcome: 'rejected',
          detail: 'no error',
        });
      } catch (error) {
        const code = safeCode(error);
        rows.push({
          call,
          where: 'fly-graphql-client.ts',
          outcome: code === 'ADD_ON_MISSING' ? 'expected-refusal' : 'rejected',
          detail: code,
        });
      }
    }
    // Every document, including the mutations this replay must not send, against the live schema.
    const schema = await held.use(async (token) => {
      const response = await fetch('https://api.fly.io/graphql', {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: FLY_INTROSPECTION_QUERY }),
      });
      const body = (await response.json()) as { data?: { __schema?: IntrospectedSchema } };
      if (!body.data?.__schema) throw new Error('introspection unavailable');
      return body.data.__schema;
    });
    for (const [name, document] of Object.entries(LAUNCHER_GRAPHQL_DOCUMENTS)) {
      const problems = checkGraphqlDocument(document, schema);
      rows.push({
        call: `GraphQL ${name} (schema)`,
        where: 'fly-graphql-contract.ts',
        outcome: problems.length === 0 ? 'accepted' : 'rejected',
        detail: problems.join('; '),
      });
    }
    if (writeSchema) {
      const trimmed = trimSchemaForDocuments(schema, Object.values(LAUNCHER_GRAPHQL_DOCUMENTS));
      await writeFile(FLY_SCHEMA_SNAPSHOT, `${JSON.stringify(trimmed, null, 2)}\n`);
    }
  }

  // --- Neon reads -----------------------------------------------------------------------------
  const neonctl = neon.executable;
  await replay(
    'neonctl orgs list',
    'neon-read.ts readNeonOrganizations',
    async () => {
      await readNeonOrganizations(neon);
    },
    { name: 'neon-orgs-list', executable: neonctl, args: ['orgs', 'list', '--output', 'json'] }
  );
  await replay(
    'neonctl api /regions',
    'neon-read.ts readNeonRegions',
    async () => {
      await readNeonRegions(neon);
    },
    { name: 'neon-regions', executable: neonctl, args: ['api', '/regions', '--output', 'json'] }
  );
  let projectId = process.env.DORKOS_CONTRACT_REPLAY_NEON_PROJECT;
  await replay(
    'neonctl projects list --org-id',
    'neon-read.ts readNeonProjects; live gate',
    async () => {
      const projects = await readNeonProjects(neon, neonOrg);
      projectId ??= projects[0]?.id;
    },
    {
      name: 'neon-projects-list',
      executable: neonctl,
      args: ['projects', 'list', '--org-id', neonOrg, '--output', 'json'],
    }
  );
  if (projectId) {
    const project = projectId;
    let branchId: string | undefined;
    await replay(
      'neonctl branches list',
      'neon-read.ts readNeonBranches',
      async () => {
        branchId = (await readNeonBranches(neon, project)).find((branch) => branch.isDefault)?.id;
      },
      {
        name: 'neon-branches-list',
        executable: neonctl,
        args: ['branches', 'list', '--project-id', project, '--output', 'json'],
      }
    );
    if (branchId) {
      const branch = branchId;
      const common = ['--project-id', project, '--branch', branch, '--output', 'json'];
      await replay(
        'neonctl databases list; roles list',
        'neon-read.ts readNeonBranchTopology',
        async () => {
          await readNeonBranchTopology(neon, project, branch);
        },
        { name: 'neon-databases-list', executable: neonctl, args: ['databases', 'list', ...common] }
      );
      await capture('neon-roles-list', neonctl, ['roles', 'list', ...common]).catch(
        () => undefined
      );
      await replay(
        'neonctl api …/endpoints',
        'neon-read.ts readNeonEndpoints',
        async () => {
          await readNeonEndpoints(neon, project, branch);
        },
        {
          name: 'neon-endpoints',
          executable: neonctl,
          args: ['api', `/projects/${project}/branches/${branch}/endpoints`, '--output', 'json'],
        }
      );
    }
  }

  // --- One empty Fly app, always destroyed ----------------------------------------------------
  if (emptyApp) {
    const appName = `dorkos-contract-${randomBytes(4).toString('hex')}`;
    const listed = async () => (await readFlyApps(fly, flyOrg)).some((app) => app.name === appName);
    // The name must be free first, so whatever carries it afterwards is this run's own app.
    if (await listed()) throw new Error(`${appName} already exists; nothing was created.`);
    let attempted = false;
    let created = false;
    // Runs once, from the finally below or from Ctrl-C / SIGTERM, whichever comes first. It
    // destroys only an app the org listing shows under this run's exact name, so a create whose
    // answer failed to parse is still cleaned up and nothing else can be.
    let removal: Promise<boolean> | undefined;
    const removeOwnApp = () =>
      (removal ??= (async () => {
        if (!attempted) return true;
        if (await listed()) {
          await replay('fly apps destroy --yes', 'fly-mutate.ts destroyFlyApp; live gate', () =>
            destroyFlyApp(fly, appName).then(() => undefined)
          );
        }
        const remaining = await listed();
        rows.push({
          call: 'empty app gone after destroy',
          where: 'replay cleanup',
          outcome: remaining ? 'rejected' : 'accepted',
          detail: remaining ? `${appName} still exists: destroy it by hand` : '',
        });
        return !remaining;
      })());
    const onSignal = (signal: NodeJS.Signals) => {
      void removeOwnApp()
        .catch(() => false)
        .then((gone) => {
          process.stderr.write(
            `Contract replay stopped by ${signal}; ${appName} ${gone ? 'was removed' : 'may still exist: destroy it by hand'}.\n`
          );
          process.exit(130);
        });
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      attempted = true;
      // Created the way the launcher creates it: on its own private network carrying a marker.
      const network = flyProvenanceNetwork(createProvenanceMarker());
      const readProvenance = async (name: string) => {
        const session = await readFlySessionCredential(fly);
        try {
          return await session.use((token) =>
            new FlyTigrisGraphqlClient({ accessToken: token }).readAppProvenance(name)
          );
        } finally {
          session.dispose();
        }
      };
      await replay(
        'fly apps create --network --json --yes',
        'fly-mutate.ts createFlyApp',
        async () => {
          await createFlyApp(fly, appName, flyOrg, network, readProvenance);
          created = true;
          return appName;
        }
      );
      if (created) {
        // The marker round trip: Fly keeps the requested network name and reports it back.
        await replay(
          'GraphQL DorkosReadAppProvenance',
          'fly-graphql-client.ts readAppProvenance',
          async () => {
            const app = await readProvenance(appName);
            if (!app || app.network !== network) throw new Error('network not read back');
            return 'network read back exactly';
          }
        );
      }
      if (created) {
        await replay(
          'fly machine list; releases; ips list',
          'fly-read.ts readFlyRuntimeInventory',
          async () => {
            const inventory = await readFlyRuntimeInventory(fly, appName);
            return `machines ${inventory.machines.length}, releases ${inventory.releases.length}, addresses ${inventory.addresses.length}`;
          },
          {
            name: 'fly-releases',
            executable: 'fly',
            args: ['releases', '--app', appName, '--json'],
          }
        );
        await capture('fly-machine-list', 'fly', ['machine', 'list', '--app', appName, '--json']);
        await capture('fly-ips-list', 'fly', ['ips', 'list', '--app', appName, '--json']);
        await replay('fly secrets import --stage', 'fly-mutate.ts stageFlySecrets', async () => {
          await stageFlySecrets(fly, appName, {
            DORKOS_CONTRACT_PROBE: randomBytes(16).toString('hex'),
          });
        });
        await replay(
          'fly secrets list --json',
          'tigris-session.ts readFlySecretInventory',
          async () => {
            const rows = await readFlySecretInventory(fly, appName);
            return rows.map((row) => `${row.name}:${row.status ?? 'none'}`).join(',');
          },
          {
            name: 'fly-secrets-list',
            executable: 'fly',
            args: ['secrets', 'list', '--app', appName, '--json'],
          }
        );
        // With no Machine, flyctl refuses after parsing its flags; an unknown flag would fail first.
        try {
          await deployFlySecrets(fly, appName);
          rows.push({
            call: 'fly secrets deploy --app',
            where: 'fly-mutate.ts deployFlySecrets',
            outcome: 'accepted',
            detail: '',
          });
        } catch (error) {
          const stderr = await new Promise<string>((done) =>
            execFile('fly', ['secrets', 'deploy', '--app', appName], { env }, (_e, _out, err) =>
              done(String(err))
            )
          );
          rows.push({
            call: 'fly secrets deploy --app',
            where: 'fly-mutate.ts deployFlySecrets',
            outcome: /no machines available/iu.test(stderr) ? 'expected-refusal' : 'rejected',
            detail: /unknown flag/iu.test(stderr) ? 'unknown flag' : safeCode(error),
          });
        }
      }
    } finally {
      await removeOwnApp();
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  } else {
    rows.push({
      call: 'app-scoped Fly calls',
      where: 'fly-read/fly-mutate',
      outcome: 'skipped',
      detail: 'set DORKOS_CONTRACT_REPLAY_EMPTY_APP=1',
    });
  }

  if (credential) (credential as { dispose(): void }).dispose();
  const width = Math.max(...rows.map((row) => row.call.length));
  for (const row of rows) {
    process.stdout.write(
      `${row.outcome.padEnd(16)} ${row.call.padEnd(width)}  ${row.where}${row.detail ? `  (${row.detail})` : ''}\n`
    );
  }
  if (rows.some((row) => row.outcome === 'rejected')) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `Contract replay failed: ${error instanceof Error ? error.message : 'unknown'}\n`
  );
  process.exitCode = 1;
});

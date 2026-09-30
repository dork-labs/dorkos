import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompatibleCommunityRelease } from '../release-resolver.js';
import { createInitialCommunityLaunchJournal } from '../resume.js';
import { initializeLaunchJournal, launchJournalPath } from '../journal.js';
import { createLaunchPlan } from '../plan.js';

// The prompts need a real terminal; everything a credential could travel through stays real.
vi.mock('../consent.js', () => ({
  requireCommunityLaunchConsent: vi.fn(async () => undefined),
  requireTigrisTermsAcceptance: vi.fn(async () => undefined),
}));
const ownerEnvs: Record<string, string>[] = [];
vi.mock('../runtime/default-owner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/default-owner.js')>()),
  assertOwnerHandoffPrerequisites: vi.fn(async (env: Record<string, string>) => {
    ownerEnvs.push(env);
  }),
  confirmOwnerClipboardWrite: vi.fn(async (env: Record<string, string>) => {
    ownerEnvs.push(env);
  }),
}));

const { runCommunityDispatcher } = await import('../community-dispatcher.js');

const MARK = 'dor2602_launch_sentinel';
const SENTINELS = {
  FLY_ACCESS_TOKEN: `FlyV1 fm2_${MARK}_access`,
  FLY_API_TOKEN: `FlyV1 fm2_${MARK}_api`,
  NEON_API_KEY: `napi_${MARK}_neon`,
};
const CREDENTIAL_NAMES = Object.keys(SENTINELS);
const APP = 'dorkos-community-test';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ownerEnvs.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function readTree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8'))
  );
}

async function fakeTools(bin: string, seenPath: string, statePath: string): Promise<void> {
  const manifest = {
    dorkosVersion: '0.76.0',
    image: {
      repository: 'ghcr.io/dork-labs/dorkos-community',
      digest: `sha256:${'a'.repeat(64)}`,
      platforms: [{ os: 'linux', architecture: 'amd64' }],
    },
    provenance: {
      repository: 'dork-labs/dorkos',
      workflowRef: 'dork-labs/dorkos/.github/workflows/publish-community.yml@refs/tags/v0.76.0',
    },
    configSchemaVersion: 1,
    migrationCompatibilityId: `sha256:${'b'.repeat(64)}`,
    minimumFlyctlVersion: '0.4.104',
    minimumNeonCliVersion: '5.0.0',
  };
  await writeFile(
    statePath,
    JSON.stringify({
      flyApp: null,
      flyNetwork: null,
      flyCreatedAt: null,
      neonProject: null,
      neonRole: null,
      secrets: {},
    })
  );
  // Each fake records WHICH credential variables arrived (booleans, never values). The fake
  // `fly auth token` answers as flyctl does: the first SET variable wins, scheme stripped, and an
  // empty one leaves the saved session in charge.
  const source = (name: string) => `#!${process.execPath}
const fs = require('node:fs');
const name = ${JSON.stringify(name)};
const statePath = ${JSON.stringify(statePath)};
const expected = ${JSON.stringify(SENTINELS)};
fs.appendFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ name, present: Object.keys(expected).filter((key) => key in process.env), exact: Object.keys(expected).filter((key) => process.env[key] === expected[key]) }) + '\\n');
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
let value;
if (name === 'gh' && args[0] === 'release') value = ${JSON.stringify(manifest)};
else if (name === 'gh') value = {};
else if (name === 'fly' && args[0] === 'auth' && args[1] === 'token') {
  const set = ['FLY_ACCESS_TOKEN', 'FLY_API_TOKEN'].find((key) => key in process.env);
  const token = set && process.env[set] ? process.env[set].replace(/^(FlyV1|Bearer) /, '') : 'fo1_saved_session';
  value = { token };
}
else if (name === 'fly' && args[0] === 'version') value = {Name:'fly',Version:'0.4.104'};
else if (name === 'fly' && args[0] === 'orgs' && args[1] === 'show') value = {ID:'fly-org-id',InternalNumericID:'1',Name:'Dork Labs',Slug:args[2],Type:'SHARED'};
else if (name === 'fly' && args[0] === 'orgs') value = {'dork-labs':'Dork Labs'};
else if (name === 'fly' && args[0] === 'platform') value = [{code:'ord',name:'Chicago',latitude:41.8,longitude:-87.6,gateway_available:true,requires_paid_plan:false,deprecated:false}];
else if (name === 'fly' && args[0] === 'apps' && args[1] === 'list') value = state.flyApp ? [state.flyApp] : [];
else if (name === 'fly' && args[0] === 'apps' && args[1] === 'create') { state.flyNetwork = at('--network'); state.flyCreatedAt = new Date().toISOString(); state.flyApp = {ID:args[2],Name:args[2],Status:'deployed',Network:'',Organization:{ID:'fly-org-id',Slug:at('--org'),Name:'Dork Labs'}}; save(); value = state.flyApp; }
else if (name === 'fly' && args[0] === 'secrets' && args[1] === 'list') value = Object.entries(state.secrets).map(([secret, item]) => ({name:secret,digest:item.digest,status:item.status}));
else if (name === 'fly' && args[0] === 'secrets' && args[1] === 'import') { const input = fs.readFileSync(0, 'utf8'); for (const line of input.trim().split('\\n')) { const secret = line.slice(0, line.indexOf('=')); state.secrets[secret] = {digest:'digest-' + secret.toLowerCase().replaceAll('_', '-'),status:'Staged'}; } save(); value = {}; }
else if (name === 'neonctl' && args[0] === '--version') { process.stdout.write('5.0.0'); process.exit(0); }
else if (name === 'neonctl' && args[0] === 'orgs') value = [{id:'org-dorian',name:'Dorian'}];
else if (name === 'neonctl' && args[0] === 'api' && args[1] === '/regions') value = {regions:[{region_id:'aws-us-east-2',name:'AWS US East 2',default:false,geo_lat:'40.4',geo_long:'-82.9'}]};
else if (name === 'neonctl' && args[0] === 'projects' && args[1] === 'list') value = state.neonProject ? [state.neonProject] : [];
else if (name === 'neonctl' && args[0] === 'projects' && args[1] === 'create') { state.neonRole = at('--role'); state.neonProject = {id:'neon-project-1',org_id:at('--org-id'),name:at('--name'),region_id:at('--region-id'),pg_version:Number(at('--pg-version')),created_at:new Date().toISOString()}; save(); value = {project: state.neonProject}; }
else if (name === 'neonctl' && args[0] === 'branches') value = [{id:'branch-1',project_id:'neon-project-1',name:'main',default:true}];
else if (name === 'neonctl' && args[0] === 'databases') value = [{id:4821907,branch_id:'branch-1',name:'community',owner_name:state.neonRole,created_at:'2026-09-21T00:00:00Z',updated_at:'2026-09-21T00:00:00Z'}];
else if (name === 'neonctl' && args[0] === 'roles') value = [{branch_id:'branch-1',name:state.neonRole}];
else if (name === 'neonctl' && args[0] === 'api' && args[1].endsWith('/endpoints')) value = {endpoints:[{id:'ep-fixture',project_id:'neon-project-1',branch_id:'branch-1',region_id:'aws-us-east-2',host:'ep-fixture.aws-us-east-2.aws.neon.tech',type:'read_write'}]};
else process.exit(3);
process.stdout.write(JSON.stringify(value));
`;
  for (const name of ['gh', 'fly', 'neonctl']) {
    await writeFile(join(bin, name), source(name));
    await chmod(join(bin, name), 0o755);
  }
}

describe('exported credentials on a real (fake-service) launch', () => {
  it('reach only fly and neonctl, sign GraphQL, and appear in no output, error or saved file', async () => {
    const bin = await temporary('dorkos-community-launch-bin-');
    const dorkHome = await temporary('dorkos-community-launch-home-');
    const seenPath = join(bin, 'seen.jsonl');
    const statePath = join(bin, 'state.json');
    await fakeTools(bin, seenPath, statePath);

    const authorizations: string[] = [];
    const tigris = {
      id: 'tigris-1',
      name: APP,
      status: 'ready',
      options: null,
      organization: { slug: 'dork-labs' },
      addOnProvider: { name: 'tigris' },
      app: { id: APP, name: APP },
    };
    let created = false;
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (String(input) !== 'https://api.fly.io/graphql') return new Response('', { status: 404 });
      authorizations.push(new Headers(init.headers).get('authorization') ?? '');
      const query = String((JSON.parse(String(init.body)) as { query: string }).query);
      if (query.includes('DorkosTigrisTerms')) {
        return json({ data: { viewer: { agreedToProviderTos: true } } });
      }
      if (query.includes('DorkosReadTigrisCredentials')) {
        return json({ data: { addOn: created ? { id: tigris.id, environment: null } : null } });
      }
      if (query.includes('DorkosCreateTigris')) {
        created = true;
        return json({
          data: {
            createAddOn: {
              addOn: {
                ...tigris,
                environment: {
                  AWS_ACCESS_KEY_ID: 'tid_fixture',
                  AWS_SECRET_ACCESS_KEY: 'tsec_fixture',
                  AWS_ENDPOINT_URL_S3: 'https://fly.storage.tigris.dev',
                  AWS_REGION: 'auto',
                  BUCKET_NAME: APP,
                },
              },
            },
          },
        });
      }
      if (query.includes('DorkosReadTigris'))
        return json({ data: { addOn: created ? tigris : null } });
      if (query.includes('DorkosReadAppProvenance')) {
        // The launch marker round trip reads the app Fly made, as the fake recorded it.
        const state = JSON.parse(await readFile(statePath, 'utf8')) as {
          flyApp: { ID: string; Name: string } | null;
          flyNetwork: string;
          flyCreatedAt: string;
          secrets: Record<string, unknown>;
        };
        if (!state.flyApp) {
          return json({ data: { app: null }, errors: [{ message: 'Could not find App' }] });
        }
        return json({
          data: {
            app: {
              id: state.flyApp.ID,
              internalNumericId: 4817203,
              name: state.flyApp.Name,
              network: state.flyNetwork,
              createdAt: state.flyCreatedAt,
              organization: { slug: 'dork-labs' },
              machines: { totalCount: 0 },
              volumes: { totalCount: 0 },
              ipAddresses: { totalCount: 0 },
              certificates: { totalCount: 0 },
              secrets: Object.keys(state.secrets).map((name) => ({ name })),
            },
          },
        });
      }
      return new Response('{}', { status: 500 });
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let failure: unknown = null;
    try {
      await runCommunityDispatcher(
        [
          'deploy',
          '--version',
          '0.76.0',
          '--fly-org',
          'dork-labs',
          '--fly-region',
          'ord',
          '--neon-org',
          'org-dorian',
          '--neon-region',
          'aws-us-east-2',
          '--app-name',
          APP,
        ],
        {
          cliVersion: '0.76.0',
          dorkHome,
          processEnv: { PATH: bin, ...SENTINELS },
          parseRelease: (bytes) =>
            JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
        }
      );
    } catch (error) {
      // The fakes stop at the image deploy; by then the journal and the GraphQL calls exist.
      failure = error;
    }

    const printed = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([value]) => String(value))
      .join('');
    // It got past creation: the bucket was made over GraphQL and the journal was written.
    expect(created).toBe(true);
    expect(authorizations.length).toBeGreaterThan(0);
    expect(new Set(authorizations)).toEqual(new Set([SENTINELS.FLY_ACCESS_TOKEN]));
    const saved = await readTree(dorkHome);
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.join('\n')).toContain('neon-project-1');

    expect(printed.match(/from your environment/gu)).toHaveLength(1);
    const seen = (await readFile(seenPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { name: string; present: string[]; exact: string[] });
    for (const tool of ['fly', 'neonctl']) {
      const calls = seen.filter(({ name }) => name === tool);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.exact.sort()).toEqual([...CREDENTIAL_NAMES].sort());
    }
    const ghCalls = seen.filter(({ name }) => name === 'gh');
    expect(ghCalls.length).toBeGreaterThan(0);
    for (const call of ghCalls) expect(call.present).toEqual([]);
    // The clipboard and browser-opener checks get the environment without any credential.
    expect(ownerEnvs.length).toBeGreaterThan(0);
    for (const env of ownerEnvs) {
      expect(Object.keys(env).filter((name) => CREDENTIAL_NAMES.includes(name))).toEqual([]);
    }

    const failureText =
      failure instanceof Error ? `${failure.message}\n${failure.stack ?? ''}` : String(failure);
    for (const text of [printed, failureText, ...saved]) expect(text).not.toContain(MARK);
  });

  it('names an exported credential on the removal path too, and prints no value', async () => {
    const dorkHome = await temporary('dorkos-community-removal-home-');
    const runId = '8b2f7c1e-4d3a-4e5f-9a6b-1c2d3e4f5a6b';
    const plan = createLaunchPlan({
      dorkosVersion: '0.76.0',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      fly: {
        organizationId: 'dork-labs',
        organizationName: 'Dork Labs',
        appName: APP,
        region: 'ord',
        machineSize: 'shared-cpu-1x',
      },
      neon: {
        organizationId: 'org-dorian',
        organizationName: 'Dorian',
        projectName: APP,
        region: 'aws-us-east-2',
      },
      tigris: { bucketName: APP, private: true },
    });
    await initializeLaunchJournal(
      launchJournalPath(dorkHome, runId),
      createInitialCommunityLaunchJournal(runId, plan, '2026-09-21T00:00:00.000Z')
    );
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      runCommunityDispatcher(['deploy', '--remove-uncertain', runId], {
        cliVersion: '0.76.0',
        dorkHome,
        processEnv: { PATH: '', ...SENTINELS },
        parseRelease: () => {
          throw new Error('unused');
        },
      })
    ).resolves.toBe(0);

    const printed = stdout.mock.calls.map(([value]) => String(value)).join('');
    expect(printed.match(/from your environment/gu)).toHaveLength(1);
    expect(printed).toContain('This run has no unresolved resource.');
    expect(printed).not.toContain(MARK);
  });
});

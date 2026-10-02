/**
 * Fake `gh`, `fly` and `neonctl` executables, and a fake Fly GraphQL endpoint, for tests that run
 * the whole `dorkos community deploy` dispatcher without contacting any service.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What the fakes do instead of answering normally. Unset keys answer normally. */
export interface FakeLaunchBehavior {
  /**
   * `fly apps create`: `refuse` exits 1 with Fly's refusal and makes nothing; `refuse-after-create`
   * makes the app and then exits with the same refusal (flyctl's wait after a create can end so);
   * `garble` makes nothing and prints cut-off JSON.
   */
  flyCreate?: 'refuse' | 'refuse-after-create' | 'garble';
  /** `fly orgs list`: exits 1 with Fly's refusal. */
  flyOrgs?: 'refuse';
  /** `neonctl orgs list`: exits 1 with Neon's answer to a project-scoped key. */
  neonOrgs?: 'refuse';
  /** `neonctl projects create`: exits 1 with Neon's answer to a project-scoped key. */
  neonCreate?: 'refuse';
}

/** The exact refusal flyctl v0.4.110 printed for `fly apps create` in DOR-2170 L3. */
export const FLY_REFUSAL_OUTPUT =
  'Error: unauthorized (Request ID: 01M3VSEFZKG3Q04042S4814NXE-ord)';
/** Neon's answer to a project-scoped key reading outside its project (DOR-2170 L3). */
export const NEON_SCOPE_OUTPUT =
  'ERROR: not allowed to perform actions outside the project this key is scoped to';
/** Neon's answer to a project-scoped key creating a project (DOR-2170 L3). */
export const NEON_CREATE_OUTPUT = 'ERROR: project-scoped keys are not allowed to create projects';

const MANIFEST = {
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

/**
 * Write the three fakes into `bin`, sharing one state file.
 *
 * @param bin - Directory to put on `PATH`.
 * @param seenPath - JSON-lines file each call appends to: which credential variables arrived
 *   (names only) and which held exactly the expected value.
 * @param statePath - The fakes' shared state.
 * @param credentials - Expected credential values, by variable name.
 * @param behavior - Failures to answer with instead.
 */
export async function writeFakeLaunchTools(
  bin: string,
  seenPath: string,
  statePath: string,
  credentials: Readonly<Record<string, string>>,
  behavior: FakeLaunchBehavior = {}
): Promise<void> {
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
  // The fake `fly auth token` answers as flyctl does: the first SET variable wins, scheme
  // stripped, and an empty one leaves the saved session in charge.
  const source = (name: string) => `#!${process.execPath}
const fs = require('node:fs');
const name = ${JSON.stringify(name)};
const statePath = ${JSON.stringify(statePath)};
const expected = ${JSON.stringify(credentials)};
const behavior = ${JSON.stringify(behavior)};
fs.appendFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ name, present: Object.keys(expected).filter((key) => key in process.env), exact: Object.keys(expected).filter((key) => process.env[key] === expected[key]) }) + '\\n');
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const fail = (line) => { process.stderr.write(line + '\\n'); process.exit(1); };
let value;
if (name === 'gh' && args[0] === 'release') value = ${JSON.stringify(MANIFEST)};
else if (name === 'gh') value = {};
else if (name === 'fly' && args[0] === 'auth' && args[1] === 'token') {
  const set = ['FLY_ACCESS_TOKEN', 'FLY_API_TOKEN'].find((key) => key in process.env);
  const token = set && process.env[set] ? process.env[set].replace(/^(FlyV1|Bearer) /, '') : 'fo1_saved_session';
  value = { token };
}
else if (name === 'fly' && args[0] === 'version') value = {Name:'fly',Version:'0.4.104'};
else if (name === 'fly' && args[0] === 'orgs' && args[1] === 'show') value = {ID:'fly-org-id',InternalNumericID:'1',Name:'Dork Labs',Slug:args[2],Type:'SHARED'};
else if (name === 'fly' && args[0] === 'orgs') { if (behavior.flyOrgs === 'refuse') fail(${JSON.stringify(FLY_REFUSAL_OUTPUT)}); value = {'dork-labs':'Dork Labs'}; }
else if (name === 'fly' && args[0] === 'platform') value = [{code:'ord',name:'Chicago',latitude:41.8,longitude:-87.6,gateway_available:true,requires_paid_plan:false,deprecated:false}];
else if (name === 'fly' && args[0] === 'apps' && args[1] === 'list') value = state.flyApp ? [state.flyApp] : [];
else if (name === 'fly' && args[0] === 'apps' && args[1] === 'create') {
  if (behavior.flyCreate === 'refuse') fail(${JSON.stringify(FLY_REFUSAL_OUTPUT)});
  if (behavior.flyCreate === 'garble') { process.stdout.write('{"ID":"' + args[2] + '","Na'); process.exit(0); }
  state.flyNetwork = at('--network'); state.flyCreatedAt = new Date().toISOString(); state.flyApp = {ID:args[2],Name:args[2],Status:'deployed',Network:'',Organization:{ID:'fly-org-id',Slug:at('--org'),Name:'Dork Labs'}}; save();
  if (behavior.flyCreate === 'refuse-after-create') fail(${JSON.stringify(FLY_REFUSAL_OUTPUT)});
  value = state.flyApp;
}
else if (name === 'fly' && args[0] === 'secrets' && args[1] === 'list') value = Object.entries(state.secrets).map(([secret, item]) => ({name:secret,digest:item.digest,status:item.status}));
else if (name === 'fly' && args[0] === 'secrets' && args[1] === 'import') { const input = fs.readFileSync(0, 'utf8'); for (const line of input.trim().split('\\n')) { const secret = line.slice(0, line.indexOf('=')); state.secrets[secret] = {digest:'digest-' + secret.toLowerCase().replaceAll('_', '-'),status:'Staged'}; } save(); value = {}; }
else if (name === 'neonctl' && args[0] === '--version') { process.stdout.write('5.0.0'); process.exit(0); }
else if (name === 'neonctl' && args[0] === 'orgs') { if (behavior.neonOrgs === 'refuse') fail(${JSON.stringify(NEON_SCOPE_OUTPUT)}); value = [{id:'org-dorian',name:'Dorian'}]; }
else if (name === 'neonctl' && args[0] === 'api' && args[1] === '/regions') value = {regions:[{region_id:'aws-us-east-2',name:'AWS US East 2',default:false,geo_lat:'40.4',geo_long:'-82.9'}]};
else if (name === 'neonctl' && args[0] === 'projects' && args[1] === 'list') value = state.neonProject ? [state.neonProject] : [];
else if (name === 'neonctl' && args[0] === 'projects' && args[1] === 'create') { if (behavior.neonCreate === 'refuse') fail(${JSON.stringify(NEON_CREATE_OUTPUT)}); state.neonRole = at('--role'); state.neonProject = {id:'neon-project-1',org_id:at('--org-id'),name:at('--name'),region_id:at('--region-id'),pg_version:Number(at('--pg-version')),created_at:new Date().toISOString()}; save(); value = {project: state.neonProject}; }
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

/** What the fake Fly GraphQL endpoint saw. */
export interface FakeFlyGraphql {
  /** Every Authorization header sent. */
  authorizations: string[];
  /** Whether a Tigris bucket was created. */
  tigrisCreated(): boolean;
  /** The `fetch` to stub globally. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * A fake of the Fly GraphQL operations the launch uses, reading the app the fake `fly` made.
 *
 * @param statePath - The fakes' shared state file.
 * @param appName - The planned app and bucket name.
 */
export function fakeFlyGraphql(statePath: string, appName: string): FakeFlyGraphql {
  const authorizations: string[] = [];
  const tigris = {
    id: 'tigris-1',
    name: appName,
    status: 'ready',
    options: null,
    organization: { slug: 'dork-labs' },
    addOnProvider: { name: 'tigris' },
    app: { id: appName, name: appName },
  };
  let created = false;
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
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
                BUCKET_NAME: appName,
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
        // Fly's answer for an unknown app name, as in `fixtures/fly/app-provenance-missing.json`.
        return json({
          data: { app: null },
          errors: [
            { message: 'Could not find App', path: ['app'], extensions: { code: 'NOT_FOUND' } },
          ],
        });
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
  };
  return { authorizations, tigrisCreated: () => created, fetch };
}

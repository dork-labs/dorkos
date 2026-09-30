import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import {
  checkGraphqlDocument,
  FLY_SCHEMA_SNAPSHOT,
  type IntrospectedSchema,
} from './community-deploy-contract-graphql.js';

const root = resolve(import.meta.dirname, '../../..');
const cliPackage = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'dorkos-community-package-'));
const version = JSON.parse(await readFile(join(cliPackage, 'package.json'), 'utf8'))
  .version as string;
// A two-platform OCI index like the one the release workflow pushes. The release manifest pins
// the index by its own hash (as a real one does), and carries no per-platform digests (as 0.92.0's
// does not), so the launcher must read the index from the registry, which the bootstrap below
// serves offline, and prove the deploy against the linux/amd64 manifest Fly reports (DOR-2586).
const platformDigest = `sha256:${'6'.repeat(64)}`;
const imageIndex = Buffer.from(
  JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: platformDigest,
        size: 1813,
        platform: { architecture: 'amd64', os: 'linux' },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${'7'.repeat(64)}`,
        size: 1813,
        platform: { architecture: 'arm64', os: 'linux' },
      },
    ],
  })
);
const imageDigest = `sha256:${createHash('sha256').update(imageIndex).digest('hex')}`;
const appName = `dorkos-package-${randomUUID().slice(0, 8)}`;
const dorkHome = join(temporary, 'dork-home');
const fakeHome = join(temporary, 'home');
const fakeBin = join(temporary, 'bin');
const statePath = join(temporary, 'provider-state.json');
// Every GraphQL document the packaged launcher sends, checked afterwards against Fly's schema.
const graphqlLogPath = join(temporary, 'graphql-documents.jsonl');
// Scoped credentials a person might export (DOR-2602). Setup must hand each to `fly` or `neonctl`
// and write none of them anywhere. They share one mark, so one search finds any of them.
const CREDENTIAL_MARK = 'dor2602_package_sentinel';
const CREDENTIAL_SENTINELS = {
  FLY_ACCESS_TOKEN: `FlyV1 fm2_${CREDENTIAL_MARK}_access`,
  FLY_API_TOKEN: `FlyV1 fm2_${CREDENTIAL_MARK}_api`,
  NEON_API_KEY: `napi_${CREDENTIAL_MARK}_neon`,
};
// Which credential variables reached each fake, as booleans, and the Authorization header of
// every GraphQL request. The launcher writes neither; these are the proof's own records.
const credentialLogPath = join(temporary, 'credential-env.jsonl');
const authorizationLogPath = join(temporary, 'graphql-authorization.jsonl');

async function migrationCompatibilityId(): Promise<string> {
  const hash = createHash('sha256');
  const directory = join(root, 'apps/community/migrations');
  const filenames = (await readdir(directory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  for (const filename of filenames) {
    hash.update(filename);
    hash.update('\0');
    hash.update(await readFile(join(directory, filename)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

const manifest = {
  formatVersion: 1,
  dorkosVersion: version,
  image: {
    repository: 'ghcr.io/dork-labs/dorkos-community',
    digest: imageDigest,
    platforms: [
      { os: 'linux', architecture: 'amd64' },
      { os: 'linux', architecture: 'arm64' },
    ],
  },
  configSchemaVersion: 1,
  migrationCompatibilityId: await migrationCompatibilityId(),
  minimumFlyctlVersion: '0.4.104',
  minimumNeonCliVersion: '5.0.0',
  provenance: {
    repository: 'dork-labs/dorkos',
    workflowRef: `dork-labs/dorkos/.github/workflows/publish-community.yml@refs/tags/v${version}`,
  },
};

const initialState = {
  flyCreates: 0,
  neonCreates: 0,
  tigrisCreates: 0,
  flyApp: null,
  flyNetwork: null,
  flyCreatedAt: null,
  neonProject: null,
  neonRole: null,
  tigris: null,
  // Fly sets no secrets when it creates a bucket (DOR-2559): the launcher must stage them itself.
  secrets: {},
  stagedValues: {},
  deployed: false,
  imageDigest: null,
  registryReads: 0,
  config: null,
};

const TIGRIS_ENVIRONMENT = {
  AWS_ACCESS_KEY_ID: 'tid_package_fixture',
  AWS_SECRET_ACCESS_KEY: 'tsec_package_fixture_value',
  AWS_ENDPOINT_URL_S3: 'https://fly.storage.tigris.dev',
  AWS_REGION: 'auto',
  BUCKET_NAME: appName,
};

const commonPrelude = `
const fs=require('node:fs');
const statePath=${JSON.stringify(statePath)};
const read=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));
const write=(value)=>fs.writeFileSync(statePath,JSON.stringify(value));
const args=process.argv.slice(2);
const at=(flag)=>args[args.indexOf(flag)+1];
const recordCredentials=(bin)=>fs.appendFileSync(${JSON.stringify(credentialLogPath)},JSON.stringify({bin,got:Object.fromEntries(Object.entries(${JSON.stringify(CREDENTIAL_SENTINELS)}).map(([name,value])=>[name,process.env[name]===value]))})+'\\n');
`;

const flyFixture = `#!${process.execPath}
${commonPrelude}
const state=read();
recordCredentials('fly');
// As flyctl does: the first SET token variable wins over the saved session (an empty one leaves
// the session in charge), printed without its scheme.
const flyTokenVariable=['FLY_ACCESS_TOKEN','FLY_API_TOKEN'].find((name)=>name in process.env);
if(args[0]==='auth'&&args[1]==='token'&&flyTokenVariable&&process.env[flyTokenVariable]) { process.stdout.write(JSON.stringify({token:process.env[flyTokenVariable].replace(/^(FlyV1|Bearer) /,'')})); process.exit(0); }
let value;
if(args[0]==='version') value={Name:'fly',Version:'0.4.104'};
else if(args[0]==='orgs'&&args[1]==='show') value={ID:'fly-org-id',InternalNumericID:'1',Name:'Dork Labs',Slug:args[2],Type:'SHARED'};
else if(args[0]==='orgs') value={'dork-labs':'Dork Labs'};
else if(args[0]==='platform') value=[{code:'ord',name:'Chicago',latitude:41.8,longitude:-87.6,gateway_available:true,requires_paid_plan:false,deprecated:false}];
else if(args[0]==='apps'&&args[1]==='list') value=state.flyApp?[state.flyApp]:[];
else if(args[0]==='apps'&&args[1]==='create') { state.flyCreates++; state.flyNetwork=at('--network'); state.flyCreatedAt=new Date().toISOString(); state.flyApp={ID:args[2],Name:args[2],Status:'deployed',Network:'',Organization:{ID:'fly-org-id',Slug:at('--org'),Name:'Dork Labs'}}; write(state); if(state.failFlyCreate) process.exit(1); value=state.flyApp; }
else if(args[0]==='apps'&&args[1]==='destroy') { state.flyDestroys=(state.flyDestroys??0)+1; state.flyApp=null; write(state); value={}; }
else if(args[0]==='auth'&&args[1]==='token') value={token:'fixture-fly-token'};
else if(args[0]==='secrets'&&args[1]==='list') value=Object.entries(state.secrets).map(([name,item])=>({name,digest:item.digest,status:item.status}));
else if(args[0]==='secrets'&&args[1]==='import') { const input=fs.readFileSync(0,'utf8'); for(const line of input.trim().split('\\n')) { const name=line.slice(0,line.indexOf('=')); state.stagedValues[name]=line.slice(line.indexOf('=')+1); state.secrets[name]={digest:'digest-'+name.toLowerCase().replaceAll('_','-')+'-'+Date.now(),status:'Staged'}; } write(state); value={}; }
else if(args[0]==='secrets'&&args[1]==='deploy'&&args.some((arg)=>!['secrets','deploy','--app',at('--app'),'--detach'].includes(arg))) { process.stderr.write('Error: unknown flag'); process.exit(1); }
else if(args[0]==='secrets'&&args[1]==='deploy') { for(const item of Object.values(state.secrets)) item.status='Deployed'; write(state); value={}; }
else if(args[0]==='deploy') { state.deployed=true; state.imageDigest=at('--image').split('@')[1]; state.config=fs.readFileSync(at('--config'),'utf8'); for(const item of Object.values(state.secrets)) item.status='Deployed'; write(state); value={}; }
else if(args[0]==='machine') value=state.deployed?[{id:'machine-1',name:'machine-1',state:'started',region:'ord',image_ref:{digest:state.imageDigest===${JSON.stringify(imageDigest)}?${JSON.stringify(platformDigest)}:state.imageDigest,registry:'ghcr.io',repository:'dork-labs/dorkos-community'},checks:[{name:'http',status:'passing'}]}]:[];
else if(args[0]==='releases') value=state.deployed?[{ID:'release-1',ImageRef:'ghcr.io/dork-labs/dorkos-community@'+(state.imageDigest===${JSON.stringify(imageDigest)}?${JSON.stringify(platformDigest)}:state.imageDigest),Status:'complete',Stable:false,Version:1}]:[];
else if(args[0]==='ips') value=state.deployed?[{ID:'',Address:'1.2.3.4',Type:'shared_v4',Region:'',CreatedAt:'2026-09-21T00:00:00Z',ServiceName:'',Network:null}]:[];
else process.exit(3);
process.stdout.write(JSON.stringify(value));
`;

const neonFixture = `#!${process.execPath}
${commonPrelude}
const state=read();
recordCredentials('neonctl');
let value;
if(args[0]==='--version') { process.stdout.write('5.0.0'); process.exit(0); }
else if(args[0]==='orgs') value=[{id:'org-dorian',name:'Dorian'}];
else if(args[0]==='api'&&args[1]==='/regions') value={regions:[{region_id:'aws-us-east-2',name:'AWS US East 2',default:false,geo_lat:'40.4',geo_long:'-82.9'}]};
else if(args[0]==='projects'&&args[1]==='list') value=state.neonProject?[state.neonProject]:[];
else if(args[0]==='projects'&&args[1]==='create') { state.neonCreates++; state.neonRole=at('--role'); state.neonProject={id:'neon-project-1',org_id:at('--org-id'),name:at('--name'),region_id:at('--region-id'),pg_version:Number(at('--pg-version')),created_at:new Date().toISOString()}; write(state); value={project:state.neonProject}; }
else if(args[0]==='branches') value=[{id:'branch-1',project_id:'neon-project-1',name:'main',default:true}];
else if(args[0]==='databases') value=[{id:4821907,branch_id:'branch-1',name:'community',owner_name:state.neonRole,created_at:'2026-09-21T00:00:00Z',updated_at:'2026-09-21T00:00:00Z'}];
else if(args[0]==='roles') value=[{branch_id:'branch-1',name:state.neonRole}];
else if(args[0]==='api'&&args[1].endsWith('/endpoints')) value={endpoints:[{id:'ep-fixture',project_id:'neon-project-1',branch_id:'branch-1',region_id:'aws-us-east-2',host:'ep-fixture.aws-us-east-2.aws.neon.tech',type:'read_write'}]};
else if(args[0]==='connection-string') { if(at('--role-name')!==state.neonRole) process.exit(4); process.stdout.write('postgresql://'+state.neonRole+':fixture-password@ep-fixture.aws-us-east-2.aws.neon.tech/community?sslmode=require&channel_binding=require'); process.exit(0); }
else process.exit(3);
process.stdout.write(JSON.stringify(value));
`;

const ghFixture = `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='release') process.stdout.write(${JSON.stringify(JSON.stringify(manifest))});
else if(args[0]==='attestation') process.stdout.write('{}');
else process.exit(3);
`;

const harmlessFixture = `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.exit(0));setTimeout(()=>process.exit(0),20);\n`;
const bootstrap = `
import fs from 'node:fs';
const statePath=${JSON.stringify(statePath)};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
// The keys Fly hands out only in the create answer, as flyctl reads them (synthetic values).
const TIGRIS_ENVIRONMENT=${JSON.stringify(TIGRIS_ENVIRONMENT)};
globalThis.fetch=async (input,init={})=>{
  const url=String(input);
  if(url==='https://api.fly.io/graphql') fs.appendFileSync(${JSON.stringify(authorizationLogPath)},JSON.stringify(new Headers(init.headers).get('authorization'))+'\\n');
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  if(url.endsWith('/health')) return json({status:'ok'});
  // The registry, offline: an anonymous pull token, then the index by its attested digest.
  if(url.startsWith('https://ghcr.io/token?')) return json({token:'anonymous-pull'});
  if(url==='https://ghcr.io/v2/dork-labs/dorkos-community/manifests/${imageDigest}') { state.registryReads++; fs.writeFileSync(statePath,JSON.stringify(state)); return new Response(Buffer.from(${JSON.stringify(imageIndex.toString('base64'))},'base64'),{status:200,headers:{'content-type':'application/vnd.oci.image.index.v1+json'}}); }
  if(url.startsWith('https://ghcr.io/')) return new Response('',{status:404});
  if(url.endsWith('/api/v1/community')) return json({},404);
  const body=JSON.parse(String(init.body??'{}'));
  const query=String(body.query??'');
  fs.appendFileSync(${JSON.stringify(graphqlLogPath)},JSON.stringify(query)+'\\n');
  if(query.includes('DorkosTigrisTerms')) return json({data:{viewer:{agreedToProviderTos:true}}});
  if(query.includes('DorkosReadTigrisCredentials')) return json({data:{addOn:state.tigris?{id:state.tigris.id,environment:null}:null}});
  if(query.includes('DorkosCreateTigris')) { state.tigrisCreates++; state.tigris={id:'tigris-1',name:${JSON.stringify(appName)},status:'ready',options:null,organization:{slug:'dork-labs'},addOnProvider:{name:'tigris'},app:{id:${JSON.stringify(appName)},name:${JSON.stringify(appName)}}}; fs.writeFileSync(statePath,JSON.stringify(state)); return json({data:{createAddOn:{addOn:{...state.tigris,environment:TIGRIS_ENVIRONMENT}}}}); }
  if(query.includes('DorkosReadTigris')) return json({data:{addOn:state.tigris}});
  if(query.includes('DorkosAppNameAvailable')) return json({data:{appNameAvailable:!state.flyApp}});
  if(query.includes('DorkosReadAppProvenance')) {
    const app=state.flyApp;
    if(!app||app.Name!==body.variables?.name) return json({data:{app:null},errors:[{message:'Could not find App'}]});
    return json({data:{app:{id:app.ID,internalNumericId:4817203,name:app.Name,network:state.flyNetwork,createdAt:state.flyCreatedAt,organization:{slug:app.Organization.Slug},machines:{totalCount:state.deployed?1:0},volumes:{totalCount:0},ipAddresses:{totalCount:state.deployed?1:0},certificates:{totalCount:0},secrets:Object.keys(state.secrets).map((name)=>({name}))}}});
  }
  return json({},500);
};
`;

function args(extra: string[] = []): string[] {
  return [
    'community',
    'deploy',
    '--version',
    version,
    '--fly-org',
    'dork-labs',
    '--fly-region',
    'ord',
    '--neon-org',
    'org-dorian',
    '--neon-region',
    'aws-us-east-2',
    '--app-name',
    appName,
    ...extra,
  ];
}

function runPlain(binary: string, commandArgs: string[], environment: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; output: string }>((resolvePromise, reject) => {
    const child = spawn(binary, commandArgs, {
      env: environment,
      cwd: temporary,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, output }));
  });
}

function runInteractive(
  helper: string,
  binary: string,
  commandArgs: string[],
  environment: NodeJS.ProcessEnv
) {
  return new Promise<{ code: number; output: string }>((resolvePromise, reject) => {
    const child = spawn('python3', [helper, process.execPath, binary, ...commandArgs], {
      cwd: temporary,
      env: { ...environment, COMMUNITY_PROOF_APP_NAME: appName },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => (output += String(data)));
    child.stderr.on('data', (data) => (output += String(data)));
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Packaged Community command timed out'));
    }, 30_000);
    timer.unref();
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise({ code: exitCode ?? -1, output });
    });
  });
}

try {
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await writeFile(statePath, JSON.stringify(initialState));
  for (const [name, source] of [
    ['fly', flyFixture],
    ['neonctl', neonFixture],
    ['gh', ghFixture],
    ['open', harmlessFixture],
    ['pbcopy', harmlessFixture],
  ] as const) {
    const path = join(fakeBin, name);
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
  const bootstrapPath = join(temporary, 'bootstrap.mjs');
  await writeFile(bootstrapPath, bootstrap);
  const interactiveHelper = join(temporary, 'interactive.py');
  await writeFile(
    interactiveHelper,
    `import os,pty,select,sys\napp=os.environ['COMMUNITY_PROOF_APP_NAME']\npid,fd=pty.fork()\nif pid==0: os.execve(sys.argv[1],sys.argv[1:],os.environ)\nout=b''; sent=set()\nwhile True:\n r,_,_=select.select([fd],[],[],1)\n if fd in r:\n  try: chunk=os.read(fd,4096)\n  except OSError: break\n  if not chunk: break\n  out+=chunk; os.write(1,chunk)\n  text=out.decode('utf8','replace')\n  if 'consent' not in sent and ('Type '+app+' to create these resources:') in text: os.write(fd,(app+'\\r').encode()); sent.add('consent')\n  if 'clipboard-test' not in sent and 'Type COPY TEST to replace your current clipboard' in text: os.write(fd,b'COPY TEST\\r'); sent.add('clipboard-test')\n  if 'copy' not in sent and 'Type copy:' in text: os.write(fd,b'copy\\r'); sent.add('copy')\n  if 'continue' not in sent and 'then press Enter to verify it.' in text: os.write(fd,b'\\r'); sent.add('continue')\n  if 'remove' not in sent and 'Type the internal id to remove it' in text: os.write(fd,b'4817203\\r'); sent.add('remove')\n_,status=os.waitpid(pid,0)\nsys.exit(os.waitstatus_to_exitcode(status))\n`
  );

  execFileSync('pnpm', ['--filter', 'dorkos', 'build'], { cwd: root, stdio: 'inherit' });
  const tarballOutput = execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
    cwd: cliPackage,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .at(-1)!;
  const tarball = resolve(cliPackage, tarballOutput);
  const install = join(temporary, 'install');
  execFileSync('npm', ['install', '--prefix', install, '--no-audit', '--no-fund', tarball], {
    cwd: temporary,
    stdio: 'inherit',
  });
  const binary = join(install, 'node_modules/.bin/dorkos');
  const environment = {
    // eslint-disable-next-line no-restricted-syntax -- The package proof preserves the invoking test process environment.
    ...process.env,
    // eslint-disable-next-line no-restricted-syntax -- The package proof prepends isolated fake provider binaries to the invoking PATH.
    PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    HOME: fakeHome,
    DORK_HOME: dorkHome,
    NODE_OPTIONS: `--import=${bootstrapPath}`,
    ...CREDENTIAL_SENTINELS,
  } as Record<string, string>;

  const dryRun = await runPlain(binary, args(['--dry-run']), environment);
  if (
    dryRun.code !== 0 ||
    !dryRun.output.includes('Readiness:') ||
    !dryRun.output.includes('Journal:')
  ) {
    throw new Error(`Packaged dry run failed (${dryRun.code})`);
  }

  const first = await runInteractive(interactiveHelper, binary, args(), environment);
  if (first.code !== 0 || !first.output.includes('waiting for owner completion')) {
    process.stderr.write(first.output);
    throw new Error(`Packaged provisioning did not reach owner-pending (${first.code})`);
  }
  const journalDirectory = join(dorkHome, 'launches/community');
  const journalName = (await readdir(journalDirectory)).find((name) => name.endsWith('.json'));
  if (!journalName) throw new Error('Packaged provisioning did not create a journal');
  const runId = journalName.slice(0, -5);

  const second = await runInteractive(
    interactiveHelper,
    binary,
    args(['--resume', runId]),
    environment
  );
  if (second.code !== 0 || !second.output.includes(`--resume ${runId}`)) {
    throw new Error(`Packaged resume failed (${second.code})`);
  }

  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    flyCreates: number;
    neonCreates: number;
    tigrisCreates: number;
    flyNetwork: string | null;
    neonRole: string | null;
    config: string | null;
    imageDigest: string | null;
    registryReads: number;
    stagedValues: Record<string, string>;
  };
  if (state.flyCreates !== 1 || state.neonCreates !== 1 || state.tigrisCreates !== 1) {
    throw new Error('Packaged resume repeated a provider create');
  }
  if (
    !state.config?.includes(`app = "${appName}"`) ||
    !state.config.includes('auto_stop_machines = "off"')
  ) {
    throw new Error('Packaged deployment did not render the pinned one-Machine configuration');
  }
  if (state.imageDigest !== imageDigest)
    throw new Error('Packaged deployment did not use the exact digest');
  // Read once, before the deploy; the resume and the owner step reuse the journal's record.
  if (state.registryReads !== 1) {
    throw new Error(`Packaged launch read the image index ${state.registryReads} times, not once`);
  }
  if (
    state.stagedValues.AWS_ACCESS_KEY_ID !== TIGRIS_ENVIRONMENT.AWS_ACCESS_KEY_ID ||
    state.stagedValues.AWS_SECRET_ACCESS_KEY !== TIGRIS_ENVIRONMENT.AWS_SECRET_ACCESS_KEY ||
    'BUCKET_NAME' in state.stagedValues
  ) {
    throw new Error('Packaged launch did not put exactly the bucket keys on the app');
  }
  const journalText = await readFile(join(journalDirectory, journalName), 'utf8');
  if (
    [first.output, second.output, journalText].some((text) =>
      text.includes(TIGRIS_ENVIRONMENT.AWS_SECRET_ACCESS_KEY)
    )
  ) {
    throw new Error('Packaged launch exposed the bucket secret key');
  }
  // DOR-2602: every exported credential reached `fly` and `neonctl`, GraphQL used the one flyctl
  // reads first under flyctl's own scheme, and no value reached any output or saved file.
  const credentialRecords = (await readFile(credentialLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { bin: string; got: Record<string, boolean> });
  for (const bin of ['fly', 'neonctl']) {
    const records = credentialRecords.filter((record) => record.bin === bin);
    if (records.length === 0 || records.some(({ got }) => !Object.values(got).every(Boolean))) {
      throw new Error(`Packaged launch did not hand every exported credential to ${bin}`);
    }
  }
  const authorizations = (await readFile(authorizationLogPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string);
  const expectedAuthorization = CREDENTIAL_SENTINELS.FLY_ACCESS_TOKEN;
  if (
    authorizations.length === 0 ||
    authorizations.some((value) => value !== expectedAuthorization)
  ) {
    throw new Error(
      'Packaged launch did not send the exported Fly token to GraphQL as flyctl would'
    );
  }
  const notice =
    'Using the Fly token in FLY_ACCESS_TOKEN and the Neon key in NEON_API_KEY from your environment';
  if (![dryRun.output, first.output, second.output].every((text) => text.includes(notice))) {
    throw new Error('Packaged launch did not say which exported credentials it used');
  }
  const savedFiles = (await readdir(dorkHome, { recursive: true, withFileTypes: true })).filter(
    (entry) => entry.isFile()
  );
  const savedTexts = await Promise.all(
    savedFiles.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8'))
  );
  if (savedFiles.length === 0) throw new Error('Packaged launch saved no files to search');
  if (
    [dryRun.output, first.output, second.output, ...savedTexts].some((text) =>
      text.includes(CREDENTIAL_MARK)
    )
  ) {
    throw new Error('Packaged launch wrote an exported credential to its output or saved files');
  }
  // The fake answers any query, so it cannot tell whether Fly would; the schema snapshot can
  // (DOR-2584: `node(id:)` passed every fake and failed the first real call).
  const schema = JSON.parse(await readFile(FLY_SCHEMA_SNAPSHOT, 'utf8')) as IntrospectedSchema;
  const documents = [
    ...new Set(
      (await readFile(graphqlLogPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string)
    ),
  ];
  const invalid = documents.flatMap((document) => checkGraphqlDocument(document, schema));
  if (documents.length < 3 || invalid.length > 0) {
    throw new Error(`Packaged launch sent GraphQL Fly would refuse: ${invalid.join('; ')}`);
  }
  const journal = JSON.parse(await readFile(join(journalDirectory, journalName), 'utf8')) as {
    state: string;
    provenance?: { flyNetwork?: string };
    resources: { neonRoleId?: string; neonDatabaseId?: unknown };
    imagePlatformDigest?: string;
  };
  if (journal.state !== 'owner_pending')
    throw new Error('Packaged resume did not retain owner-pending state');
  // Neon reports database ids as integers; the journal must keep the id the launcher normalized.
  if (journal.resources.neonDatabaseId !== '4821907')
    throw new Error('Packaged journal did not keep the Neon database id as a string');
  if (journal.imagePlatformDigest !== platformDigest)
    throw new Error('Packaged journal did not record the platform digest Fly reports');
  // Each create carried a fresh marker: the Fly app its own private network, the Neon project a
  // marker role. The journal keeps the network the provenance read reported, not a copy of the intent.
  if (!/^dorkos-[a-f0-9]{32}$/u.test(state.flyNetwork ?? '')) {
    throw new Error('Packaged launch did not create the Fly app on a marker network');
  }
  if (journal.provenance?.flyNetwork !== state.flyNetwork) {
    throw new Error('Packaged journal did not record the Fly network read back from the service');
  }
  if (
    !/^community_[a-f0-9]{32}$/u.test(state.neonRole ?? '') ||
    journal.resources.neonRoleId !== state.neonRole
  ) {
    throw new Error('Packaged launch did not create and record the Neon marker role');
  }

  // An uncertain Fly create that leaves a marked app behind with no recorded id (shape A): the fake
  // makes the app, then exits non-zero. The live marker round trip is confirmed (DOR-2238 receipt
  // dorkos-gate-376b14cf0957), so the removal command can prove the app is this run's.
  await writeFile(statePath, JSON.stringify({ ...initialState, secrets: {}, failFlyCreate: true }));
  const orphanHome = join(temporary, 'dork-home-orphan');
  const orphanEnvironment = { ...environment, DORK_HOME: orphanHome };
  const stopped = await runInteractive(interactiveHelper, binary, args(), orphanEnvironment);
  const orphanDirectory = join(orphanHome, 'launches/community');
  const orphanName = (await readdir(orphanDirectory)).find((name) => name.endsWith('.json'));
  if (stopped.code === 0 || !orphanName) {
    throw new Error(`Packaged uncertain create did not stop with a journal (${stopped.code})`);
  }
  const orphanRunId = orphanName.slice(0, -5);
  if (!stopped.output.includes(`--remove-uncertain ${orphanRunId}`)) {
    throw new Error('Packaged recovery text did not offer the removal command');
  }
  const orphanJournalPath = join(orphanDirectory, orphanName);
  type OrphanJournal = {
    revision: number;
    state: string;
    pendingIntent: { provider: string; provenanceMarker?: string } | null;
    pendingRemoval?: unknown;
    removals?: Array<{ provider: string; token: string }>;
    resources: { flyAppId?: string };
  };
  const readOrphanJournal = async () =>
    JSON.parse(await readFile(orphanJournalPath, 'utf8')) as OrphanJournal;
  type FakeState = {
    flyApp: unknown;
    flyNetwork: string | null;
    flyCreates: number;
    flyDestroys?: number;
    neonCreates: number;
    tigrisCreates: number;
  };
  const readState = async () => JSON.parse(await readFile(statePath, 'utf8')) as FakeState;
  const orphanJournal = await readOrphanJournal();
  const orphanState = await readState();
  const markedNetwork = `dorkos-${orphanJournal.pendingIntent?.provenanceMarker}`;
  if (
    orphanJournal.pendingIntent?.provider !== 'fly' ||
    orphanJournal.resources.flyAppId !== undefined ||
    !orphanState.flyApp ||
    orphanState.flyNetwork !== markedNetwork
  ) {
    throw new Error('Packaged uncertain create did not leave a marked shape-A Fly app');
  }
  const removeUncertain = (extra: string[] = []) =>
    runPlain(
      binary,
      ['community', 'deploy', '--remove-uncertain', orphanRunId, ...extra],
      orphanEnvironment
    );
  const assertUnchanged = async (label: string) => {
    const after = await readState();
    if (
      !after.flyApp ||
      after.flyDestroys ||
      (await readOrphanJournal()).revision !== orphanJournal.revision
    ) {
      throw new Error(`Packaged removal changed something for the ${label}`);
    }
  };

  // A same-name app that does not carry the run's marker is never this run's.
  await writeFile(statePath, JSON.stringify({ ...orphanState, flyNetwork: 'default' }));
  for (const extra of [[], ['--confirm', '4817203']]) {
    const refused = await removeUncertain(extra);
    if (
      refused.code !== 0 ||
      !refused.output.includes('does not carry the marker this run recorded')
    ) {
      process.stderr.write(refused.output);
      throw new Error(`Packaged removal did not refuse the unmarked app (${refused.code})`);
    }
    await assertUnchanged('unmarked app');
  }
  await writeFile(statePath, JSON.stringify(orphanState));

  // Without a terminal or --confirm, the marked app is proved and only the exact command is printed.
  const checked = await removeUncertain();
  if (
    checked.code !== 0 ||
    !checked.output.includes('DorkOS can prove that run made it') ||
    !checked.output.includes(`--remove-uncertain ${orphanRunId} --confirm 4817203`)
  ) {
    process.stderr.write(checked.output);
    throw new Error(`Packaged removal did not prove the marked orphan (${checked.code})`);
  }
  await assertUnchanged('check without confirmation');
  // The app name is never a confirmation, even for a proved app.
  const wrong = await removeUncertain(['--confirm', appName]);
  if (wrong.code !== 1 || !wrong.output.includes('That is not the internal id')) {
    process.stderr.write(wrong.output);
    throw new Error(`Packaged removal accepted the app name as a confirmation (${wrong.code})`);
  }
  await assertUnchanged('app name as confirmation');

  // Typing the internal id at the prompt removes it and rewinds the run.
  const removed = await runInteractive(
    interactiveHelper,
    binary,
    ['community', 'deploy', '--remove-uncertain', orphanRunId],
    orphanEnvironment
  );
  const afterRemoval = await readState();
  const rewound = await readOrphanJournal();
  if (
    removed.code !== 0 ||
    !removed.output.includes(`Removed Fly app ${appName} (internal id 4817203)`) ||
    afterRemoval.flyApp !== null ||
    afterRemoval.flyDestroys !== 1 ||
    rewound.pendingIntent !== null ||
    rewound.pendingRemoval !== null ||
    rewound.state !== 'planned' ||
    rewound.removals?.length !== 1 ||
    rewound.removals[0]?.token !== '4817203'
  ) {
    process.stderr.write(removed.output);
    throw new Error(
      `Packaged removal did not remove the proved orphan and rewind (${removed.code})`
    );
  }

  // The same run then resumes to the end with a fresh marker: one app, one project, one bucket.
  await writeFile(statePath, JSON.stringify({ ...afterRemoval, failFlyCreate: false }));
  const resumedOrphan = await runInteractive(
    interactiveHelper,
    binary,
    args(['--resume', orphanRunId]),
    orphanEnvironment
  );
  const finalState = await readState();
  const finalJournal = await readOrphanJournal();
  if (
    resumedOrphan.code !== 0 ||
    finalJournal.state !== 'owner_pending' ||
    !finalState.flyApp ||
    finalState.flyCreates !== 2 ||
    finalState.flyDestroys !== 1 ||
    finalState.neonCreates !== 1 ||
    finalState.tigrisCreates !== 1 ||
    finalState.flyNetwork === markedNetwork
  ) {
    process.stderr.write(resumedOrphan.output);
    throw new Error(`Packaged resume after removal did not finish cleanly (${resumedOrphan.code})`);
  }

  process.stdout.write(
    'Packaged Community launcher proof passed: dry-run, exact release, provisioning with provenance markers, resume, pinned config, owner-pending, uncertain-create removal refused for an unmarked same-name app and proved, confirmed, removed and resumed for a marked orphan.\n'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

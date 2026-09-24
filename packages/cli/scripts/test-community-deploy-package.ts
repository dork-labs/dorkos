import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '../../..');
const cliPackage = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'dorkos-community-package-'));
const version = JSON.parse(await readFile(join(cliPackage, 'package.json'), 'utf8'))
  .version as string;
const imageDigest = `sha256:${'a'.repeat(64)}`;
const appName = `dorkos-package-${randomUUID().slice(0, 8)}`;
const dorkHome = join(temporary, 'dork-home');
const fakeHome = join(temporary, 'home');
const fakeBin = join(temporary, 'bin');
const statePath = join(temporary, 'provider-state.json');

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
  secrets: {
    AWS_ACCESS_KEY_ID: { digest: 'aws-access-digest', status: 'Deployed' },
    AWS_SECRET_ACCESS_KEY: { digest: 'aws-secret-digest', status: 'Deployed' },
  },
  deployed: false,
  imageDigest: null,
  config: null,
};

const commonPrelude = `
const fs=require('node:fs');
const statePath=${JSON.stringify(statePath)};
const read=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));
const write=(value)=>fs.writeFileSync(statePath,JSON.stringify(value));
const args=process.argv.slice(2);
const at=(flag)=>args[args.indexOf(flag)+1];
`;

const flyFixture = `#!${process.execPath}
${commonPrelude}
const state=read();
let value;
if(args[0]==='version') value={Name:'fly',Version:'0.4.104'};
else if(args[0]==='orgs'&&args[1]==='show') value={ID:'fly-org-id',Slug:args[2],Name:'Dork Labs'};
else if(args[0]==='orgs') value={'dork-labs':'Dork Labs'};
else if(args[0]==='platform') value=[{code:'ord',name:'Chicago',latitude:41.8,longitude:-87.6,gateway_available:true,requires_paid_plan:false,deprecated:false}];
else if(args[0]==='apps'&&args[1]==='list') value=state.flyApp?[state.flyApp]:[];
else if(args[0]==='apps'&&args[1]==='create') { state.flyCreates++; state.flyNetwork=at('--network'); state.flyCreatedAt=new Date().toISOString(); state.flyApp={ID:'app-id-1',Name:args[2],Status:'deployed',Network:'',Organization:{ID:'fly-org-id',Slug:at('--org'),Name:'Dork Labs'}}; write(state); if(state.failFlyCreate) process.exit(1); value=state.flyApp; }
else if(args[0]==='apps'&&args[1]==='destroy') { state.flyDestroys=(state.flyDestroys??0)+1; state.flyApp=null; write(state); value={}; }
else if(args[0]==='auth'&&args[1]==='token') value={token:'fixture-fly-token'};
else if(args[0]==='secrets'&&args[1]==='list') value=Object.entries(state.secrets).map(([name,item])=>({name,digest:item.digest,status:item.status}));
else if(args[0]==='secrets'&&args[1]==='import') { const input=fs.readFileSync(0,'utf8'); for(const line of input.trim().split('\\n')) { const name=line.slice(0,line.indexOf('=')); state.secrets[name]={digest:'digest-'+name.toLowerCase().replaceAll('_','-')+'-'+Date.now(),status:'Staged'}; } write(state); value={}; }
else if(args[0]==='secrets'&&args[1]==='deploy') { for(const item of Object.values(state.secrets)) item.status='Deployed'; write(state); value={}; }
else if(args[0]==='deploy') { state.deployed=true; state.imageDigest=at('--image').split('@')[1]; state.config=fs.readFileSync(at('--config'),'utf8'); for(const item of Object.values(state.secrets)) item.status='Deployed'; write(state); value={}; }
else if(args[0]==='machine') value=state.deployed?[{id:'machine-1',name:'machine-1',state:'started',region:'ord',image_ref:{digest:state.imageDigest,registry:'ghcr.io',repository:'dork-labs/dorkos-community'},checks:[{name:'http',status:'passing'}]}]:[];
else if(args[0]==='releases') value=state.deployed?[{ID:'release-1',ImageRef:'ghcr.io/dork-labs/dorkos-community@'+state.imageDigest,Status:'complete',Stable:false,Version:1}]:[];
else if(args[0]==='ips') value=state.deployed?[{ID:'ip-1',Address:'1.2.3.4',Type:'shared_v4',Region:''}]:[];
else process.exit(3);
process.stdout.write(JSON.stringify(value));
`;

const neonFixture = `#!${process.execPath}
${commonPrelude}
const state=read();
let value;
if(args[0]==='--version') { process.stdout.write('5.0.0'); process.exit(0); }
else if(args[0]==='orgs') value=[{id:'org-dorian',name:'Dorian'}];
else if(args[0]==='api'&&args[1]==='/regions') value={regions:[{region_id:'aws-us-east-2',name:'AWS US East 2',default:false,geo_lat:40.4,geo_long:-82.9}]};
else if(args[0]==='projects'&&args[1]==='list') value=state.neonProject?[state.neonProject]:[];
else if(args[0]==='projects'&&args[1]==='create') { state.neonCreates++; state.neonRole=at('--role'); state.neonProject={id:'neon-project-1',org_id:at('--org-id'),name:at('--name'),region_id:at('--region-id'),pg_version:Number(at('--pg-version')),created_at:new Date().toISOString()}; write(state); value={project:state.neonProject}; }
else if(args[0]==='branches') value=[{id:'branch-1',project_id:'neon-project-1',name:'main',default:true}];
else if(args[0]==='databases') value=[{id:'database-1',branch_id:'branch-1',name:'community',owner_name:state.neonRole}];
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
globalThis.fetch=async (input,init={})=>{
  const url=String(input);
  const state=JSON.parse(fs.readFileSync(statePath,'utf8'));
  if(url.endsWith('/health')) return json({status:'ok'});
  if(url.endsWith('/api/v1/community')) return json({},404);
  const body=JSON.parse(String(init.body??'{}'));
  const query=String(body.query??'');
  if(query.includes('DorkosTigrisTerms')) return json({data:{viewer:{agreedToProviderTos:true}}});
  if(query.includes('DorkosCreateTigris')) { state.tigrisCreates++; state.tigris={id:'tigris-1',name:${JSON.stringify(appName)},status:'ready',options:{public:false},organization:{slug:'dork-labs'},addOnProvider:{name:'tigris'},app:{id:'app-id-1',name:${JSON.stringify(appName)}}}; fs.writeFileSync(statePath,JSON.stringify(state)); return json({data:{createAddOn:{addOn:state.tigris}}}); }
  if(query.includes('DorkosReadTigris')) return json({data:{node:state.tigris}});
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
    `import os,pty,select,sys\napp=os.environ['COMMUNITY_PROOF_APP_NAME']\npid,fd=pty.fork()\nif pid==0: os.execve(sys.argv[1],sys.argv[1:],os.environ)\nout=b''; sent=set()\nwhile True:\n r,_,_=select.select([fd],[],[],1)\n if fd in r:\n  try: chunk=os.read(fd,4096)\n  except OSError: break\n  if not chunk: break\n  out+=chunk; os.write(1,chunk)\n  text=out.decode('utf8','replace')\n  if 'consent' not in sent and ('Type '+app+' to create these resources:') in text: os.write(fd,(app+'\\r').encode()); sent.add('consent')\n  if 'clipboard-test' not in sent and 'Type COPY TEST to replace your current clipboard' in text: os.write(fd,b'COPY TEST\\r'); sent.add('clipboard-test')\n  if 'copy' not in sent and 'Type copy:' in text: os.write(fd,b'copy\\r'); sent.add('copy')\n  if 'continue' not in sent and 'then press Enter to verify it.' in text: os.write(fd,b'\\r'); sent.add('continue')\n_,status=os.waitpid(pid,0)\nsys.exit(os.waitstatus_to_exitcode(status))\n`
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
  const journal = JSON.parse(await readFile(join(journalDirectory, journalName), 'utf8')) as {
    state: string;
    provenance?: { flyNetwork?: string };
    resources: { neonRoleId?: string };
  };
  if (journal.state !== 'owner_pending')
    throw new Error('Packaged resume did not retain owner-pending state');
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

  // An uncertain Fly create that leaves a marked app behind with no recorded id (shape A). The
  // committed gate has not confirmed Fly's marker round trip, so the removal command must refuse
  // to delete it and say why, even when the right internal id is given.
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
  const orphanJournal = JSON.parse(await readFile(orphanJournalPath, 'utf8')) as {
    revision: number;
    pendingIntent: { provider: string; provenanceMarker?: string } | null;
    resources: { flyAppId?: string };
  };
  const orphanState = JSON.parse(await readFile(statePath, 'utf8')) as {
    flyApp: unknown;
    flyNetwork: string | null;
  };
  if (
    orphanJournal.pendingIntent?.provider !== 'fly' ||
    orphanJournal.resources.flyAppId !== undefined ||
    !orphanState.flyApp ||
    orphanState.flyNetwork !== `dorkos-${orphanJournal.pendingIntent.provenanceMarker}`
  ) {
    throw new Error('Packaged uncertain create did not leave a marked shape-A Fly app');
  }
  const assertOrphanSurvives = async (expected: string, label: string) => {
    for (const extra of [[], ['--confirm', '4817203']]) {
      const removal = await runPlain(
        binary,
        ['community', 'deploy', '--remove-uncertain', orphanRunId, ...extra],
        orphanEnvironment
      );
      if (removal.code !== 0 || !removal.output.includes(expected)) {
        process.stderr.write(removal.output);
        throw new Error(`Packaged removal did not refuse the ${label} (${removal.code})`);
      }
      const after = JSON.parse(await readFile(statePath, 'utf8')) as {
        flyApp: unknown;
        flyDestroys?: number;
      };
      const journalAfter = JSON.parse(await readFile(orphanJournalPath, 'utf8')) as {
        revision: number;
      };
      if (!after.flyApp || after.flyDestroys || journalAfter.revision !== orphanJournal.revision) {
        throw new Error(`Packaged removal changed something for the ${label}`);
      }
    }
  };
  await assertOrphanSurvives('not yet confirmed this proof with Fly', 'marked orphan');

  // A same-name app that does not carry the run's marker is never this run's, gate or no gate.
  await writeFile(
    statePath,
    JSON.stringify({ ...JSON.parse(await readFile(statePath, 'utf8')), flyNetwork: 'default' })
  );
  await assertOrphanSurvives('does not carry the marker this run recorded', 'unmarked app');

  process.stdout.write(
    'Packaged Community launcher proof passed: dry-run, exact release, provisioning with provenance markers, resume, pinned config, owner-pending, uncertain-create removal refused for a marked orphan and an unmarked same-name app.\n'
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

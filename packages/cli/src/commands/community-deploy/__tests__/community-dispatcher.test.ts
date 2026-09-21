import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatCommunityCompletion,
  formatCommunityRecovery,
  runCommunityDispatcher,
} from '../community-dispatcher.js';
import { createInitialCommunityLaunchJournal } from '../resume.js';
import { initializeLaunchJournal, launchJournalPath } from '../journal.js';
import { createLaunchPlan } from '../plan.js';
import type { CompatibleCommunityRelease } from '../release-resolver.js';

const roots: string[] = [];
const sessions: Server[] = [];

async function desktopSessionEnv(path: string): Promise<Record<string, string>> {
  const server = createServer();
  sessions.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(path, 'wayland-0'), resolve);
  });
  return { PATH: path, XDG_RUNTIME_DIR: path, WAYLAND_DISPLAY: 'wayland-0' };
}

async function fixtureBin() {
  const root = await mkdtemp(join(tmpdir(), 'dorkos-community-command-'));
  roots.push(root);
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
  const source = (name: string) => `#!${process.execPath}
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2);
let value;
if (name === 'gh' && args[0] === 'release') value = ${JSON.stringify(manifest)};
else if (name === 'gh') value = {};
else if (name === 'fly' && args[0] === 'version') value = {Name:'fly',Version:'0.4.104'};
else if (name === 'fly' && args[0] === 'orgs') value = {'dork-labs':'Dork Labs'};
else if (name === 'fly' && args[0] === 'platform') value = [{code:'ord',name:'Chicago',latitude:41.8,longitude:-87.6,gateway_available:true,requires_paid_plan:false,deprecated:false}];
else if (name === 'fly' && args[0] === 'apps') value = [];
else if (name === 'neonctl' && args[0] === 'orgs') value = [{id:'org-dorian',name:'Dorian'}];
else if (name === 'neonctl' && args[0] === 'api' && args[1] === '/regions') value = {regions:[{region_id:'aws-us-east-2',name:'AWS US East 2',default:false,geo_lat:40.4,geo_long:-82.9}]};
else if (name === 'neonctl' && args[0] === 'projects') value = [];
else if (name === 'neonctl' && args[0] === '--version') { process.stdout.write('5.0.0'); process.exit(0); }
else if (['open','pbcopy','pbpaste','xdg-open','wl-copy','clip.exe','powershell.exe'].includes(name)) process.exit(0);
else process.exit(2);
process.stdout.write(JSON.stringify(value));
`;
  for (const name of [
    'gh',
    'fly',
    'neonctl',
    'open',
    'pbcopy',
    'pbpaste',
    'xdg-open',
    'wl-copy',
    'clip.exe',
    'powershell.exe',
  ]) {
    const executable = join(root, name);
    await writeFile(executable, source(name));
    await chmod(executable, 0o755);
  }
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    sessions
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Community command dispatcher', () => {
  it('runs packaged dry-run resolution and read-only planning with fake services', async () => {
    const path = await fixtureBin();
    await Promise.all([
      rm(join(path, 'pbcopy')),
      rm(join(path, 'pbpaste')),
      rm(join(path, 'open')),
    ]);
    const dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-community-home-'));
    roots.push(dorkHome);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runCommunityDispatcher(
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
        'dorkos-community-test',
        '--dry-run',
      ],
      {
        cliVersion: '0.76.0',
        dorkHome,
        processEnv: { PATH: path },
        parseRelease: (bytes) =>
          JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
      }
    );
    expect(code).toBe(0);
    const rendered = output.mock.calls.map(([value]) => String(value)).join('');
    expect(rendered).toContain('DorkOS Community 0.76.0');
    expect(rendered).toContain('fly-app-name: unknown');
    expect(rendered).toContain('Journal:');
    expect(rendered).not.toContain(`sha256:${'a'.repeat(64)}`);
  });

  it('has no noninteractive approval flag', async () => {
    await expect(
      runCommunityDispatcher(['deploy', '--yes'], {
        cliVersion: '0.76.0',
        dorkHome: '/tmp/dorkos-command-test',
        processEnv: { PATH: '' },
        parseRelease: () => {
          throw new Error('unused');
        },
      })
    ).rejects.toThrow('Unknown option');
  });

  it('lists incomplete journals without requiring provider choices', async () => {
    const dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-community-home-'));
    roots.push(dorkHome);
    const runId = randomUUID();
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
    await initializeLaunchJournal(
      launchJournalPath(dorkHome, runId),
      createInitialCommunityLaunchJournal(runId, plan, '2026-09-21T00:00:00.000Z')
    );
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(
      await runCommunityDispatcher(['deploy', '--list-incomplete'], {
        cliVersion: '0.76.0',
        dorkHome,
        processEnv: { PATH: '' },
        parseRelease: () => {
          throw new Error('unused');
        },
      })
    ).toBe(0);
    expect(output.mock.calls.map(([value]) => String(value)).join('')).toContain(runId);
  });

  it('renders retained-resource recovery when resume preflight fails before execution', async () => {
    const path = await fixtureBin();
    const dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-community-home-'));
    roots.push(dorkHome);
    const runId = randomUUID();
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
    const initial = createInitialCommunityLaunchJournal(runId, plan, '2026-09-21T00:00:00.000Z');
    await initializeLaunchJournal(launchJournalPath(dorkHome, runId), {
      ...initial,
      state: 'fly_app_created',
      resources: { flyAppId: 'app-retained' },
      completedSteps: ['planned', 'fly_app_created'],
    });
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      runCommunityDispatcher(
        [
          'deploy',
          '--resume',
          runId,
          '--version',
          '0.76.0',
          '--fly-org',
          'wrong-org',
          '--fly-region',
          'ord',
          '--neon-org',
          'org-dorian',
          '--neon-region',
          'aws-us-east-2',
          '--app-name',
          'dorkos-community-test',
        ],
        {
          cliVersion: '0.76.0',
          dorkHome,
          processEnv: await desktopSessionEnv(path),
          parseRelease: (bytes) =>
            JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
        }
      )
    ).rejects.toThrow('FLY_ORGANIZATION_NOT_FOUND');
    const rendered = errorOutput.mock.calls.map(([value]) => String(value)).join('');
    expect(rendered).toContain('Fly app app-retained');
    expect(rendered).toContain('owner dork-labs');
    expect(rendered).not.toContain('owner wrong-org');
    expect(rendered).toContain('--fly-org dork-labs');
    expect(rendered).not.toContain('--fly-org wrong-org');
    expect(rendered).toContain('may incur charges');
    expect(rendered).toContain(`--resume ${runId}`);
  });

  it('renders saved recovery before rejecting missing resume selection flags', async () => {
    const dorkHome = await mkdtemp(join(tmpdir(), 'dorkos-community-home-'));
    roots.push(dorkHome);
    const runId = randomUUID();
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
    const initial = createInitialCommunityLaunchJournal(runId, plan, '2026-09-21T00:00:00.000Z');
    await initializeLaunchJournal(launchJournalPath(dorkHome, runId), {
      ...initial,
      state: 'fly_app_created',
      resources: { flyAppId: 'app-retained' },
      completedSteps: ['planned', 'fly_app_created'],
    });
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      runCommunityDispatcher(['deploy', '--resume', runId], {
        cliVersion: '0.76.0',
        dorkHome,
        processEnv: { PATH: '' },
        parseRelease: () => {
          throw new Error('unused');
        },
      })
    ).rejects.toThrow('--app-name is required');
    const rendered = errorOutput.mock.calls.map(([value]) => String(value)).join('');
    expect(rendered).toContain('Fly app app-retained');
    expect(rendered).toContain('owner dork-labs');
    expect(rendered).toContain(`--resume ${runId}`);
    expect(rendered).toContain('may incur charges');
  });

  it('states retained ownership, possible costs/data, and recovery limits', () => {
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
    const runId = randomUUID();
    const base = createInitialCommunityLaunchJournal(runId, plan, '2026-09-21T00:00:00.000Z');
    const journal = {
      ...base,
      resources: {
        flyAppId: 'app-id',
        neonProjectId: 'project-id',
        tigrisBucketId: 'bucket-id',
      },
    };
    const recovery = formatCommunityRecovery(journal);
    expect(recovery).toContain('owner dork-labs');
    expect(recovery).toContain('may incur charges');
    expect(recovery).toContain('database data may exist');
    expect(recovery).toContain('private files may exist');
    expect(recovery).toContain(`--resume ${runId}`);
    expect(recovery).not.toContain('delete');

    const completion = formatCommunityCompletion('https://dorkos-community-test.fly.dev');
    expect(completion).toContain('Deployment health:');
    expect(completion).toContain('Recovery readiness: not verified');
    expect(completion).toContain('Tigris snapshots are a separate operator choice');
  });

  it('renders pending creation reconciliation without suggesting name adoption', () => {
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
    const base = createInitialCommunityLaunchJournal(
      randomUUID(),
      plan,
      '2026-09-21T00:00:00.000Z'
    );
    const recovery = formatCommunityRecovery({
      ...base,
      state: 'uncertain',
      pendingIntent: {
        provider: 'neon',
        organizationId: 'org-dorian',
        resourceName: 'dorkos-community-test',
      },
    });
    expect(recovery).toContain('Manual reconciliation required');
    expect(recovery).toContain('neonctl projects list --org-id org-dorian');
    expect(recovery).toContain('Do not create or adopt a name match');
  });
});

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommunityDispatcher } from '../community-dispatcher.js';
import type { CompatibleCommunityRelease } from '../release-resolver.js';

const roots: string[] = [];

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
else process.exit(2);
process.stdout.write(JSON.stringify(value));
`;
  for (const name of ['gh', 'fly', 'neonctl']) {
    const executable = join(root, name);
    await writeFile(executable, source(name));
    await chmod(executable, 0o755);
  }
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Community command dispatcher', () => {
  it('runs packaged dry-run resolution and read-only planning with fake services', async () => {
    const path = await fixtureBin();
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
});

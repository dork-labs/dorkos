import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCommunityDispatcher } from '../community-dispatcher.js';
import {
  COMMUNITY_CREDENTIAL_ENV_NAMES,
  flyCredentialEnvInUse,
  formatCommunityCredentialNotice,
} from '../runtime/credential-env.js';
import { FlyTigrisGraphqlClient, flyGraphqlAuthorization } from '../fly-graphql-client.js';
import type { CompatibleCommunityRelease } from '../release-resolver.js';

const SENTINELS = {
  FLY_ACCESS_TOKEN: 'FlyV1 fm2_dor2602_sentinel_access',
  FLY_API_TOKEN: 'fo1_dor2602_sentinel_api',
  NEON_API_KEY: 'napi_dor2602_sentinel_neon',
};
// Every sentinel shares this, so one search covers each value and each re-encoding of it.
const SENTINEL_MARK = 'dor2602_sentinel';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function readTree(root: string): Promise<string> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const texts = await Promise.all(
    files.map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8'))
  );
  return texts.join('\n');
}

describe('credential variables', () => {
  it('passes the three variables fly and neonctl read', () => {
    expect([...COMMUNITY_CREDENTIAL_ENV_NAMES].sort()).toEqual([
      'FLY_ACCESS_TOKEN',
      'FLY_API_TOKEN',
      'NEON_API_KEY',
    ]);
  });

  it('picks the Fly variable in the order flyctl reads them', () => {
    expect(flyCredentialEnvInUse({})).toBeNull();
    expect(flyCredentialEnvInUse({ FLY_API_TOKEN: 'x' })).toBe('FLY_API_TOKEN');
    expect(flyCredentialEnvInUse({ FLY_ACCESS_TOKEN: 'x', FLY_API_TOKEN: 'y' })).toBe(
      'FLY_ACCESS_TOKEN'
    );
    // flyctl treats an empty value as unset and falls through to the next one.
    expect(flyCredentialEnvInUse({ FLY_ACCESS_TOKEN: '', FLY_API_TOKEN: 'y' })).toBe(
      'FLY_API_TOKEN'
    );
  });

  it('says nothing when no credential variable is set', () => {
    expect(formatCommunityCredentialNotice({ PATH: '/bin', NEON_API_KEY: '' })).toBe('');
  });

  it('names each variable in use in one line, and never a value', () => {
    expect(formatCommunityCredentialNotice({ FLY_API_TOKEN: SENTINELS.FLY_API_TOKEN })).toBe(
      'Using the Fly token in FLY_API_TOKEN from your environment, not your saved sign-in.\n'
    );
    expect(formatCommunityCredentialNotice({ NEON_API_KEY: SENTINELS.NEON_API_KEY })).toBe(
      'Using the Neon key in NEON_API_KEY from your environment, not your saved sign-in.\n'
    );
    const all = formatCommunityCredentialNotice(SENTINELS);
    expect(all).toBe(
      'Using the Fly token in FLY_ACCESS_TOKEN and the Neon key in NEON_API_KEY from your environment, not your saved sign-ins. FLY_API_TOKEN is set too, but Fly reads FLY_ACCESS_TOKEN first.\n'
    );
    expect(all.trimEnd()).not.toContain('\n');
    expect(all).not.toContain(SENTINEL_MARK);
    expect(all.toLowerCase()).not.toContain('provider');
  });
});

describe('Fly GraphQL authorization', () => {
  it('sends a scoped macaroon token under FlyV1 and a session token under Bearer, as flyctl does', () => {
    expect(flyGraphqlAuthorization('fo1_session')).toBe('Bearer fo1_session');
    expect(flyGraphqlAuthorization('fm2_scoped')).toBe('FlyV1 fm2_scoped');
    expect(flyGraphqlAuthorization('fm1r_a,fm2_b')).toBe('FlyV1 fm1r_a,fm2_b');
    expect(flyGraphqlAuthorization('fm1a_a')).toBe('FlyV1 fm1a_a');
    // `fly auth token` lists macaroons first, then any session token, as one value.
    expect(flyGraphqlAuthorization('fm2_a,fo1_b')).toBe('FlyV1 fm2_a,fo1_b');
  });

  it('puts that header on the request the client sends', async () => {
    const seen: string[] = [];
    const client = new FlyTigrisGraphqlClient({
      accessToken: 'fm2_scoped',
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ data: { viewer: { agreedToProviderTos: true } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    await client.hasAcceptedTerms();
    expect(seen).toEqual(['FlyV1 fm2_scoped']);
  });
});

describe('credential variables on the fake-service path', () => {
  it('reach fly and neonctl, are named once, and appear in no output or saved file', async () => {
    const bin = await temporary('dorkos-community-credentials-bin-');
    const dorkHome = await temporary('dorkos-community-credentials-home-');
    const seenPath = join(bin, 'seen.jsonl');
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
    // Each fake records which credential variables arrived, as booleans, never the values.
    const source = (name: string) => `#!${process.execPath}
const fs = require('node:fs');
const name = ${JSON.stringify(name)};
const expected = ${JSON.stringify(SENTINELS)};
fs.appendFileSync(${JSON.stringify(seenPath)}, JSON.stringify({ name, got: Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, process.env[key] === value])) }) + '\\n');
const args = process.argv.slice(2);
let value;
if (name === 'gh' && args[0] === 'release') value = ${JSON.stringify(manifest)};
else if (name === 'gh') value = {};
else if (name === 'fly' && args[0] === 'version') value = {Name:'fly',Version:'0.4.104'};
else if (name === 'fly' && args[0] === 'orgs') value = {'dork-labs':'Dork Labs'};
else if (name === 'fly' && args[0] === 'platform') value = [{code:'ord',name:'Chicago',latitude:41.8,longitude:-87.6,gateway_available:true,requires_paid_plan:false,deprecated:false}];
else if (name === 'fly' && args[0] === 'apps') value = [];
else if (name === 'neonctl' && args[0] === 'orgs') value = [{id:'org-dorian',name:'Dorian'}];
else if (name === 'neonctl' && args[0] === 'api' && args[1] === '/regions') value = {regions:[{region_id:'aws-us-east-2',name:'AWS US East 2',default:false,geo_lat:'40.4',geo_long:'-82.9'}]};
else if (name === 'neonctl' && args[0] === 'projects') value = [];
else if (name === 'neonctl' && args[0] === '--version') { process.stdout.write('5.0.0'); process.exit(0); }
else process.exit(2);
process.stdout.write(JSON.stringify(value));
`;
    for (const name of ['gh', 'fly', 'neonctl']) {
      await writeFile(join(bin, name), source(name));
      await chmod(join(bin, name), 0o755);
    }
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

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
        processEnv: { PATH: bin, ...SENTINELS },
        parseRelease: (bytes) =>
          JSON.parse(Buffer.from(bytes).toString('utf8')) as CompatibleCommunityRelease,
      }
    );

    expect(code).toBe(0);
    const printed = [...stdout.mock.calls, ...stderr.mock.calls]
      .map(([value]) => String(value))
      .join('');
    expect(printed).toContain('Readiness:');
    expect(printed.match(/from your environment/gu)).toHaveLength(1);
    expect(printed).toContain('the Fly token in FLY_ACCESS_TOKEN and the Neon key in NEON_API_KEY');
    const seen = (await readFile(seenPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { name: string; got: Record<string, boolean> });
    const allSet = { FLY_ACCESS_TOKEN: true, FLY_API_TOKEN: true, NEON_API_KEY: true };
    expect(seen.filter(({ name }) => name === 'fly').map(({ got }) => got)).toContainEqual(allSet);
    expect(seen.filter(({ name }) => name === 'neonctl').map(({ got }) => got)).toContainEqual(
      allSet
    );
    expect(seen.every(({ got }) => Object.values(got).every(Boolean))).toBe(true);
    for (const text of [printed, await readTree(dorkHome)]) {
      expect(text).not.toContain(SENTINEL_MARK);
    }
  });
});

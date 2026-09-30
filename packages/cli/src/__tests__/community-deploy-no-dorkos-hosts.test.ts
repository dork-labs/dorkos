import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cloudHostsFrom,
  findDorkosHostInText,
  isDorkosHost,
} from '../../scripts/community-deploy-no-dorkos-hosts.mjs';
import {
  NO_DORKOS_HOSTS_GUARD_URL,
  readDorkosHostsContacted,
  withNoDorkosHostsGuard,
} from '../../scripts/community-deploy-no-dorkos-hosts-record.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dorkos-no-dorkos-hosts-'));
  directories.push(directory);
  return directory;
}

/** Run an ES module under bare node with the given environment; resolves its exit and output. */
function runNode(script: string, environment: Record<string, string>) {
  return new Promise<{ code: number; output: string }>((resolvePromise) => {
    execFile(
      process.execPath,
      [script],
      // eslint-disable-next-line no-restricted-syntax -- The child needs the test's PATH to find node's tools.
      { env: { PATH: process.env.PATH ?? '', ...environment } },
      (error, stdout, stderr) =>
        resolvePromise({
          code: typeof error?.code === 'number' ? error.code : 0,
          output: stdout + stderr,
        })
    );
  });
}

describe('which hosts count as DorkOS hosts', () => {
  it('refuses dorkos.ai and every subdomain, however it is written', () => {
    for (const host of [
      'dorkos.ai',
      'cloud.dorkos.ai',
      'DORKOS.AI',
      'dorkos.ai.',
      'dorkos.ai:443',
      'https://docs.dorkos.ai/guides',
      'a.b.dorkos.ai',
    ]) {
      expect(isDorkosHost(host), host).toBe(true);
    }
  });

  it('allows the hosts a launch really uses, and look-alikes that are not DorkOS', () => {
    for (const host of [
      'notdorkos.ai',
      'api.github.com',
      'fly.io',
      'api.fly.io',
      'ghcr.io',
      'console.neon.tech',
      'dorkos.ai.example.com',
      'dorkos.aim',
      '',
    ]) {
      expect(isDorkosHost(host), host).toBe(false);
    }
  });

  it('counts the DorkOS Cloud address the app is pointed at through DORKOS_CLOUD_URL', () => {
    const extra = cloudHostsFrom({ DORKOS_CLOUD_URL: 'https://cloud.example.test:8443/v1' });
    expect(extra).toEqual(['cloud.example.test']);
    expect(isDorkosHost('cloud.example.test', extra)).toBe(true);
    expect(isDorkosHost('example.test', extra)).toBe(false);
    expect(cloudHostsFrom({})).toEqual([]);
  });

  it('finds a DorkOS host named inside a command-line argument', () => {
    expect(findDorkosHostInText('https://dorkos.ai/api/telemetry/events')).toBe('dorkos.ai');
    expect(findDorkosHostInText('--endpoint=cloud.dorkos.ai')).toBe('cloud.dorkos.ai');
    expect(findDorkosHostInText('dork-labs/dorkos')).toBeNull();
    expect(findDorkosHostInText('https://notdorkos.ai')).toBeNull();
    expect(findDorkosHostInText('dorkos.ai.example.com')).toBeNull();
    expect(findDorkosHostInText('https://cloud.example.test/x', ['cloud.example.test'])).toBe(
      'cloud.example.test'
    );
  });
});

describe('the guard as the launcher loads it', () => {
  // Purpose: fails if any seam lets a DorkOS request through, or if the guard sits inside (rather
  // than outside) an offline fake that an earlier preload installed, the package proof's layout.
  it('refuses and records every seam, outside an earlier fake, and lets other hosts through', async () => {
    const directory = await scratch();
    const record = join(directory, 'record.jsonl');
    const fake = join(directory, 'fake.mjs');
    // Like the package proof's bootstrap: answers every fetch offline, so only the guard can refuse.
    await writeFile(
      fake,
      "globalThis.fetch = async () => new Response('fake', { status: 200 });\n"
    );
    const script = join(directory, 'launcher.mjs');
    await writeFile(
      script,
      `
import { spawn, execFileSync } from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const outcomes = {};
const attempt = async (name, run) => {
  try { await run(); outcomes[name] = 'allowed'; }
  catch (error) { outcomes[name] = error.code === 'DORKOS_HOST_REFUSED' ? 'refused' : 'other:' + error.message; }
};
await attempt('fetch', () => fetch('https://dorkos.ai'));
await attempt('fetch-request', () => fetch(new Request('https://cloud.dorkos.ai/v1/instances')));
await attempt('fetch-other', async () => { if ((await fetch('https://api.fly.io/graphql')).status !== 200) throw new Error('x'); });
await attempt('https.request', () => https.request('https://dorkos.ai/'));
await attempt('https.get-options', () => https.get({ hostname: 'cloud.dorkos.ai', path: '/' }));
await attempt('http.request-url', () => http.request(new URL('http://dorkos.ai/')));
await attempt('net.connect', () => net.connect(443, 'dorkos.ai'));
await attempt('tls.connect', () => tls.connect({ host: 'cloud.dorkos.ai', port: 443 }));
await attempt('dns.lookup', () => dns.lookup('dorkos.ai', () => {}));
await attempt('dns.promises', () => dns.promises.lookup('cloud.dorkos.ai'));
await attempt('dns-other', () => dns.promises.lookup('localhost'));
await attempt('spawn', () => spawn('curl', ['-s', 'https://cloud.dorkos.ai']));
await attempt('spawn-env', () => spawn('fly', ['version'], { env: { ENDPOINT: 'https://dorkos.ai' } }));
await attempt('execFileSync-other', () => execFileSync(process.execPath, ['-e', '0']));
process.stdout.write(JSON.stringify(outcomes));
`
    );
    const result = await runNode(
      script,
      withNoDorkosHostsGuard({ NODE_OPTIONS: `--import=${fake}` }, record)
    );
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      fetch: 'refused',
      'fetch-request': 'refused',
      'fetch-other': 'allowed',
      'https.request': 'refused',
      'https.get-options': 'refused',
      'http.request-url': 'refused',
      'net.connect': 'refused',
      'tls.connect': 'refused',
      'dns.lookup': 'refused',
      'dns.promises': 'refused',
      'dns-other': 'allowed',
      spawn: 'refused',
      'spawn-env': 'refused',
      'execFileSync-other': 'allowed',
    });
    // Every refusal is on record even though the script caught all of them.
    const seams = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { seam?: string; loaded?: number })
      .flatMap((line) => (line.seam ? [line.seam] : []));
    expect(seams).toEqual([
      'fetch',
      'fetch',
      'https.request',
      'https.get',
      'http.request',
      'net.connect',
      'tls.connect',
      'dns.lookup',
      'dns.promises.lookup',
      'spawn',
      'spawn',
    ]);
    expect(await readDorkosHostsContacted(record, [process.pid])).toEqual([
      'dorkos.ai',
      'cloud.dorkos.ai',
    ]);
  });

  it('refuses the configured DorkOS Cloud address too', async () => {
    const directory = await scratch();
    const record = join(directory, 'record.jsonl');
    const script = join(directory, 'launcher.mjs');
    await writeFile(
      script,
      "await fetch('https://cloud.example.test/v1/instances').catch(() => {});\n"
    );
    const result = await runNode(script, {
      ...withNoDorkosHostsGuard({}, record),
      DORKOS_CLOUD_URL: 'https://cloud.example.test',
    });
    expect(result.code, result.output).toBe(0);
    expect(await readDorkosHostsContacted(record, [process.pid])).toEqual(['cloud.example.test']);
  });

  it('leaves an empty record for a run that contacts no DorkOS host', async () => {
    const directory = await scratch();
    const record = join(directory, 'record.jsonl');
    const script = join(directory, 'launcher.mjs');
    await writeFile(script, 'process.exitCode = 0;\n');
    await runNode(script, withNoDorkosHostsGuard({}, record));
    expect(await readDorkosHostsContacted(record, [process.pid])).toEqual([]);
  });

  // Purpose: fails if a launcher that never loaded the guard could pass as one that contacted
  // nothing, including when a guarded node grandchild adds a load of its own. Only loads whose
  // parent started a launcher count, exactly one per launcher.
  it('counts one load per launcher it started, and no grandchild stands in for one', async () => {
    const directory = await scratch();
    await expect(
      readDorkosHostsContacted(join(directory, 'never.jsonl'), [process.pid])
    ).rejects.toThrow('loaded into 0 of the 1');
    const record = join(directory, 'record.jsonl');
    const plain = join(directory, 'launcher.mjs');
    await writeFile(plain, 'process.exitCode = 0;\n');
    // A guarded launcher that starts a guarded node child, which inherits NODE_OPTIONS.
    const parent = join(directory, 'parent.mjs');
    await writeFile(
      parent,
      `import { execFileSync } from 'node:child_process';\nexecFileSync(process.execPath, [${JSON.stringify(plain)}]);\n`
    );
    await runNode(parent, withNoDorkosHostsGuard({}, record));
    // The second launcher ran unguarded. Two loads are on record, but only one is a launcher's.
    await runNode(plain, {});
    const loads = (await readFile(record, 'utf8')).trim().split('\n');
    expect(loads).toHaveLength(2);
    await expect(readDorkosHostsContacted(record, [process.pid, process.pid])).rejects.toThrow(
      'loaded into 1 of the 2'
    );
    await runNode(plain, withNoDorkosHostsGuard({}, record));
    expect(await readDorkosHostsContacted(record, [process.pid, process.pid])).toEqual([]);
    // A best-effort read on a failure path skips the count.
    expect(await readDorkosHostsContacted(join(directory, 'never.jsonl'), null)).toEqual([]);
  });

  // Purpose: fails if the guard changes what `util.promisify` makes of a guarded function (it
  // would drop `dns.lookup`'s own promisified form, resolving a bare address instead of
  // `{ address, family }`), or if the promisified form lets a DorkOS host through.
  it('keeps the promisified shape of dns.lookup and exec, and still refuses', async () => {
    const directory = await scratch();
    const record = join(directory, 'record.jsonl');
    const script = join(directory, 'launcher.mjs');
    await writeFile(
      script,
      `
import { exec } from 'node:child_process';
import dns from 'node:dns';
import { promisify } from 'node:util';
const lookup = promisify(dns.lookup);
const local = await lookup('localhost');
const run = await promisify(exec)('echo hi');
let refused = 'allowed';
try { await lookup('dorkos.ai'); } catch (error) { refused = error.code; }
process.stdout.write(JSON.stringify({ local: typeof local, family: typeof local.family, stdout: run.stdout, refused }));
`
    );
    const result = await runNode(script, withNoDorkosHostsGuard({}, record));
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      local: 'object',
      family: 'number',
      stdout: 'hi\n',
      refused: 'DORKOS_HOST_REFUSED',
    });
    expect(await readDorkosHostsContacted(record, [process.pid])).toEqual(['dorkos.ai']);
  });

  // Purpose: fails if an options field can hide a DorkOS host behind another host-naming field.
  it('checks every host a call names, not only the first', async () => {
    const directory = await scratch();
    const record = join(directory, 'record.jsonl');
    const script = join(directory, 'launcher.mjs');
    await writeFile(
      script,
      `
import https from 'node:https';
import tls from 'node:tls';
const tries = [
  () => tls.connect({ host: '127.0.0.1', port: 9, servername: 'dorkos.ai' }),
  () => https.request('https://api.fly.io/graphql', { hostname: 'cloud.dorkos.ai' }),
];
for (const run of tries) { try { run(); } catch {} }
`
    );
    await runNode(script, withNoDorkosHostsGuard({}, record));
    expect(await readDorkosHostsContacted(record, [process.pid])).toEqual([
      'dorkos.ai',
      'cloud.dorkos.ai',
    ]);
  });

  it('appends itself after any preload already in NODE_OPTIONS', () => {
    const environment = withNoDorkosHostsGuard(
      { NODE_OPTIONS: '--import=file:///fake.mjs', HOME: '/h' },
      '/r.jsonl'
    );
    expect(environment).toEqual({
      NODE_OPTIONS: `--import=file:///fake.mjs --import=${NO_DORKOS_HOSTS_GUARD_URL}`,
      HOME: '/h',
      DORKOS_NO_DORKOS_HOSTS_RECORD: '/r.jsonl',
    });
    expect(NO_DORKOS_HOSTS_GUARD_URL).toMatch(
      /^file:\/\/.*community-deploy-no-dorkos-hosts\.mjs$/u
    );
  });
});

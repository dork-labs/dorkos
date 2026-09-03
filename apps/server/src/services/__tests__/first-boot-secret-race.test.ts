/**
 * Every secret this server mints on first boot must survive two boots at once.
 *
 * The Better Auth signing secret, the local MCP token and a community
 * credential are all resolved the same way — read the `0600` file, or mint one
 * — and each was minted with a plain write, so two processes reaching a fresh
 * data directory together (a server plus a CLI command, a dev server plus the
 * dogfood app) both minted and the last write won. The loser kept a value that
 * is no longer on disk: sessions it signed and clients it handed a token stop
 * verifying, with nothing logged (DOR-712).
 *
 * The race is between processes and every step of it is synchronous, so it
 * cannot be staged inside one Node process — `Promise.all` over two in-process
 * resolvers just runs them in sequence. Each case therefore spawns two real
 * child processes, holds them at a barrier file, and releases them into the
 * mint path together. The assertion is that both racers ended up holding the
 * value that is actually on disk.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** Absolute `file://` URL of a server source file, for the child to import. */
function moduleUrl(relativePath: string): string {
  return pathToFileURL(join(HERE, '..', relativePath)).href;
}

/**
 * What each racer runs: announce readiness, spin until the parent opens the
 * barrier, then call one resolver and print what it got back. Passed as `-e`
 * source with every parameter arriving through the environment, so nothing is
 * interpolated into the program text.
 */
const CHILD_SOURCE = `
const { existsSync, writeFileSync } = await import('node:fs');
const mod = await import(process.env.MODULE_URL);
writeFileSync(process.env.READY_PATH, 'ready');
const deadline = Date.now() + 10_000;
while (!existsSync(process.env.BARRIER_PATH)) {
  if (Date.now() > deadline) throw new Error('barrier never opened');
}
const value = mod[process.env.EXPORT_NAME](...JSON.parse(process.env.ARGS_JSON));
writeFileSync(process.env.RESULT_PATH, String(value));
`;

/** The three secrets minted on the boot path, and how a racer resolves each. */
const SECRETS = [
  {
    name: 'the Better Auth signing secret',
    module: 'core/auth/secret.ts',
    exportName: 'resolveBetterAuthSecret',
    fileName: 'better-auth-secret',
    args: (dorkHome: string) => [dorkHome],
  },
  {
    name: 'the local MCP token',
    module: 'core/auth/mcp-local-token.ts',
    exportName: 'resolveMcpLocalToken',
    fileName: 'mcp-local-token',
    args: (dorkHome: string) => [dorkHome],
  },
  {
    name: 'a community credential',
    module: 'communities/credentials.ts',
    exportName: 'resolveCommunityCredential',
    fileName: join('communities', 'racing-community', 'credential'),
    args: (dorkHome: string) => [dorkHome, 'racing-community'],
  },
] as const;

/**
 * Environment overrides win over every persisted secret, so a racer must never
 * inherit one from the machine running the suite.
 */
const OVERRIDES_TO_CLEAR = [
  'BETTER_AUTH_SECRET',
  'MCP_API_KEY',
  'DORKOS_COMMUNITY_SECRET_RACING_COMMUNITY',
];

/** Run one racer to completion, rejecting on any non-zero exit. */
function runChild(env: Record<string, string>): Promise<void> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const key of OVERRIDES_TO_CLEAR) delete childEnv[key];
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER_URL, '--input-type=module', '-e', CHILD_SOURCE],
      { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`racer exited ${code}: ${stderr}`));
    });
  });
}

/** Resolve once every racer has written its ready file. */
async function waitForReady(readyPaths: string[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!readyPaths.every((p) => existsSync(p))) {
    if (Date.now() > deadline) throw new Error('racers never became ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('first-boot secret race (real processes)', () => {
  let control: string;
  let dorkHome: string;

  beforeEach(() => {
    control = mkdtempSync(join(tmpdir(), 'secret-race-'));
    dorkHome = join(control, 'dork');
  });

  afterEach(() => {
    rmSync(control, { recursive: true, force: true });
  });

  it.each(SECRETS)(
    'two boots agree on $name',
    async (secret) => {
      const barrierPath = join(control, 'barrier');
      const racers = ['a', 'b'];
      const readyPaths = racers.map((id) => join(control, `ready-${id}`));
      const resultPaths = racers.map((id) => join(control, `result-${id}`));

      const running = racers.map((_, i) =>
        runChild({
          MODULE_URL: moduleUrl(secret.module),
          EXPORT_NAME: secret.exportName,
          ARGS_JSON: JSON.stringify(secret.args(dorkHome)),
          READY_PATH: readyPaths[i]!,
          RESULT_PATH: resultPaths[i]!,
          BARRIER_PATH: barrierPath,
        })
      );

      await waitForReady(readyPaths);
      // Both racers are spinning on this file; creating it releases them within
      // microseconds of each other, straight into the mint path.
      writeFileSync(barrierPath, 'go');
      await Promise.all(running);

      const [fromA, fromB] = resultPaths.map((p) => readFileSync(p, 'utf8'));
      const persisted = readFileSync(join(dorkHome, secret.fileName), 'utf8').trim();

      expect(fromA).toBeTruthy();
      // The whole point: the loser adopted the winner's value instead of keeping
      // one that is no longer on disk.
      expect(fromB).toBe(fromA);
      expect(persisted).toBe(fromA);

      if (process.platform !== 'win32') {
        const mode = statSync(join(dorkHome, secret.fileName)).mode & 0o777;
        expect(mode & 0o077).toBe(0);
      }
    },
    60_000
  );
});

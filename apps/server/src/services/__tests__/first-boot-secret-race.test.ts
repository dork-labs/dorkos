/**
 * Every secret this server mints on first boot must survive two boots at once.
 *
 * The Better Auth signing secret, the local MCP token, a community credential
 * and this install's VAPID keypair are all resolved the same way — read the
 * `0600` file, or mint one — and each was minted with a plain write, so two
 * processes reaching a fresh data directory together (a server plus a CLI
 * command, a dev server plus the dogfood app) both minted and the last write
 * won. The loser kept a value that is no longer on disk: sessions it signed,
 * clients it handed a token, browsers it handed a public key — all stop working,
 * with nothing logged (DOR-712).
 *
 * The race is between processes and every step of it is synchronous, so it
 * cannot be staged inside one Node process — `Promise.all` over two in-process
 * resolvers just runs them in sequence. Each case therefore spawns two real
 * child processes, holds them at a barrier file, and releases them into the
 * mint path together, {@link RACE_TRIALS} times over. Both racers must end up
 * holding the value that is actually on disk, and a run in which no trial had
 * both racers arrive first proves nothing, so it fails instead.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { resolveCommunityCredential } from '../communities/credentials.js';
import { resolveMcpLocalToken } from '../core/auth/mcp-local-token.js';
import { resolveBetterAuthSecret } from '../core/auth/secret.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/**
 * How many times each race is run. One trial where both racers see no file is
 * enough to have driven the bug; the repetition is what makes this a regression
 * guard rather than a coin flip.
 */
const RACE_TRIALS = 6;

/**
 * What each racer runs: announce readiness, spin until the parent opens the
 * barrier, record whether the secret file was there on arrival, then call one
 * resolver and write down what it got back. Passed as `-e` source with every
 * parameter arriving through the environment, so nothing is interpolated into
 * the program text.
 */
const CHILD_SOURCE = `
const { existsSync, writeFileSync } = await import('node:fs');
const mod = await import(process.env.MODULE_URL);
writeFileSync(process.env.READY_PATH, 'ready');
const deadline = Date.now() + 10_000;
while (!existsSync(process.env.BARRIER_PATH)) {
  if (Date.now() > deadline) throw new Error('barrier never opened');
}
const arrivedFirst = !existsSync(process.env.SECRET_PATH);
const resolved = mod[process.env.EXPORT_NAME](...JSON.parse(process.env.ARGS_JSON));
const value = process.env.RESULT_FIELD ? resolved[process.env.RESULT_FIELD] : resolved;
writeFileSync(process.env.RESULT_PATH, JSON.stringify({ value, arrivedFirst }));
`;

/** One secret minted on the boot path, and how a racer resolves it. */
interface RacedSecret {
  /** Name in the test title. */
  name: string;
  /** Server source file, relative to `services/`, holding the resolver. */
  module: string;
  /** Exported resolver the racer calls. */
  exportName: string;
  /** Where the secret lands, relative to the data directory. */
  fileName: string;
  /** Arguments for the resolver. */
  args: (dorkHome: string) => unknown[];
  /** Field to compare when the resolver answers an object rather than a string. */
  resultField?: string;
  /** The value a racer should hold, read out of the persisted file. */
  persistedValue: (raw: string) => string;
  /** Resolve the secret in THIS process (used by the leftover-file cases). */
  resolveHere: (dorkHome: string) => unknown;
}

const SECRETS: RacedSecret[] = [
  {
    name: 'the Better Auth signing secret',
    module: 'core/auth/secret.ts',
    exportName: 'resolveBetterAuthSecret',
    fileName: 'better-auth-secret',
    args: (dorkHome) => [dorkHome],
    persistedValue: (raw) => raw.trim(),
    resolveHere: (dorkHome) => resolveBetterAuthSecret(dorkHome),
  },
  {
    name: 'the local MCP token',
    module: 'core/auth/mcp-local-token.ts',
    exportName: 'resolveMcpLocalToken',
    fileName: 'mcp-local-token',
    args: (dorkHome) => [dorkHome],
    persistedValue: (raw) => raw.trim(),
    resolveHere: (dorkHome) => resolveMcpLocalToken(dorkHome),
  },
  {
    name: 'a community credential',
    module: 'communities/credentials.ts',
    exportName: 'resolveCommunityCredential',
    fileName: join('communities', 'racing-community', 'credential'),
    args: (dorkHome) => [dorkHome, 'racing-community'],
    persistedValue: (raw) => raw.trim(),
    resolveHere: (dorkHome) =>
      resolveCommunityCredential(dorkHome, 'racing-community' as CommunityRef),
  },
  {
    name: 'the VAPID keypair',
    module: 'notifications/channels/web-push.ts',
    exportName: 'readOrCreateVapidKeys',
    fileName: join('push', 'vapid.json'),
    args: (dorkHome) => [dorkHome],
    // Only the public half crosses the test boundary; the private half never
    // needs to leave the file to prove the two boots agree.
    resultField: 'publicKey',
    persistedValue: (raw) => (JSON.parse(raw) as { publicKey: string }).publicKey,
    // The keypair is not a text secret: an unparseable file is deliberately set
    // aside and replaced, so it has no leftover-file case here.
    resolveHere: () => undefined,
  },
];

/**
 * Environment overrides win over every persisted secret, so a racer must never
 * inherit one from the machine running the suite.
 */
const OVERRIDES_TO_CLEAR = [
  'BETTER_AUTH_SECRET',
  'MCP_API_KEY',
  'DORKOS_COMMUNITY_SECRET_RACING_COMMUNITY',
];

/** What one racer reported back. */
interface RacerReport {
  value: string;
  arrivedFirst: boolean;
}

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

  beforeEach(() => {
    control = mkdtempSync(join(tmpdir(), 'secret-race-'));
  });

  afterEach(() => {
    rmSync(control, { recursive: true, force: true });
  });

  it.each(SECRETS)(
    'two boots agree on $name',
    async (secret) => {
      let trialsWhereBothArrivedFirst = 0;

      for (let trial = 0; trial < RACE_TRIALS; trial++) {
        const trialDir = join(control, `${secret.exportName}-${trial}`);
        mkdirSync(trialDir, { recursive: true });
        const dorkHome = join(trialDir, 'dork');
        const secretPath = join(dorkHome, secret.fileName);
        const barrierPath = join(trialDir, 'barrier');
        const racers = ['a', 'b'];
        const readyPaths = racers.map((id) => join(trialDir, `ready-${id}`));
        const resultPaths = racers.map((id) => join(trialDir, `result-${id}`));

        const running = racers.map((_, i) =>
          runChild({
            MODULE_URL: pathToFileURL(join(HERE, '..', secret.module)).href,
            EXPORT_NAME: secret.exportName,
            ARGS_JSON: JSON.stringify(secret.args(dorkHome)),
            SECRET_PATH: secretPath,
            READY_PATH: readyPaths[i]!,
            RESULT_PATH: resultPaths[i]!,
            BARRIER_PATH: barrierPath,
            ...(secret.resultField ? { RESULT_FIELD: secret.resultField } : {}),
          })
        );

        await waitForReady(readyPaths);
        // Both racers are spinning on this file; creating it releases them within
        // microseconds of each other, straight into the mint path.
        writeFileSync(barrierPath, 'go');
        await Promise.all(running);

        const reports = resultPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as RacerReport);
        if (reports.every((r) => r.arrivedFirst)) trialsWhereBothArrivedFirst++;

        const persisted = secret.persistedValue(readFileSync(secretPath, 'utf8'));
        expect(reports[0]!.value).toBeTruthy();
        // The whole point: the loser adopted the winner's value instead of keeping
        // one that is no longer on disk.
        expect(reports[1]!.value).toBe(reports[0]!.value);
        expect(persisted).toBe(reports[0]!.value);

        if (process.platform !== 'win32') {
          expect(statSync(secretPath).mode & 0o077).toBe(0);
        }
      }

      // Without this the suite could pass by never reproducing the interleave.
      expect(trialsWhereBothArrivedFirst).toBeGreaterThan(0);
    },
    180_000
  );
});

describe('a secret file left blank by a crashed first write', () => {
  let dorkHome: string;

  beforeEach(() => {
    dorkHome = mkdtempSync(join(tmpdir(), 'secret-leftover-'));
  });

  afterEach(() => {
    rmSync(dorkHome, { recursive: true, force: true });
  });

  // A blank file is never something the claim published — the content is
  // complete before the name exists — so it predates DOR-712 or came from
  // somewhere else. Minting over it is the destructive guess: whatever it holds
  // may already have signed sessions or encrypted data.
  it.each(SECRETS.filter((s) => s.name !== 'the VAPID keypair'))(
    'is refused rather than overwritten for $name',
    (secret) => {
      const secretPath = join(dorkHome, secret.fileName);
      mkdirSync(dirname(secretPath), { recursive: true });
      writeFileSync(secretPath, '', { mode: 0o600 });

      expect(() => secret.resolveHere(dorkHome)).toThrow(/does not hold a usable secret/);
      expect(readFileSync(secretPath, 'utf8')).toBe('');
    }
  );
});

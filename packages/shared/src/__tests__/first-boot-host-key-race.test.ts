/**
 * Two first boots against one fresh data directory must agree on `host.key`.
 *
 * The race is between PROCESSES and every step of it is synchronous, so it
 * cannot be staged inside one Node process: `Promise.all` over two in-process
 * minters simply runs them one after the other. This suite therefore spawns two
 * real child processes, releases them from a barrier at the same instant, and
 * has each encrypt a known value under whatever host key it ended up with. The
 * assertion is the user-visible property, not the file's existence: both
 * ciphertexts must still decrypt afterwards. Before DOR-712 the loser's key was
 * overwritten and its secret became permanently unreadable.
 *
 * A barrier is not a guarantee, so the race is run {@link RACE_TRIALS} times and
 * every racer reports whether the key file existed when it started. A run where
 * no trial had both racers arrive first would have proved nothing, and fails
 * rather than passing quietly.
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
import { ExtensionSecretStore, resetKeyCache } from '../extension-secrets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_SECRETS_URL = pathToFileURL(join(HERE, '..', 'extension-secrets.ts')).href;
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/**
 * How many times the race is run. Each trial is a fresh data directory, and one
 * trial where both racers see no key is enough to have driven the bug; the
 * repetition is what keeps this a regression guard rather than a coin flip.
 */
const RACE_TRIALS = 8;

/**
 * What each child runs: announce readiness, spin until the parent opens the
 * barrier, record whether the key file was there on arrival, then mint-or-adopt
 * the host key and encrypt one probe value with it. Passed as `-e` source (the
 * precedent in `session-pump-shutdown.integration.test.ts`) with every parameter
 * arriving through the environment, so nothing is interpolated into the
 * program text.
 */
const CHILD_SOURCE = `
const { existsSync, writeFileSync } = await import('node:fs');
const { ExtensionSecretStore } = await import(process.env.MODULE_URL);
writeFileSync(process.env.READY_PATH, 'ready');
const deadline = Date.now() + 10_000;
while (!existsSync(process.env.BARRIER_PATH)) {
  if (Date.now() > deadline) throw new Error('barrier never opened');
}
const arrivedFirst = !existsSync(process.env.HOST_KEY_PATH);
const store = new ExtensionSecretStore(process.env.EXTENSION_ID, process.env.RACE_HOME);
await store.set('probe', process.env.PLAINTEXT);
writeFileSync(process.env.RESULT_PATH, arrivedFirst ? 'first' : 'second');
`;

/** Run one racer to completion, rejecting on any non-zero exit. */
function runChild(env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER_URL, '--input-type=module', '-e', CHILD_SOURCE],
      {
        // eslint-disable-next-line no-restricted-syntax -- handing a child process the parent's environment, not reading a DorkOS setting
        env: { ...process.env, ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
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
  const deadline = Date.now() + 20_000;
  while (!readyPaths.every((p) => existsSync(p))) {
    if (Date.now() > deadline) throw new Error('racers never became ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('first-boot host.key race (real processes)', () => {
  let control: string;

  beforeEach(() => {
    control = mkdtempSync(join(tmpdir(), 'host-key-race-'));
    resetKeyCache();
  });

  afterEach(() => {
    resetKeyCache();
    rmSync(control, { recursive: true, force: true });
  });

  it('leaves both racers encrypting under the same host key', async () => {
    const racers = [
      { extensionId: 'racer-a', plaintext: 'secret-from-a' },
      { extensionId: 'racer-b', plaintext: 'secret-from-b' },
    ];
    let trialsWhereBothArrivedFirst = 0;

    for (let trial = 0; trial < RACE_TRIALS; trial++) {
      const trialDir = join(control, `trial-${trial}`);
      mkdirSync(trialDir, { recursive: true });
      const dorkHome = join(trialDir, 'dork');
      const barrierPath = join(trialDir, 'barrier');
      const readyPaths = racers.map((r) => join(trialDir, `ready-${r.extensionId}`));
      const resultPaths = racers.map((r) => join(trialDir, `result-${r.extensionId}`));

      const running = racers.map((racer, i) =>
        runChild({
          MODULE_URL: EXTENSION_SECRETS_URL,
          RACE_HOME: dorkHome,
          HOST_KEY_PATH: join(dorkHome, 'host.key'),
          EXTENSION_ID: racer.extensionId,
          PLAINTEXT: racer.plaintext,
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

      if (resultPaths.every((p) => readFileSync(p, 'utf8') === 'first')) {
        trialsWhereBothArrivedFirst++;
      }

      // A third process reads whatever host key survived. Every value encrypted
      // during the race must still decrypt under it.
      resetKeyCache();
      for (const racer of racers) {
        const store = new ExtensionSecretStore(racer.extensionId, dorkHome);
        await expect(store.get('probe')).resolves.toBe(racer.plaintext);
      }
    }

    // Without this the suite could pass by never reproducing the interleave.
    expect(trialsWhereBothArrivedFirst).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(process.platform === 'win32')('keeps the host key owner-only', async () => {
    const dorkHome = join(control, 'modes');
    const store = new ExtensionSecretStore('mode-check', dorkHome);
    await store.set('probe', 'value');

    const mode = statSync(join(dorkHome, 'host.key')).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('refuses a truncated host.key instead of minting over it', async () => {
    const dorkHome = join(control, 'leftover');
    mkdirSync(dorkHome, { recursive: true });
    const keyPath = join(dorkHome, 'host.key');
    // What a crashed pre-DOR-712 mint left behind. Deriving from it silently
    // was one bug; replacing it silently is the other.
    writeFileSync(keyPath, Buffer.alloc(0), { mode: 0o600 });

    const store = new ExtensionSecretStore('leftover', dorkHome);
    await expect(store.set('probe', 'value')).rejects.toThrow(/does not hold a usable secret/);
    expect(readFileSync(keyPath).length).toBe(0);
  });
});

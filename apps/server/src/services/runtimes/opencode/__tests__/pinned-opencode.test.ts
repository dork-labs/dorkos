/**
 * @vitest-environment node
 */
import { EventEmitter } from 'node:events';
import type { spawn, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createByteLane,
  RunStartError,
  type RunChild,
  type RunRequest,
} from '@dorkos/test-utils/run-custody';
import { WorkerCleanupError } from './custody/worker.js';
import {
  guardPinnedOpenCodePort,
  isPinnedFixtureCleanupUncertain,
  runOwnedPinnedOpenCode,
} from './pinned-opencode-owned.js';
import {
  OPENCODE_PIN,
  pinnedOpenCode,
  withUnchangedBinary,
  guardedOpenCodeSpawn,
} from './pinned-opencode.js';

type Manifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

/** The server package's manifest, which pins the SDK. */
const serverPackage = JSON.parse(
  fs.readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8')
) as Manifest;

/** The test-utils manifest, which installs the binary (test-only, so it never ships). */
const testUtilsPackage = JSON.parse(
  fs.readFileSync(
    new URL('../../../../../../../packages/test-utils/package.json', import.meta.url),
    'utf8'
  )
) as Manifest;

/** The `opencode-*` entries in a manifest's optional dependencies. */
function openCodePins(manifest: Manifest): [string, string][] {
  return Object.entries(manifest.optionalDependencies ?? {}).filter(([name]) =>
    name.startsWith('opencode-')
  );
}

const HERE = `${process.platform}-${process.arch}`;

describe('the pinned OpenCode binary', () => {
  // On the server it would ship, and the desktop build would read the server
  // as a per-platform package and refuse to bundle it.
  it('is never a dependency of the server itself', () => {
    expect(openCodePins(serverPackage)).toEqual([]);
  });

  it('installs every pinned platform at exactly the pinned version, and nothing else', () => {
    const installed = openCodePins(testUtilsPackage);
    expect(Object.fromEntries(installed)).toEqual(
      Object.fromEntries(
        Object.keys(OPENCODE_PIN.sha256).map((key) => [`opencode-${key}`, OPENCODE_PIN.version])
      )
    );
  });

  it('pins the CLI to the SDK’s version', () => {
    expect(serverPackage.dependencies?.['@opencode-ai/sdk']).toBe(`^${OPENCODE_PIN.version}`);
  });

  it('has nothing to run on a platform with no recorded hash', () => {
    expect(pinnedOpenCode('plan9', 'mips')).toBeNull();
  });

  // The real-binary tests skip where nothing is pinned. CI must never be such a
  // place, or they would stop running there without anyone noticing.
  it.runIf(process.env.CI)('finds a pinned binary on the CI runner', () => {
    expect(OPENCODE_PIN.sha256[HERE], `no OpenCode pin for ${HERE}`).toBeDefined();
    expect(pinnedOpenCode()).not.toBeNull();
  });

  it.skipIf(!OPENCODE_PIN.sha256[HERE])('hands back only a file whose bytes match the pin', () => {
    const binary = pinnedOpenCode()!;
    const actual = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    expect(actual).toBe(OPENCODE_PIN.sha256[HERE]);
  });
});

describe('fresh binary integrity checks', () => {
  async function fixture(run: (file: string, hash: string) => Promise<void>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-integrity-'));
    const file = path.join(root, 'binary');
    fs.writeFileSync(file, 'original executable bytes');
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    try {
      await run(file, hash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  function owned(executable: string, hash: string) {
    const stdin = createByteLane();
    const stdout = createByteLane();
    let close!: (value: Awaited<RunChild['close']>) => void;
    const closed = new Promise<Awaited<RunChild['close']>>((resolve) => {
      close = resolve;
    });
    const identity = { pid: 721, executable, birth: 'synthetic' };
    const stopAndJoin = vi
      .fn<RunChild['stopAndJoin']>()
      .mockResolvedValue({ kind: 'cleaned-owned' });
    const child: RunChild = {
      ...identity,
      stdin: stdin.writer,
      stdout: stdout.reader,
      spawn: Promise.resolve({ kind: 'spawned', ...identity }),
      exit: Promise.resolve({ kind: 'exited', code: 0, signal: null }),
      close: closed,
      stopAndJoin,
    };
    const start = vi.fn(async (_request: RunRequest) => child);
    const port = guardPinnedOpenCodePort({ start }, () => ({ executable, sha256: hash }));
    const run = (env: RunRequest['env'] = {}) =>
      port.start(
        {
          executable,
          argv: ['run'],
          cwd: path.dirname(executable),
          env,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        },
        new AbortController().signal
      );
    return { child, run, start, close, stdin, stdout, stopAndJoin, identity };
  }

  it('checks selected bytes at PRE and native close and joins after the fixture operation', async () => {
    await fixture(async (file, hash) => {
      const f = owned(file, hash);
      let observer: NonNullable<RunRequest['observer']>;
      f.start.mockImplementation(async (request) => {
        observer = request.observer!;
        expect(request.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
        expect(JSON.parse(String(request.env.OPENCODE_CONFIG_CONTENT))).toEqual({
          autoupdate: false,
          model: 'fixture',
        });
        await observer.beforeSpawn!(file);
        await observer.onSpawn(f.identity);
        await f.stdout.writer.write(new Uint8Array([42]));
        f.stdout.writer.end();
        return f.child;
      });
      const child = await f.run({
        OPENCODE_CONFIG_CONTENT: '{"autoupdate":true,"model":"fixture"}',
      });
      f.stopAndJoin.mockImplementation(async () => {
        await observer.onClose({ integrity: 'unobserved' });
        f.close({ kind: 'native-closed', integrity: 'verified' });
        return { kind: 'cleaned-owned' };
      });
      await expect(
        runOwnedPinnedOpenCode(child, async (runChild) => {
          expect(await f.stdin.reader.read()).toEqual({ kind: 'eof' });
          expect(await runChild.stdout!.read()).toEqual({
            kind: 'bytes',
            frame: new Uint8Array([42]),
          });
          return 42;
        })
      ).resolves.toBe(42);
      expect(f.stopAndJoin).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects wrong executable before admitting a native creation', async () => {
    await fixture(async (file, hash) => {
      const f = owned(file, hash);
      const admitted = vi.fn();
      const wrapper = path.join(path.dirname(file), 'wrapper');
      fs.writeFileSync(wrapper, fs.readFileSync(file));
      f.start.mockImplementation(async (request) => {
        await request.observer!.beforeSpawn!(wrapper);
        admitted();
        return f.child;
      });
      await expect(f.run()).rejects.toThrow('Unexpected native executable');
      expect(admitted).not.toHaveBeenCalled();
    });
  });

  it.each(['skipped', 'out-of-order'] as const)(
    'rejects %s PRE and joins an already returned child',
    async (mode) => {
      await fixture(async (file, hash) => {
        const f = owned(file, hash);
        f.start.mockImplementation(async (request) => {
          if (mode === 'out-of-order') {
            await expect(
              Promise.resolve().then(() => request.observer!.onSpawn(f.identity))
            ).rejects.toThrow(/out of order/);
          }
          return f.child;
        });
        const failed = f.run();
        await expect(failed).rejects.toBeInstanceOf(RunStartError);
        await expect(failed).rejects.toMatchObject({
          outcome: { kind: 'spawn-failed', cleanup: { kind: 'cleaned-owned' } },
        });
        expect(f.stopAndJoin).toHaveBeenCalledTimes(1);
      });
    }
  );

  it.each(['mutation', 'lost'] as const)(
    'preserves primary and integrity failure after %s while joining',
    async (mode) => {
      await fixture(async (file, hash) => {
        const f = owned(file, hash);
        let observer: NonNullable<RunRequest['observer']>;
        f.start.mockImplementation(async (request) => {
          observer = request.observer!;
          await observer.beforeSpawn!(file);
          await observer.onSpawn(f.identity);
          return f.child;
        });
        const child = await f.run();
        f.stopAndJoin.mockImplementation(async () => {
          if (mode === 'mutation') {
            fs.writeFileSync(file, 'mutated after launch');
            await expect(
              Promise.resolve().then(() => observer.onClose({ integrity: 'unobserved' }))
            ).rejects.toThrow(/SHA-256 changed/);
            f.close({ kind: 'native-closed', integrity: 'failed' });
          } else {
            f.close({ kind: 'transport-lost' });
          }
          return { kind: 'cleaned-owned' };
        });
        const primary = new Error('fixture consumer failed');
        await expect(
          runOwnedPinnedOpenCode(child, async () => {
            throw primary;
          })
        ).rejects.toMatchObject({
          errors: [
            primary,
            expect.objectContaining({
              message: 'Pinned OpenCode POST was not verified at native close',
            }),
          ],
        });
        expect(f.stopAndJoin).toHaveBeenCalledTimes(1);
      });
    }
  );

  it('retains uncertainty from typed startup and worker outcomes only', () => {
    const never = new RunStartError({ kind: 'never-acquired', reason: 'no-target' });
    const uncertain = new RunStartError({
      kind: 'interrupted',
      reason: 'owner-lost',
      cleanup: { kind: 'cleanup-uncertain', reason: 'deadline' },
    });
    const worker = new WorkerCleanupError({ channel: 'pending', request: 'closed' }, 'deadline');
    expect(isPinnedFixtureCleanupUncertain(never)).toBe(false);
    expect(isPinnedFixtureCleanupUncertain(new Error(worker.message))).toBe(false);
    expect(isPinnedFixtureCleanupUncertain(uncertain)).toBe(true);
    expect(isPinnedFixtureCleanupUncertain(new AggregateError([never, worker]))).toBe(true);
  });

  it.each(['uncertain', 'unacquired', 'rejected'] as const)(
    'retains a returned child on %s join and keeps the primary failure',
    async (mode) => {
      await fixture(async (file, hash) => {
        const f = owned(file, hash);
        let observer: NonNullable<RunRequest['observer']>;
        f.start.mockImplementation(async (request) => {
          observer = request.observer!;
          await observer.beforeSpawn!(file);
          await observer.onSpawn(f.identity);
          return f.child;
        });
        const child = await f.run();
        const joinError = new Error('fixture join error');
        f.stopAndJoin.mockImplementation(async () => {
          await observer.onClose({ integrity: 'unobserved' });
          f.close({ kind: 'native-closed', integrity: 'verified' });
          if (mode === 'rejected') throw joinError;
          return mode === 'uncertain'
            ? { kind: 'cleanup-uncertain', reason: 'deadline' }
            : { kind: 'never-acquired', reason: 'contradictory-returned-child' };
        });
        const primary = new Error('fixture consumer failed');
        const failure = await runOwnedPinnedOpenCode(child, async () => {
          throw primary;
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure).toMatchObject({ errors: [primary, expect.any(Error)] });
        expect(isPinnedFixtureCleanupUncertain(failure)).toBe(true);
        if (mode === 'rejected')
          expect(failure).toMatchObject({ errors: [primary, { cause: joinError }] });
      });
    }
  );

  it('returns the result when the binary is unchanged', async () => {
    await fixture(async (file, hash) => {
      await expect(withUnchangedBinary(file, hash, async () => 42)).resolves.toBe(42);
    });
  });

  it.each([false, true])('refuses post-run mutation even when the run fails: %s', async (fails) => {
    await fixture(async (file, hash) => {
      await expect(
        withUnchangedBinary(file, hash, async () => {
          fs.writeFileSync(file, 'changed executable bytes');
          if (fails) throw new Error('run failed');
        })
      ).rejects.toThrow('does not match its pinned SHA-256');
    });
  });

  it('refuses changed bytes before a subsequent run starts', async () => {
    await fixture(async (file, hash) => {
      await withUnchangedBinary(file, hash, async () => undefined);
      fs.writeFileSync(file, 'changed between runs');
      let started = false;
      await expect(
        withUnchangedBinary(file, hash, async () => {
          started = true;
        })
      ).rejects.toThrow('does not match its pinned SHA-256');
      expect(started).toBe(false);
    });
  });

  it('preserves an operation failure when the binary is unchanged', async () => {
    await fixture(async (file, hash) => {
      await expect(
        withUnchangedBinary(file, hash, async () => {
          throw new Error('run failed');
        })
      ).rejects.toThrow('run failed');
    });
  });
});

it.skipIf(!OPENCODE_PIN.sha256[HERE])(
  'every guarded spawn overrides self-update settings while preserving config',
  async () => {
    const child = new EventEmitter();
    const spawnBinary = vi.fn(() => child);
    const result = guardedOpenCodeSpawn(
      spawnBinary as unknown as typeof spawn,
      pinnedOpenCode()!,
      ['serve'],
      {
        env: {
          OPENCODE_DISABLE_AUTOUPDATE: '0',
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: true, model: 'fake/x' }),
        },
      }
    );
    const options = spawnBinary.mock.calls[0] as unknown as [string, string[], SpawnOptions];
    expect(options[2].env?.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(JSON.parse(String(options[2].env?.OPENCODE_CONFIG_CONTENT))).toEqual({
      autoupdate: false,
      model: 'fake/x',
    });
    child.emit('close');
    await expect(result.verified).resolves.toBeUndefined();
  }
);

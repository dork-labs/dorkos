import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ports = vi.hoisted(() => ({ run: vi.fn(), verify: vi.fn(), config: Buffer.alloc(0) }));
vi.mock('./public-native-input.js', () => ({
  boundedOriginalFile: async () => ports.config,
  readPublicNativeInput: async () => ({ home: '/original-input', cliEntry: '/original-cli' }),
  verifyPublicNativeEmits: (...args: unknown[]) => ports.verify(...args),
}));
vi.mock('./private-storage-runner.fixture.js', () => ({
  runPrivateOriginalStorageWindow: (...args: unknown[]) => ports.run(...args),
}));
beforeEach(() => {
  vi.resetModules();
  ports.run.mockReset();
  ports.verify.mockReset();
  ports.verify.mockImplementation((_input: unknown, current: () => void) => current());
});

type EntryPorts = {
  signal: AbortSignal;
  current(): void;
  retain(value: unknown): Promise<void>;
  retainRetirement(value: unknown): Promise<void>;
};
async function originalEntry() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'original-storage-entry-')));
  const artifacts = join(root, 'exclusive');
  ports.config = Buffer.from(
    JSON.stringify({ input: '/original-input.json', node: process.execPath, artifacts })
  );
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = [process.execPath, '/original-entry', '/original-config.json'];
  const stop = new Map<string, () => void>();
  // Capture only this entry's original registered callback. Do not signal the Vitest owner.
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, callback: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      stop.set(event, callback);
      return process;
    }
    return originalOn(event, callback);
  }) as typeof process.on);
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    completed();
  });
  onTestFinished(async () => {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  return { artifacts, stop, done, error };
}

it('actual direct entry cancellation retains independent retirement facts before original return', async () => {
  const entry = await originalEntry();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const captured: { original?: EntryPorts } = {};
  ports.run.mockImplementation(async (options: EntryPorts) => {
    captured.original = options;
    entered();
    await held;
    await options.retainRetirement({
      kind: 'original-storage-retirement',
      round: 0,
      knownBirths: [],
      observed: [],
    });
    options.current();
  });
  try {
    await import('./private-storage-entry.fixture.js');
    await Promise.race([
      started,
      entry.done.then(() => {
        throw new Error('Original entry failed before held runner');
      }),
    ]);
    expect(entry.stop.has('SIGTERM')).toBe(true);
    entry.stop.get('SIGTERM')!();
    expect(captured.original?.signal.aborted).toBe(true);
    expect(() => captured.original?.current()).toThrow('STORAGE_ORIGINAL_PARENT_STOP');
    expect(entry.error).not.toHaveBeenCalled();
  } finally {
    release();
    await entry.done;
  }
  const result = JSON.parse(await readFile(join(entry.artifacts, 'RESULT.json'), 'utf8'));
  expect(result).toMatchObject({
    returned: 'FAIL',
    reports: [{ kind: 'original-storage-retirement', round: 0 }],
  });
  expect(entry.error.mock.calls[0][1]).toBe(captured.original?.signal.reason);
});

it.each([false, undefined])(
  'actual direct entry exports joined cleanup report and exact primary %s',
  async (value) => {
    const entry = await originalEntry();
    ports.run.mockImplementation(async (options: EntryPorts) => {
      await options.retainRetirement({
        kind: 'original-storage-retirement',
        round: 2,
        knownBirths: [],
        observed: [],
      });
      throw value;
    });
    await import('./private-storage-entry.fixture.js');
    await entry.done;
    const result = JSON.parse(await readFile(join(entry.artifacts, 'RESULT.json'), 'utf8'));
    expect(result).toMatchObject({
      returned: 'FAIL',
      reports: [{ kind: 'original-storage-retirement', round: 2 }],
    });
    expect(entry.error.mock.calls[0][1]).toBe(value);
    expect(ports.verify).not.toHaveBeenCalled();
  }
);

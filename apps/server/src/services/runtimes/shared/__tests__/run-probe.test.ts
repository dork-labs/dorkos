import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runBinaryProbe, findBinaryOnPath } from '../run-probe.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

type ProbeOutcome = { stdout?: string } | { error: Error } | 'hang';

function onExecFile(handler: (file: string, args: string[]) => ProbeOutcome) {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const outcome = handler(file, args);
    if (outcome === 'hang') return {} as never;
    if ('error' in outcome) cb(outcome.error, '', '');
    else cb(null, outcome.stdout ?? '', '');
    return {} as never;
  }) as typeof execFile);
}

const TIMEOUT = 5_000;

describe('runBinaryProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves trimmed stdout on success', async () => {
    onExecFile(() => ({ stdout: '  codex-cli 0.142.5 \n' }));
    await expect(runBinaryProbe('/bin/codex', ['--version'], TIMEOUT)).resolves.toBe(
      'codex-cli 0.142.5'
    );
  });

  it('rejects when the process exits non-zero (callback error)', async () => {
    onExecFile(() => ({ error: Object.assign(new Error('boom'), { code: 1 }) }));
    await expect(runBinaryProbe('/bin/codex', ['login', 'status'], TIMEOUT)).rejects.toThrow(
      'boom'
    );
  });

  it('rejects within the bounded window when the child hangs (never blocks)', async () => {
    vi.useFakeTimers();
    onExecFile(() => 'hang');

    const promise = runBinaryProbe('/bin/codex', ['--version'], TIMEOUT);
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    await assertion;
  });
});

describe('findBinaryOnPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the first PATH match when the located file exists', async () => {
    onExecFile(() => ({ stdout: '/usr/local/bin/codex\n/other/codex\n' }));
    vi.mocked(existsSync).mockReturnValue(true);

    await expect(findBinaryOnPath('codex', TIMEOUT)).resolves.toBe('/usr/local/bin/codex');
  });

  it('returns null when the binary is not on PATH (locator errors)', async () => {
    onExecFile(() => ({ error: new Error('not found') }));
    await expect(findBinaryOnPath('codex', TIMEOUT)).resolves.toBeNull();
  });

  it('returns null when the located path does not exist', async () => {
    onExecFile(() => ({ stdout: '/ghost/codex\n' }));
    vi.mocked(existsSync).mockReturnValue(false);
    await expect(findBinaryOnPath('codex', TIMEOUT)).resolves.toBeNull();
  });

  it('returns null (does not hang) when the locator times out', async () => {
    vi.useFakeTimers();
    onExecFile(() => 'hang');

    const promise = findBinaryOnPath('codex', TIMEOUT);
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
    await expect(promise).resolves.toBeNull();
  });
});

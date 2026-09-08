import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  runBinaryProbe,
  findBinaryOnPath,
  logProbeFailure,
  logLocatorFailure,
  resetProbeFailureNotices,
} from '../run-probe.js';
import { logger } from '../../../../lib/logger.js';

vi.mock('../../../core/config-manager.js', () => ({ configManager: { get: () => undefined } }));

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

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

describe('logLocatorFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Purpose: "not installed" is ordinary. It must not shout, or every honest
  // `missing` would come with a warning nobody can act on.
  it('logs at debug when the locator ran and reported nothing', () => {
    logLocatorFailure(
      'claude',
      Object.assign(new Error('Command failed: which claude'), { code: 1 })
    );
    logLocatorFailure(
      'claude',
      Object.assign(new Error('Command failed: which claude'), { status: 1 })
    );

    expect(logger.debug).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Purpose: a locator that was killed at the bound never established "not
  // found" — that is how a present binary reads as missing on a loaded machine
  // (the reviewer hit exactly this).
  it('warns when the locator never answered (timed out or could not spawn)', () => {
    logLocatorFailure('claude', new Error('probe timed out after 5000ms: which'));
    logLocatorFailure('codex', Object.assign(new Error('spawn which ENOENT'), { code: 'ENOENT' }));

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(logger.warn).mock.calls[0][0])).toContain('could not establish');
  });
});

describe('logProbeFailure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProbeFailureNotices();
  });

  // Purpose: F2 was invisible from outside because every probe swallowed its
  // error. A person reading the server log must be able to see WHICH check
  // failed, on WHICH binary, and why.
  it('warns with the check, the binary path and the error code', () => {
    const err = Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });

    logProbeFailure('Claude Code CLI', '/app.asar/node_modules/sdk/claude', err);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, details] = vi.mocked(logger.warn).mock.calls[0] as [string, unknown];
    expect(message).toContain('Claude Code CLI');
    expect(details).toMatchObject({
      binary: '/app.asar/node_modules/sdk/claude',
      code: 'ENOTDIR',
      error: 'spawn ENOTDIR',
    });
  });

  // Purpose: a requirements poll runs these probes repeatedly; the same failure
  // must not fill the log.
  it('logs one notice per distinct check + binary + code', () => {
    const err = Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });

    logProbeFailure('Claude Code CLI', '/a/claude', err);
    logProbeFailure('Claude Code CLI', '/a/claude', err);

    expect(logger.warn).toHaveBeenCalledTimes(1);

    // A different binary, a different code, or a different check is news again.
    logProbeFailure('Claude Code CLI', '/b/claude', err);
    logProbeFailure('Claude Code CLI', '/a/claude', Object.assign(new Error('nope'), { code: 1 }));
    logProbeFailure('Claude Code authentication', '/a/claude', err);
    expect(logger.warn).toHaveBeenCalledTimes(4);
  });

  // Purpose: an error with no `code` (a bounded-out probe rejects with a plain
  // Error) must still say something useful rather than log `undefined`.
  it('falls back to the message when the error carries no code', () => {
    logProbeFailure(
      'Codex CLI',
      '/bin/codex',
      new Error('probe timed out after 5000ms: /bin/codex')
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, details] = vi.mocked(logger.warn).mock.calls[0] as [string, { code?: string }];
    expect(details.code).toBeUndefined();
    expect(details).toMatchObject({ error: 'probe timed out after 5000ms: /bin/codex' });
  });
});

describe('actual probe environment purposes', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('keeps locators credential-free and gives auth probes only selected credentials', async () => {
    vi.stubEnv('MCP_API_KEY', 'synthetic-server');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-encryption');
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-claude');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai');
    vi.stubEnv('DO_NOT_TRACK', '1');
    vi.mocked(execFile).mockClear();
    onExecFile(() => ({ stdout: '/synthetic/bin' }));
    vi.mocked(existsSync).mockReturnValue(true);
    await findBinaryOnPath('codex', TIMEOUT, 'codex');
    await runBinaryProbe('/synthetic/codex', ['login', 'status'], TIMEOUT, {
      runtime: 'codex',
      purpose: 'auth-probe',
    });
    const options = vi
      .mocked(execFile)
      .mock.calls.map((call) => call[2] as { env?: NodeJS.ProcessEnv });
    expect(options).toHaveLength(2);
    expect(options[0].env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options[1].env).toHaveProperty('OPENAI_API_KEY', 'synthetic-openai');
    for (const { env } of options) {
      expect(env).toHaveProperty('DO_NOT_TRACK', '1');
      for (const name of ['ANTHROPIC_API_KEY', 'NANGO_ENCRYPTION_KEY', 'MCP_API_KEY'])
        expect(env).not.toHaveProperty(name);
    }
    expect(JSON.stringify(vi.mocked(execFile).mock.calls.map((call) => call[1]))).not.toContain(
      'synthetic-openai'
    );
  });
});

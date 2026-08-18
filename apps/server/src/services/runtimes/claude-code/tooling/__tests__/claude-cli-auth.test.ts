/**
 * The readiness probe's own resolution ladder, exercised end-to-end (the real
 * `sdk-utils` rungs, only `node:fs`/`node:module` and the PATH lookup faked).
 *
 * The bug this pins down: `resolveClaudeBinaryPath` and the SDK spawn seam used
 * to resolve DIFFERENTLY, so the packaged Mac app ran sessions on a `claude` its
 * own requirements ladder reported as missing (DOR-1334 / F2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findBinaryOnPath,
  runBinaryProbe,
  resetProbeFailureNotices,
} from '../../../shared/run-probe.js';
import { logger } from '../../../../../lib/logger.js';
import { resolveClaudeBinaryPath, isClaudeCliAuthenticated } from '../claude-cli-auth.js';
import { resolveClaudeCliPath } from '../../sdk/sdk-utils.js';

const h = vi.hoisted(() => ({
  resolve: ((_s: string): string => {
    throw new Error('not found');
  }) as (s: string) => string,
  exists: ((_p: string) => false) as (path: string) => boolean,
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: (s: string) => h.resolve(s) }),
}));
vi.mock('node:fs', () => ({ existsSync: (p: string) => h.exists(p) }));
vi.mock('node:child_process', () => ({
  execFileSync: () => {
    throw new Error('not on PATH');
  },
  spawn: () => {
    throw new Error('unexpected spawn');
  },
}));
vi.mock('../../../shared/run-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/run-probe.js')>()),
  findBinaryOnPath: vi.fn(),
  runBinaryProbe: vi.fn(),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: vi.fn(() => ({ error: '' })),
}));

const CLI_PATH_ENV = 'DORKOS_CLAUDE_CLI_PATH';
const ENV_BINARY = '/Applications/DorkOS.app/Contents/Resources/app.asar.unpacked/claude';

describe('resolveClaudeBinaryPath — one ladder, shared with the SDK spawn seam', () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    resetProbeFailureNotices();
    savedEnv = process.env[CLI_PATH_ENV];
    delete process.env[CLI_PATH_ENV];
    h.resolve = () => {
      throw new Error('not found');
    };
    h.exists = () => false;
    vi.mocked(findBinaryOnPath).mockResolvedValue(null);
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[CLI_PATH_ENV];
    else process.env[CLI_PATH_ENV] = savedEnv;
  });

  // Purpose: the packaged desktop app hands the server the unpacked binary this
  // way. The probe ignored it entirely, which is what made the Mac app report
  // "Claude Code CLI: missing" while sessions ran fine.
  it('returns the DORKOS_CLAUDE_CLI_PATH override first when the file exists', async () => {
    process.env[CLI_PATH_ENV] = ENV_BINARY;
    h.exists = (p) => p === ENV_BINARY;
    h.resolve = () => '/pkgs/claude-agent-sdk/claude'; // present, but must be ignored

    await expect(resolveClaudeBinaryPath()).resolves.toBe(ENV_BINARY);
    expect(findBinaryOnPath).not.toHaveBeenCalled();
  });

  // Purpose: an override pointing at nothing must not become a dead end.
  it('falls through to the bundled binary when the override path does not exist', async () => {
    process.env[CLI_PATH_ENV] = '/gone/claude';
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.exists = (p) => p === '/pkgs/claude-agent-sdk/claude';

    await expect(resolveClaudeBinaryPath()).resolves.toBe('/pkgs/claude-agent-sdk/claude');
  });

  // Purpose: PATH stays the last rung, and it is the BOUNDED async lookup — the
  // probe must never block the event loop on a stalled PATH mount.
  it('falls through to a bounded PATH lookup when nothing else resolves', async () => {
    vi.mocked(findBinaryOnPath).mockResolvedValue('/usr/local/bin/claude');

    await expect(resolveClaudeBinaryPath()).resolves.toBe('/usr/local/bin/claude');
    expect(findBinaryOnPath).toHaveBeenCalledWith('claude', expect.any(Number));
  });

  it('returns null when no rung resolves', async () => {
    await expect(resolveClaudeBinaryPath()).resolves.toBeNull();
  });

  // Purpose: the two seams must agree by construction, not by coincidence.
  it('agrees with the SDK spawn seam on the same host', async () => {
    process.env[CLI_PATH_ENV] = ENV_BINARY;
    h.exists = (p) => p === ENV_BINARY;

    expect(await resolveClaudeBinaryPath()).toBe(resolveClaudeCliPath());
  });
});

describe('isClaudeCliAuthenticated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProbeFailureNotices();
  });

  it('reports true when the CLI says it is logged in', async () => {
    vi.mocked(runBinaryProbe).mockResolvedValue(JSON.stringify({ loggedIn: true }));
    await expect(isClaudeCliAuthenticated('/bin/claude')).resolves.toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Purpose: F3 — the swallowed error was invisible. A failed auth probe must
  // leave a trace a person can read.
  it('reports false and logs why when the probe fails', async () => {
    vi.mocked(runBinaryProbe).mockRejectedValue(
      Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' })
    );

    await expect(isClaudeCliAuthenticated('/app.asar/claude')).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, details] = vi.mocked(logger.warn).mock.calls[0] as [string, unknown];
    expect(message).toContain('Claude Code authentication');
    expect(details).toMatchObject({ binary: '/app.asar/claude', code: 'ENOTDIR' });
  });

  it('reports false without probing when no binary resolved', async () => {
    await expect(isClaudeCliAuthenticated(null)).resolves.toBe(false);
    expect(runBinaryProbe).not.toHaveBeenCalled();
  });
});

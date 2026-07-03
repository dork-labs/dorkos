import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { findBinaryOnPath, runBinaryProbe } from '../../../shared/run-probe.js';
import { checkClaudeDependency } from '../check-dependency.js';

// The dependency check must be fully async + bounded: bundled resolution is a
// safe sync require.resolve, but the PATH locate and `--version` call go through
// the shared run-probe helpers so a hung binary degrades to `missing` instead of
// blocking the event loop (the DOR-183 T0 review's "Claude still blocks" fix).
vi.mock('../../sdk/sdk-utils.js', () => ({
  resolveBundledClaudeBinary: vi.fn(),
}));
vi.mock('../../../shared/run-probe.js', () => ({
  findBinaryOnPath: vi.fn(),
  runBinaryProbe: vi.fn(),
}));

const mockedBundled = vi.mocked(resolveBundledClaudeBinary);
const mockedFind = vi.mocked(findBinaryOnPath);
const mockedProbe = vi.mocked(runBinaryProbe);

describe('checkClaudeDependency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports satisfied from the SDK-vendored binary without touching PATH', async () => {
    mockedBundled.mockReturnValue('/bundled/claude');
    mockedProbe.mockResolvedValue('1.2.3 (Claude Code)');

    const check = await checkClaudeDependency();

    expect(check.status).toBe('satisfied');
    expect(check.version).toBe('1.2.3 (Claude Code)');
    // Bundled resolved, so the PATH lookup is never consulted.
    expect(mockedFind).not.toHaveBeenCalled();
    expect(mockedProbe).toHaveBeenCalledWith('/bundled/claude', ['--version'], expect.any(Number));
  });

  it('falls back to a bounded PATH lookup when no bundled binary exists', async () => {
    mockedBundled.mockReturnValue(null);
    mockedFind.mockResolvedValue('/usr/local/bin/claude');
    mockedProbe.mockResolvedValue('1.0.0');

    const check = await checkClaudeDependency();

    expect(check.status).toBe('satisfied');
    expect(mockedFind).toHaveBeenCalledWith('claude', expect.any(Number));
  });

  it('degrades to missing (never hangs) when the version probe times out', async () => {
    // A wedged binary: run-probe rejects with its bounded-timeout error. The
    // check must RESOLVE to missing rather than hang the caller.
    mockedBundled.mockReturnValue('/bundled/claude');
    mockedProbe.mockRejectedValue(new Error('probe timed out after 5000ms: /bundled/claude'));

    const check = await checkClaudeDependency();

    expect(check.status).toBe('missing');
    expect(check.installHint).toBeTruthy();
  });

  it('reports missing with an install hint when nothing resolves', async () => {
    mockedBundled.mockReturnValue(null);
    mockedFind.mockResolvedValue(null);

    const check = await checkClaudeDependency();

    expect(check.status).toBe('missing');
    expect(check.installHint).toContain('claude.ai/install');
    // No binary resolved, so we never spawn a version probe.
    expect(mockedProbe).not.toHaveBeenCalled();
  });
});

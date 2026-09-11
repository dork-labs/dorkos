import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { RuntimeProvisionProgress } from '@dorkos/shared/transport';
import {
  provisionClaudeCode,
  resolveProvisionedClaudePath,
  resolveClaudeProvisionDir,
  claudePlatformPackages,
  CLAUDE_SDK_VERSION,
} from '../provision.js';

// MOCK the spawned installer — never run a real npm install in CI.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));
vi.mock('../../../../../lib/dork-home.js', () => ({ resolveDorkHome: () => '/dork-home-test' }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logError: vi.fn(() => ({ error: '' })),
}));

/** A fake npm child process the test drives (stdout/stderr streams + exit/error). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let child: FakeChild;
function armSpawn(): void {
  child = new FakeChild();
  vi.mocked(spawn).mockReturnValue(child as never);
}

/** Flush microtasks so the awaited mkdir resolves and listeners attach before we emit. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('provisionClaudeCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armSpawn();
    // A freshly provisioned install reports the pinned version — the state the
    // resolver's version gate is built for. Cases that need a stale or
    // unreadable manifest override this.
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: CLAUDE_SDK_VERSION }));
    vi.stubEnv('MCP_API_KEY', 'synthetic-server');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-encryption');
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-model');
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-model');
    vi.stubEnv('DO_NOT_TRACK', '1');
  });

  afterEach(() => {
    try {
      for (const call of vi.mocked(spawn).mock.calls) {
        const options = call[2] as { env?: NodeJS.ProcessEnv };
        expect(options.env).toBeDefined();
        expect(options.env).toHaveProperty('DO_NOT_TRACK', '1');
        for (const name of [
          'MCP_API_KEY',
          'NANGO_ENCRYPTION_KEY',
          'ANTHROPIC_API_KEY',
          'OPENAI_API_KEY',
        ])
          expect(options.env).not.toHaveProperty(name);
        expect(JSON.stringify(call[1])).not.toContain('synthetic-');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('installs successfully and resolves the provisioned binary (Claude flips to Ready)', async () => {
    vi.mocked(existsSync).mockReturnValue(true); // the installed binary is present
    const progress: RuntimeProvisionProgress[] = [];

    const resultP = provisionClaudeCode((p) => progress.push(p));
    await flush();
    child.stdout.emit('data', Buffer.from('added 1 package'));
    child.emit('exit', 0);
    const result = await resultP;

    expect(result.ok).toBe(true);
    expect(result.binaryPath).toBe(resolveProvisionedClaudePath());
    // Installed into a dork-home-scoped location, never os.homedir().
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(
      expect.arrayContaining(['install', '--prefix', '/dork-home-test/runtimes/claude-code'])
    );
    // The install spec targets this platform's Claude Code binary package, pinned
    // to the SDK version the server depends on.
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${claudePlatformPackages()[0]}@`) as unknown as string,
      ])
    );
    expect(progress.map((p) => p.stage)).toContain('starting');
    expect(progress.map((p) => p.stage)).toContain('done');
    // A successful install is not cleaned up.
    expect(rm).not.toHaveBeenCalled();
  });

  it('de-dupes concurrent calls: a second install piggybacks instead of racing a second npm install', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const firstP = provisionClaudeCode();
    const secondP = provisionClaudeCode();
    await flush();

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);

    child.emit('exit', 0);

    const [first, second] = await Promise.all([firstP, secondP]);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(rm).not.toHaveBeenCalled();
  });

  it('cleans up and returns an honest error when the installer exits non-zero', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const resultP = provisionClaudeCode();
    await flush();
    child.stderr.emit('data', Buffer.from('npm ERR! network timeout'));
    child.emit('exit', 1);
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install Claude Code');
    expect(rm).toHaveBeenCalledWith(resolveClaudeProvisionDir(), {
      recursive: true,
      force: true,
    });
  });

  it('treats an exit-0 with no resolvable binary as a failure and cleans up', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // installer "succeeded" but left nothing

    const resultP = provisionClaudeCode();
    await flush();
    child.emit('exit', 0);
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install Claude Code');
    expect(rm).toHaveBeenCalled();
  });

  it('cleans up and returns an honest error when the installer fails to spawn', async () => {
    const resultP = provisionClaudeCode();
    await flush();
    child.emit('error', new Error('spawn npm ENOENT'));
    const result = await resultP;

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install Claude Code');
    expect(rm).toHaveBeenCalled();
  });

  it('aborts before spawning when the scoped directory cannot be created', async () => {
    vi.mocked(mkdir).mockRejectedValueOnce(new Error('EACCES'));

    const result = await provisionClaudeCode();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not install Claude Code');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('pins the provisioned binary package to the @anthropic-ai/claude-agent-sdk dependency', async () => {
    // A binary package newer or older than the SDK that drives it is version
    // skew we would rather not debug — read the pin from the one place it is
    // declared so an SDK bump that forgets this constant fails red.
    const { CLAUDE_SDK_VERSION } = await import('../provision.js');
    const { readFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(new URL('../../../../../../package.json', import.meta.url), 'utf8')
    ) as { dependencies: Record<string, string> };

    expect(CLAUDE_SDK_VERSION).toBe(pkg.dependencies['@anthropic-ai/claude-agent-sdk']);
  });

  it('names a per-platform binary package that ends in the SDK-side variant suffix', () => {
    // The SDK resolves `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` (plus a
    // `-musl`/`-android` variant); provisioning must install exactly one of those
    // names or the provisioned rung can never resolve.
    for (const pkg of claudePlatformPackages()) {
      expect(pkg).toMatch(/^@anthropic-ai\/claude-agent-sdk-[a-z0-9]+-[a-z0-9]+(-musl|-android)?$/);
    }
    expect(claudePlatformPackages().length).toBeGreaterThan(0);
  });

  it('resolves the provisioned binary inside the scoped install, or null when absent', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: CLAUDE_SDK_VERSION }));
    expect(resolveProvisionedClaudePath()).toMatch(
      /^\/dork-home-test\/runtimes\/claude-code\/node_modules\/@anthropic-ai\/claude-agent-sdk-.+\/claude(\.exe)?$/
    );

    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveProvisionedClaudePath()).toBeNull();
  });
});

/**
 * The provisioned rung fails closed on VERSION, not just on existence.
 *
 * Nothing ever re-checked a provisioned install after it was written, so a pin
 * bump left a stale `claude` on the ladder forever (the same bug DOR-1034 fixed
 * for OpenCode). From SDK 0.3.268 that is a hard failure rather than a
 * curiosity: a session with a plugin enabled is launched with
 * `--await-initialize`, which an older binary rejects as an unknown option, so a
 * host with no bundled binary would fail to start every turn.
 *
 * Existence is mocked true throughout — the question here is only what the
 * version check does with a binary that IS there.
 */
describe('resolveProvisionedClaudePath — the version gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('returns the binary when the installed version matches the pin', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: CLAUDE_SDK_VERSION }));

    expect(resolveProvisionedClaudePath()).toContain('/runtimes/claude-code/node_modules/');
  });

  it('refuses a binary left behind by an earlier pin', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '0.3.224' }));

    expect(
      resolveProvisionedClaudePath(),
      'a stale provisioned CLI must read as "not provisioned" so the ladder falls through and ' +
        'the provisioner replaces it — returning it costs every turn'
    ).toBeNull();
  });

  it('refuses an install whose package.json is missing', () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(resolveProvisionedClaudePath()).toBeNull();
  });

  it('refuses an install whose package.json names no version', () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ name: 'no-version-here' }));

    expect(resolveProvisionedClaudePath()).toBeNull();
  });

  it('refuses an install whose package.json is not JSON at all', () => {
    vi.mocked(readFileSync).mockReturnValue('<!doctype html>');

    expect(resolveProvisionedClaudePath()).toBeNull();
  });
});

/**
 * Which of the two Linux binary packages an install picks.
 *
 * `claudePlatformPackages()[0]` is the ONLY package `runProvisionClaudeCode`
 * installs, and on Linux the choice between the glibc and musl builds is made by
 * a libc guess. A wrong guess installs cleanly and then refuses to run — the
 * quietest possible failure — so both directions are pinned here (review of
 * DOR-1334).
 */
describe('claudePlatformPackages — the Linux libc choice', () => {
  const realPlatform = process.platform;
  const realArch = process.arch;
  const realReport = process.report;

  /** Pretend to be linux/x64 with the given diagnostic report. */
  function stubLinuxHost(report: unknown): void {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    Object.defineProperty(process, 'report', { value: report, configurable: true });
  }

  /** A Node diagnostic report that does, or does not, name a glibc runtime. */
  function reportWith(glibcVersionRuntime?: string): unknown {
    return {
      getReport: () => ({ header: glibcVersionRuntime ? { glibcVersionRuntime } : {} }),
    };
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
    Object.defineProperty(process, 'report', { value: realReport, configurable: true });
  });

  it('installs the musl build first on a musl host (no glibc runtime in the report)', () => {
    stubLinuxHost(reportWith(undefined));

    const [first, second] = claudePlatformPackages();

    expect(first).toBe('@anthropic-ai/claude-agent-sdk-linux-x64-musl');
    // The other build stays on the list: resolution still checks both names, so
    // a host that already has the glibc one installed is not made unresolvable.
    expect(second).toBe('@anthropic-ai/claude-agent-sdk-linux-x64');
  });

  it('installs the glibc build first on a glibc host', () => {
    stubLinuxHost(reportWith('2.39'));

    const [first, second] = claudePlatformPackages();

    expect(first).toBe('@anthropic-ai/claude-agent-sdk-linux-x64');
    expect(second).toBe('@anthropic-ai/claude-agent-sdk-linux-x64-musl');
  });

  it('falls back to the glibc build when there is no diagnostic report to read', () => {
    stubLinuxHost(undefined);

    expect(claudePlatformPackages()[0]).toBe('@anthropic-ai/claude-agent-sdk-linux-x64');
  });

  // The endpoint's actual behaviour, not just the list's: the spec handed to
  // `npm install` is the FIRST candidate, so the libc choice reaches the wire.
  it('installs the musl package on a musl host, end to end', async () => {
    stubLinuxHost(reportWith(undefined));
    vi.mocked(existsSync).mockReturnValue(true);
    armSpawn();

    const resultP = provisionClaudeCode();
    await flush();
    child.emit('exit', 0);
    await resultP;

    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        `@anthropic-ai/claude-agent-sdk-linux-x64-musl@${CLAUDE_SDK_VERSION}`,
      ])
    );
  });
});

// These child-process fixtures use an empty owner inheritance policy.
vi.mock('../../../../core/config-manager.js', () => ({ configManager: { get: () => undefined } }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { RuntimeProvisionProgress } from '@dorkos/shared/transport';
import {
  provisionClaudeCode,
  resolveProvisionedClaudePath,
  resolveClaudeProvisionDir,
  claudePlatformPackages,
} from '../provision.js';

// MOCK the spawned installer — never run a real npm install in CI.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
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
    expect(resolveProvisionedClaudePath()).toMatch(
      /^\/dork-home-test\/runtimes\/claude-code\/node_modules\/@anthropic-ai\/claude-agent-sdk-.+\/claude(\.exe)?$/
    );

    vi.mocked(existsSync).mockReturnValue(false);
    expect(resolveProvisionedClaudePath()).toBeNull();
  });
});

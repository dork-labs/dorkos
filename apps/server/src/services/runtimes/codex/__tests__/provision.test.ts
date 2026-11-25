import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { RuntimeProvisionProgress } from '@dorkos/shared/transport';
import { provisionCodex, resolveProvisionedCodexPath } from '../provision.js';

// MOCK the spawned installer — never run a real npm install in CI.
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
}));
vi.mock('../../../../lib/dork-home.js', () => ({ resolveDorkHome: () => '/dork-home-test' }));
vi.mock('../../../../lib/logger.js', () => ({
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

describe('provisionCodex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    armSpawn();
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

  it('installs successfully and resolves the provisioned binary (Codex flips to Ready)', async () => {
    vi.mocked(existsSync).mockReturnValue(true); // the installed binary is present
    const progress: RuntimeProvisionProgress[] = [];

    const resultP = provisionCodex((p) => progress.push(p));
    await flush();
    child.stdout.emit('data', Buffer.from('added 1 package'));
    child.emit('exit', 0);
    const result = await resultP;

    expect(result.ok).toBe(true);
    expect(result.binaryPath).toBe(resolveProvisionedCodexPath());
    // Installed into a dork-home-scoped location, never os.homedir().
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(
      expect.arrayContaining(['install', '--prefix', '/dork-home-test/runtimes/codex'])
    );
    // The install spec targets the Codex CLI package.
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(
      expect.arrayContaining([expect.stringContaining('@openai/codex@')])
    );
    expect(progress.map((p) => p.stage)).toContain('starting');
    expect(progress.map((p) => p.stage)).toContain('done');
    // A successful install is not cleaned up.
    expect(rm).not.toHaveBeenCalled();
  });

  it('pins the provisioned version to the @openai/codex dependency in package.json', async () => {
    const { CODEX_PACKAGE_VERSION } = await import('../provision.js');
    const { readFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')
    ) as { dependencies: Record<string, string> };

    expect(CODEX_PACKAGE_VERSION).toBe(pkg.dependencies['@openai/codex']);
  });

  it('keeps the provisioned @openai/codex CLI in lockstep with the @openai/codex-sdk pin', async () => {
    // The two file-local constants can agree with each other while both drift from
    // the actual SDK dependency (DOR-1012 review: this happened — CODEX_PACKAGE_VERSION
    // and the CLI pin matched each other at 0.144.1 while codex-sdk had moved to
    // 0.147.0). Read the dependency versions straight from package.json, the one
    // place both pins are declared, so a future SDK-only bump fails this test red.
    // `@openai/codex` is an exact pin; `@openai/codex-sdk` carries a leading `~` —
    // strip range operators before comparing the version numbers themselves.
    //
    // THIS TEST READS ONE MANIFEST, ON PURPOSE — it is a guard on the runtime
    // adapter beside it, and it names the exact version so a bump has to come
    // through here deliberately. It is NOT the repo-wide check: apps/desktop and
    // packages/cli declare the same pair, and packages/cli sat at 0.150.1 against
    // a 0.147.0 SDK for days after PR #1407 because nothing looked there.
    // `scripts/__tests__/dependabot-lockstep-families.test.ts` (DOR-1644) is what
    // covers every manifest, plus the per-platform siblings and the dependabot
    // ignore rules that let the split happen. Bump both together.
    const { readFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const pkg = JSON.parse(
      await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')
    ) as { dependencies: Record<string, string> };
    const stripRange = (version: string): string => version.replace(/^[~^]/, '');

    expect(stripRange(pkg.dependencies['@openai/codex'])).toBe('0.163.0');
    expect(stripRange(pkg.dependencies['@openai/codex-sdk'])).toBe('0.163.0');
    expect(stripRange(pkg.dependencies['@openai/codex'])).toBe(
      stripRange(pkg.dependencies['@openai/codex-sdk'])
    );
  });
});

// These child-process fixtures use an empty owner inheritance policy.
vi.mock('../../../core/config-manager.js', () => ({ configManager: { get: () => undefined } }));

import { withAccountsHome } from './accounts-live-lifecycle.js';
/**
 * Opt-in subscription-only CN-01/CN-05/CN-07/CN-10 regression through CodexRuntime.
 *
 * Set DORKOS_CODEX_ACCOUNTS_LIVE=1, DORKOS_CODEX_ACCOUNTS_AUTH_FILE to a
 * ChatGPT login auth.json, and DORKOS_CODEX_ACCOUNTS_BINARY to an absolute Codex
 * binary. Run this file with targeted Vitest. No flag means no model process,
 * credential read, or credential copy. This flag is not passed by Turbo/CI.
 * Live execution currently supports macOS/Linux only; default checks are portable.
 * Uses synthetic Gmail only: four turns, at most two fake reads, no real mail.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Captured before tests can stub environment; default test tasks cannot arm it.
const LIVE = process.env.DORKOS_CODEX_ACCOUNTS_LIVE === '1';
const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

function subscriptionAuth(raw: string): string {
  const auth = JSON.parse(raw) as {
    auth_mode?: string;
    tokens?: unknown;
    OPENAI_API_KEY?: unknown;
  };
  if (
    auth.OPENAI_API_KEY ||
    !auth.tokens ||
    typeof auth.tokens !== 'object' ||
    auth.auth_mode !== 'chatgpt'
  ) {
    throw new Error('This test requires a ChatGPT subscription login, never an API key.');
  }
  return raw;
}

function closedEnvironment(root: string, binary: string): NodeJS.ProcessEnv {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(root, 'private'),
    CODEX_HOME: join(root, 'private/codex'),
    DORK_HOME: join(root, 'private/dork'),
    DORKOS_BOUNDARY: join(root, 'private'),
    DORKOS_DEFAULT_CWD: join(root, 'private/agent'),
    DORKOS_CODEX_ACCOUNTS_LIVE: '1',
    DORKOS_CODEX_ACCOUNTS_SOURCE_ROOT: resolve(here, '../../../../../../..'),
    DORKOS_CODEX_ACCOUNTS_FIXTURE_ROOT: root,
    DORKOS_CODEX_ACCOUNTS_BINARY: binary,
    NODE_ENV: 'production',
    DO_NOT_TRACK: '1',
    DORKOS_TELEMETRY_DISABLED: '1',
    DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
  };
}

describe('Accounts live-test credential boundary', () => {
  it('keeps the live opt-in out of every Turbo task environment', async () => {
    const turbo = await readFile(resolve(here, '../../../../../../../turbo.json'), 'utf8');
    expect(turbo).not.toContain('DORKOS_CODEX_ACCOUNTS_LIVE');
  });
  it('rejects API billing even when subscription tokens also exist', () => {
    expect(() => subscriptionAuth('{"OPENAI_API_KEY":"synthetic","tokens":{}}')).toThrow();
    expect(() => subscriptionAuth('{}')).toThrow();
    expect(() => subscriptionAuth('{"auth_mode":"apikey","tokens":{}}')).toThrow();
    expect(subscriptionAuth('{"auth_mode":"chatgpt","tokens":{}}')).toContain('chatgpt');
  });
  it('uses a closed environment without ambient keys, source login or user configuration', () => {
    const env = closedEnvironment('/synthetic', '/bin/codex');
    expect(env.HOME).toBe(join('/synthetic', 'private'));
    expect(env.CODEX_HOME).toBe(join('/synthetic', 'private/codex'));
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.DORKOS_CLOUD_URL).toBeUndefined();
    expect(env.DORKOS_CODEX_ACCOUNTS_AUTH_FILE).toBeUndefined();
  });
});

it.skipIf(!LIVE)(
  'CN-01/CN-05/CN-07/CN-10: real Codex discovers, reads unread mail, notices a changed account, and respects revocation',
  async () => {
    if (process.platform === 'win32')
      throw new Error('This live probe currently supports macOS/Linux only.');
    const authFile = process.env.DORKOS_CODEX_ACCOUNTS_AUTH_FILE;
    const binary = process.env.DORKOS_CODEX_ACCOUNTS_BINARY;
    if (!authFile || !binary || !isAbsolute(authFile) || !isAbsolute(binary)) {
      throw new Error('Provide absolute subscription auth-file and Codex binary paths.');
    }
    for (const key of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENROUTER_API_KEY',
    ]) {
      if (process.env[key])
        throw new Error('Unset API keys before running this subscription-only test.');
    }
    const auth = subscriptionAuth(await readFile(authFile, 'utf8'));
    const evidenceDir = process.env.DORKOS_CODEX_ACCOUNTS_EVIDENCE_DIR;
    if (evidenceDir && !isAbsolute(evidenceDir))
      throw new Error('Evidence directory must be absolute.');
    let proof: Record<string, unknown> | undefined;
    await withAccountsHome(auth, async (root) => {
      await run(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), join(here, 'accounts-live-fixture.ts')],
        {
          cwd: root,
          env: closedEnvironment(root, binary),
          timeout: 540_000,
          maxBuffer: 1_000_000,
        }
      );
      const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'));
      const source = (
        await run('git', ['rev-parse', 'HEAD'], {
          cwd: closedEnvironment(root, binary).DORKOS_CODEX_ACCOUNTS_SOURCE_ROOT,
        })
      ).stdout.trim();
      proof = { source, ...result };
      expect(result).toMatchObject({
        passed: true,
        turns: 4,
        syntheticOnly: true,
        personalProviderCalls: 0,
      });
      expect(JSON.parse(await readFile(join(root, 'cleanup.json'), 'utf8'))).toEqual({
        cleanupFailed: false,
      });
    });
    if (evidenceDir && proof) {
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(evidenceDir, 'accounts-live-proof.json'),
        JSON.stringify({ ...proof, isolatedHomeRemoved: true }, null, 2),
        { mode: 0o600 }
      );
    }
  },
  570_000
);

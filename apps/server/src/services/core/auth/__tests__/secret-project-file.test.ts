/**
 * @vitest-environment node
 *
 * The project `.env` file can no longer change how DorkOS signs you in
 * (DOR-5481): its `BETTER_AUTH_SECRET` never reaches Better Auth, so anything
 * signed with it stops verifying; a stored secret equal to it is replaced
 * once; any other stored secret is left alone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSignature } from 'better-auth/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SENTINEL = 'fixture-project-session-secret-5481';
/** The CLI's loader, from its source. */
const CLI_LOADER = new URL(
  '../../../../../../../packages/cli/src/lib/project-env.ts',
  import.meta.url
).href;

let home: string;
let project: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-secret-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-secret-project-'));
  vi.stubEnv('BETTER_AUTH_SECRET', undefined);
  vi.resetModules();
});
afterEach(async () => {
  const { handProjectSettings } = await import('@dorkos/shared/project-environment');
  handProjectSettings({ settings: {} });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.chmodSync(home, 0o700);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

/** Boot the way the CLI does: read the project `.env`, then load the resolver fresh. */
async function boot(projectEnv: string) {
  fs.writeFileSync(path.join(project, '.env'), projectEnv);
  const { loadProjectEnv } = (await import(CLI_LOADER)) as {
    loadProjectEnv: (dir: string, warn: (message: string) => void) => unknown;
  };
  loadProjectEnv(project, () => undefined);
  const secret = await import('../secret.js');
  const { logger } = await import('../../../../lib/logger.js');
  const warn = vi.spyOn(logger, 'warn');
  return { ...secret, warn };
}

/** Store a secret the way the server does. */
function store(value: string): void {
  fs.writeFileSync(path.join(home, 'better-auth-secret'), value, { mode: 0o600 });
}

describe('a session secret in the project .env', () => {
  it('never reaches Better Auth, so a session signed with it no longer verifies', async () => {
    const { resolveBetterAuthSecret } = await boot(`BETTER_AUTH_SECRET=${SENTINEL}\n`);
    const secret = resolveBetterAuthSecret(home);
    expect(secret).not.toContain(SENTINEL);
    expect(process.env.BETTER_AUTH_SECRET).toBeUndefined();
    const signedWithFile = await makeSignature('fixture-session-token', SENTINEL);
    expect(await makeSignature('fixture-session-token', secret)).not.toBe(signedWithFile);
  });

  it('replaces a stored copy of it once, and a second boot keeps the new one', async () => {
    store(SENTINEL);
    const { resolveBetterAuthSecret, warn } = await boot(`BETTER_AUTH_SECRET=${SENTINEL}\n`);
    const first = resolveBetterAuthSecret(home);
    expect(first).not.toBe(SENTINEL);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(path.join(home, 'better-auth-secret'), 'utf8')).toBe(first);
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(SENTINEL);
    expect(logged).not.toContain(first);
    expect(resolveBetterAuthSecret(home)).toBe(first);
    expect(warn).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(home, 'better-auth-secret.lock'))).toBe(false);
  });

  it('never touches a different stored secret', async () => {
    store('a-different-stored-secret');
    const { resolveBetterAuthSecret, warn } = await boot(`BETTER_AUTH_SECRET=${SENTINEL}\n`);
    expect(resolveBetterAuthSecret(home)).toBe('a-different-stored-secret');
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops the boot with a clear error and no value when the replacement cannot be written', async () => {
    store(SENTINEL);
    const { resolveBetterAuthSecret } = await boot(`BETTER_AUTH_SECRET=${SENTINEL}\n`);
    // A folder where the replacement's temp file goes: the write fails.
    fs.mkdirSync(path.join(home, `better-auth-secret.${process.pid}.tmp`));
    let message = '';
    try {
      resolveBetterAuthSecret(home);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/could not replace its sign-in key at .*better-auth-secret/);
    expect(message).not.toContain(SENTINEL);
    // The stored value is not handed out as if nothing happened.
    expect(fs.existsSync(path.join(home, 'better-auth-secret.lock'))).toBe(false);
  });

  it('says once that people were signed out, only when someone had signed in', async () => {
    const { noticeProjectSecretRetired, warn } = await boot(`BETTER_AUTH_SECRET=${SENTINEL}\n`);
    noticeProjectSecretRetired(home, false);
    expect(warn).not.toHaveBeenCalled();
    noticeProjectSecretRetired(home, true);
    noticeProjectSecretRetired(home, true);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).toMatch(/signed out/);
  });

  it('says nothing when the real environment sets the secret', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'real-environment-secret');
    const { resolveBetterAuthSecret, noticeProjectSecretRetired, warn } = await boot(
      `BETTER_AUTH_SECRET=${SENTINEL}\n`
    );
    expect(resolveBetterAuthSecret(home)).toBe('real-environment-secret');
    noticeProjectSecretRetired(home, true);
    expect(warn).not.toHaveBeenCalled();
  });
});

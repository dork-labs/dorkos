/**
 * @vitest-environment node
 *
 * The project `.env` file can no longer change how DorkOS signs you in
 * (DOR-5481): its `BETTER_AUTH_SECRET` never reaches Better Auth, and when
 * DorkOS signed sessions with it before this release, the stored secret is
 * rotated once, on the first boot after the upgrade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  handProjectSettings({ settings: {}, authSecretFromFile: false });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

/** Boot the way the CLI does: read the project `.env`, then resolve the secret fresh. */
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

describe('a session secret in the project .env', () => {
  it('never reaches Better Auth', async () => {
    const { resolveBetterAuthSecret } = await boot(`BETTER_AUTH_SECRET=${SENTINEL}\n`);
    expect(resolveBetterAuthSecret(home)).not.toContain(SENTINEL);
    expect(process.env.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it('rotates the stored secret once, says so in plain words, and never logs a value', async () => {
    fs.writeFileSync(path.join(home, 'better-auth-secret'), 'old-stored-secret', { mode: 0o600 });
    const { resolveBetterAuthSecret, PROJECT_FILE_ROTATION_MARK, warn } = await boot(
      `BETTER_AUTH_SECRET=${SENTINEL}\n`
    );
    const first = resolveBetterAuthSecret(home);
    expect(first).not.toBe('old-stored-secret');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(home, PROJECT_FILE_ROTATION_MARK))).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toMatch(/signed out once/);
    expect(logged).not.toContain(SENTINEL);
    expect(logged).not.toContain(first);
    // Once only: the next boot keeps the new secret.
    expect(resolveBetterAuthSecret(home)).toBe(first);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rotates nothing when the file never named it', async () => {
    fs.writeFileSync(path.join(home, 'better-auth-secret'), 'old-stored-secret', { mode: 0o600 });
    const { resolveBetterAuthSecret } = await boot('MY_TOOL_URL=http://localhost:9000\n');
    expect(resolveBetterAuthSecret(home)).toBe('old-stored-secret');
  });

  it('rotates nothing when the real environment sets the secret', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'real-environment-secret');
    const { resolveBetterAuthSecret, PROJECT_FILE_ROTATION_MARK } = await boot(
      `BETTER_AUTH_SECRET=${SENTINEL}\n`
    );
    expect(resolveBetterAuthSecret(home)).toBe('real-environment-secret');
    expect(fs.existsSync(path.join(home, PROJECT_FILE_ROTATION_MARK))).toBe(false);
  });
});

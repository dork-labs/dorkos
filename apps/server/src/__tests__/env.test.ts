/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('serverEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('uses default port when DORKOS_PORT is not set', async () => {
    // Explicitly unset DORKOS_PORT — dev .env may have DORKOS_PORT=6942
    vi.stubEnv('DORKOS_PORT', undefined as unknown as string);
    const { env } = await import('../env.js');
    expect(typeof env.DORKOS_PORT).toBe('number');
    expect(env.DORKOS_PORT).toBe(4242);
  });

  it('parses DORKOS_PORT as a number', async () => {
    vi.stubEnv('DORKOS_PORT', '6942');
    const { env } = await import('../env.js');
    expect(env.DORKOS_PORT).toBe(6942);
    expect(typeof env.DORKOS_PORT).toBe('number');
  });

  it('feature flags default to false', async () => {
    vi.stubEnv('DORKOS_TASKS_ENABLED', undefined as unknown as string);
    vi.stubEnv('DORKOS_RELAY_ENABLED', undefined as unknown as string);
    const { env } = await import('../env.js');
    expect(env.DORKOS_TASKS_ENABLED).toBe(false);
    expect(env.DORKOS_RELAY_ENABLED).toBe(false);
  });

  it('feature flag "true" string becomes boolean true', async () => {
    vi.stubEnv('DORKOS_TASKS_ENABLED', 'true');
    const { env } = await import('../env.js');
    expect(env.DORKOS_TASKS_ENABLED).toBe(true);
  });

  it('feature flag "false" string becomes boolean false', async () => {
    vi.stubEnv('DORKOS_TASKS_ENABLED', 'false');
    const { env } = await import('../env.js');
    expect(env.DORKOS_TASKS_ENABLED).toBe(false);
  });

  it('rejects an out-of-range port', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('DORKOS_PORT', '99999');
    await import('../env.js');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Name assembled from fragments, not written as a literal — same reason
  // `env.ts` assembles it: an intentional mention of the retired variable
  // that shouldn't trip `no-auto-approve-env-var.test.ts`'s reintroduction
  // guard. See that file's module TSDoc.
  const RETIRED_AUTO_APPROVE_ENV_VAR = ['MARKETPLACE', 'AUTO', 'APPROVE'].join('_');

  it('warns on boot when the retired marketplace auto-approve variable is still set', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv(RETIRED_AUTO_APPROVE_ENV_VAR, '1');
    await import('../env.js');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(RETIRED_AUTO_APPROVE_ENV_VAR));
    warnSpy.mockRestore();
  });

  it('stays quiet when the retired marketplace auto-approve variable is unset', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv(RETIRED_AUTO_APPROVE_ENV_VAR, undefined as unknown as string);
    await import('../env.js');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

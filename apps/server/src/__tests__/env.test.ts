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

  it('defaults the docs base URL to production', async () => {
    vi.stubEnv('DORKOS_DOCS_BASE_URL', undefined as unknown as string);
    const { env } = await import('../env.js');
    expect(env.DORKOS_DOCS_BASE_URL).toBe('https://dorkos.ai');
  });

  it('strips trailing slashes from the docs base URL', async () => {
    // Otherwise the agent-facing pointer built from it doubles the separator.
    vi.stubEnv('DORKOS_DOCS_BASE_URL', 'http://localhost:6244//');
    const { env } = await import('../env.js');
    expect(env.DORKOS_DOCS_BASE_URL).toBe('http://localhost:6244');
  });

  it.each([
    ['a trailing newline', 'https://x.dev\n'],
    ['surrounding spaces', '  https://x.dev  '],
    ['a trailing tab', 'https://x.dev\t'],
    ['a trailing CRLF', 'https://x.dev\r\n'],
  ])('strips %s from the docs base URL', async (_label, value) => {
    // The URL parser drops tab/LF/CR while parsing, so a check that reads the
    // parsed URL but emits the caller's raw string says yes and still ships the
    // whitespace. A trailing newline survives a Kubernetes ConfigMap block
    // scalar and a hand-edited export; `dotenv` strips it, which is why the
    // repo's own `.env` path never shows this.
    vi.stubEnv('DORKOS_DOCS_BASE_URL', value);
    const { env } = await import('../env.js');
    expect(env.DORKOS_DOCS_BASE_URL).toBe('https://x.dev');
  });

  // `z.string().url()` alone accepts every value below, so each of these would
  // have booted and handed agents a pointer that resolves to nothing. The
  // scheme-less `localhost:6244` is the whole reason the check exists: zod
  // reads `localhost:` as the scheme, so the likeliest typo is the one a bare
  // `.url()` waves through.
  const REJECTED_DOCS_BASE_URLS = [
    'localhost:6244',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'mailto:docs@dorkos.ai',
    'https://dorkos.ai?v=2',
    'https://dorkos.ai#docs',
    // A BARE marker. `parsed.search`/`parsed.hash` are both `''` here, so a
    // check that reads the parsed URL waves these through and emits
    // `https://dorkos.ai?/llms.txt`. The `#` one is the quiet failure: the
    // fragment swallows the appended path, so the pointer fetches the site root.
    'https://dorkos.ai?',
    'https://dorkos.ai#',
    // Embedded credentials. `href` preserves userinfo, and this string is
    // interpolated into a block that ships to the model provider every turn and
    // that an agent can read and re-emit, so a password here is one tool call
    // from leaving the machine. Refused, not silently stripped.
    'https://user:pass@x.dev',
    'https://user@x.dev',
    // Nothing `new URL()` can parse at all, covering parseDocsBaseUrl's catch.
    '',
    '////',
  ];

  it.each(REJECTED_DOCS_BASE_URLS)('refuses to boot on docs base URL %s', async (value) => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('DORKOS_DOCS_BASE_URL', value);
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

  it('rejects a malformed NANGO_BASE_URL at boot (DOR-415 nit)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NANGO_BASE_URL', 'not a url');
    await import('../env.js');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('accepts a well-formed NANGO_BASE_URL', async () => {
    vi.stubEnv('NANGO_BASE_URL', 'http://localhost:3003');
    const { env } = await import('../env.js');
    expect(env.NANGO_BASE_URL).toBe('http://localhost:3003');
  });
});

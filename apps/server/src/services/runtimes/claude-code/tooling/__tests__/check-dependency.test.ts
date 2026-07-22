import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CredentialProvider } from '../../../../core/credential-provider.js';
import { resolveBundledClaudeBinary } from '../../sdk/sdk-utils.js';
import { findBinaryOnPath, runBinaryProbe } from '../../../shared/run-probe.js';
import { checkClaudeDependencies } from '../check-dependency.js';

// The dependency check must be fully async + bounded: bundled resolution is a
// safe sync require.resolve, but the PATH locate, `--version`, and `auth status`
// calls go through the shared run-probe helpers so a hung binary degrades to
// `missing` instead of blocking the event loop.
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

const BUNDLED = '/bundled/claude';
const AUTH_CHECK_NAME = 'Claude Code authentication';
const LOGIN_HINT = 'claude auth login';

/** A logged-in `claude auth status --json` payload — the only fields we read plus identity noise. */
const LOGGED_IN_JSON = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'user@example.com',
});
/** A signed-out `claude auth status --json` payload (the CLI also exits non-zero here). */
const LOGGED_OUT_JSON = JSON.stringify({ loggedIn: false, authMethod: 'none' });

/**
 * Drive the probe mock from a per-invocation handler keyed on the CLI args, so a
 * test can answer `--version` and `auth status` independently.
 */
function onProbe(handler: (args: string[]) => string | Error) {
  mockedProbe.mockImplementation(async (_binary: string, args: string[]) => {
    const outcome = handler(args);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
}

/** Standard host: bundled binary resolves, `--version` answers, `auth status` decided by `auth`. */
function bundledHost(auth: () => string | Error) {
  mockedBundled.mockReturnValue(BUNDLED);
  onProbe((args) => {
    if (args[0] === '--version') return '1.2.3 (Claude Code)';
    if (args[0] === 'auth' && args[1] === 'status') return auth();
    return new Error(`unexpected args: ${args.join(' ')}`);
  });
}

/** A credential provider whose `resolve` reports the given outcome. */
function stubCredentialProvider(outcome: 'ok' | 'unresolved'): CredentialProvider {
  return {
    resolve: vi.fn(async () =>
      outcome === 'ok'
        ? { ok: true as const, secret: 'sk-secret' }
        : {
            ok: false as const,
            reason: 'unresolved' as const,
            ref: 'file:anthropic',
            message: 'No stored credential named "anthropic".',
          }
    ),
  };
}

/** A config reader exposing a `providers` registry (and an empty `runtimes`). */
function stubConfig(providers: Record<string, string> = {}) {
  return {
    get: (key: string) => {
      if (key === 'providers') return providers;
      return {};
    },
  } as never;
}

describe('checkClaudeDependencies — CLI binary check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the CLI satisfied from the SDK-vendored binary without touching PATH', async () => {
    bundledHost(() => LOGGED_IN_JSON);

    const [cli] = await checkClaudeDependencies();

    expect(cli).toMatchObject({
      name: 'Claude Code CLI',
      status: 'satisfied',
      version: '1.2.3 (Claude Code)',
    });
    // Bundled resolved, so the PATH lookup is never consulted.
    expect(mockedFind).not.toHaveBeenCalled();
  });

  it('falls back to a bounded PATH lookup when no bundled binary exists', async () => {
    mockedBundled.mockReturnValue(null);
    mockedFind.mockResolvedValue('/usr/local/bin/claude');
    onProbe((args) => (args[0] === '--version' ? '1.0.0' : LOGGED_IN_JSON));

    const [cli] = await checkClaudeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(mockedFind).toHaveBeenCalledWith('claude', expect.any(Number));
  });

  it('reports the CLI missing with an install hint when nothing resolves', async () => {
    mockedBundled.mockReturnValue(null);
    mockedFind.mockResolvedValue(null);

    const [cli, auth] = await checkClaudeDependencies();

    expect(cli.status).toBe('missing');
    expect(cli.installHint).toContain('claude.ai/install');
    // No binary → the host-login probe can't run either, so auth is missing too.
    expect(auth.status).toBe('missing');
    // The two checks carry distinct hints — never the same command twice.
    expect(cli.installHint).not.toBe(auth.installHint);
    expect(mockedProbe).not.toHaveBeenCalled();
  });

  it('reports the CLI missing (never hangs) when the version probe times out', async () => {
    mockedBundled.mockReturnValue(BUNDLED);
    onProbe((args) => {
      if (args[0] === '--version')
        return new Error('probe timed out after 5000ms: /bundled/claude');
      return LOGGED_IN_JSON;
    });

    const [cli] = await checkClaudeDependencies();

    expect(cli.status).toBe('missing');
    expect(cli.installHint).toBeTruthy();
  });
});

describe('checkClaudeDependencies — authentication check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is satisfied via a DorkOS-stored Anthropic key — without spawning the host probe', async () => {
    bundledHost(() => new Error('host probe must not run when a stored key resolves'));
    const credentialProvider = stubCredentialProvider('ok');

    const [, auth] = await checkClaudeDependencies({
      config: stubConfig({ anthropic: 'file:anthropic' }),
      credentialProvider,
    });

    expect(auth).toMatchObject({ name: AUTH_CHECK_NAME, status: 'satisfied' });
    expect(auth.description).toMatch(/anthropic api key/i);
    expect(credentialProvider.resolve).toHaveBeenCalledWith('file:anthropic');
    // The stored-key rung short-circuits: `auth status` is never spawned.
    expect(mockedProbe).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['auth', 'status']),
      expect.anything()
    );
  });

  it('is satisfied via the host login (claude auth status reports loggedIn) when no key is stored', async () => {
    bundledHost(() => LOGGED_IN_JSON);
    const credentialProvider = stubCredentialProvider('ok');

    const [, auth] = await checkClaudeDependencies({
      config: stubConfig({}),
      credentialProvider,
    });

    expect(auth.status).toBe('satisfied');
    expect(auth.description).toMatch(/signed in/i);
    // No stored key → DorkOS never resolves a credential; the CLI decides.
    expect(credentialProvider.resolve).not.toHaveBeenCalled();
  });

  it('falls through to the host probe when a stored key reference no longer resolves (no false negative)', async () => {
    // Stored key dangles, but the host is still signed in → satisfied, NOT missing.
    bundledHost(() => LOGGED_IN_JSON);
    const credentialProvider = stubCredentialProvider('unresolved');

    const [, auth] = await checkClaudeDependencies({
      config: stubConfig({ anthropic: 'file:anthropic' }),
      credentialProvider,
    });

    expect(credentialProvider.resolve).toHaveBeenCalledWith('file:anthropic');
    expect(auth.status).toBe('satisfied');
    expect(auth.description).toMatch(/signed in/i);
  });

  it('reports auth missing (with the login-only hint) when signed out and no key is stored', async () => {
    // Signed out: the CLI prints loggedIn:false AND exits non-zero.
    bundledHost(() => new Error('exit 1'));

    const [cli, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(cli.status).toBe('satisfied');
    expect(auth).toMatchObject({ status: 'missing', installHint: LOGIN_HINT });
    expect(auth.description).toMatch(/sign in to claude code or add an api key/i);
    // Login guidance, never the install command.
    expect(auth.installHint).not.toBe(cli.installHint);
  });

  it('reports auth missing when auth status exits 0 but reports loggedIn:false (defensive parse)', async () => {
    // Belt-and-suspenders: even if a future CLI exits 0 while signed out, the
    // loggedIn flag is authoritative.
    bundledHost(() => LOGGED_OUT_JSON);

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(auth.status).toBe('missing');
  });

  it('never surfaces token material — the satisfied auth check carries no secret', async () => {
    bundledHost(() => LOGGED_IN_JSON);

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    const serialized = JSON.stringify(auth);
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('user@example.com');
    expect(serialized).not.toMatch(/token/i);
  });

  it('degrades to missing (never blocks) when the auth probe hangs, bounded by the timeout', async () => {
    vi.useFakeTimers();
    mockedBundled.mockReturnValue(BUNDLED);
    // Real timeout semantics: version answers, auth status never settles.
    mockedProbe.mockImplementation((_binary: string, args: string[], timeoutMs: number) => {
      if (args[0] === '--version') return Promise.resolve('1.2.3');
      return new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
      });
    });

    const promise = checkClaudeDependencies({ config: stubConfig({}) });
    await vi.advanceTimersByTimeAsync(5_001);
    const [, auth] = await promise;

    expect(auth.status).toBe('missing');
  });
});

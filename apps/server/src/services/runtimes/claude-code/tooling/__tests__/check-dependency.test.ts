import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CredentialProvider } from '../../../../core/credential-provider.js';
import { resolveClaudeBinaryBeforePath } from '../../sdk/sdk-utils.js';
import {
  findBinaryOnPath,
  runBinaryProbe,
  resetProbeFailureNotices,
} from '../../../shared/run-probe.js';
import { logger } from '../../../../../lib/logger.js';
import { readClaudeSignInDeadlines } from '../claude-sign-in-expiry.js';
import { checkClaudeDependencies } from '../check-dependency.js';

// The dependency check must be fully async + bounded: bundled resolution is a
// safe sync require.resolve, but the PATH locate, `--version`, and `auth status`
// calls go through the shared run-probe helpers so a hung binary degrades to
// `missing` instead of blocking the event loop.
// The env-override / bundled / provisioned rungs are one function shared with
// the SDK spawn seam (sdk-utils, tested there against a fake filesystem); here
// it stands in for "what this host has locally".
vi.mock('../../sdk/sdk-utils.js', () => ({
  resolveClaudeBinaryBeforePath: vi.fn(),
}));
vi.mock('../../../shared/run-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/run-probe.js')>()),
  findBinaryOnPath: vi.fn(),
  runBinaryProbe: vi.fn(),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: vi.fn(() => ({ error: '' })),
}));
// Only the credential-store READ is faked — the "has it run out?" decision and
// the date formatting stay real, so these tests exercise the actual rule rather
// than a restatement of it (both are unit-tested in claude-sign-in-expiry.test).
vi.mock('../claude-sign-in-expiry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claude-sign-in-expiry.js')>()),
  readClaudeSignInDeadlines: vi.fn(),
}));

const mockedBundled = vi.mocked(resolveClaudeBinaryBeforePath);
const mockedFind = vi.mocked(findBinaryOnPath);
const mockedProbe = vi.mocked(runBinaryProbe);
const mockedDeadlines = vi.mocked(readClaudeSignInDeadlines);

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
    resetProbeFailureNotices();
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

  // Purpose: F3. The packaged Mac app reported "missing" for a binary that was
  // right there, and the server log said nothing at all — there was no way to
  // tell "no binary" from "this binary would not spawn".
  it('logs why the binary probe failed instead of swallowing it', async () => {
    mockedBundled.mockReturnValue('/app.asar/node_modules/sdk/claude');
    onProbe(() => Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' }));

    const [cli] = await checkClaudeDependencies();

    expect(cli.status).toBe('missing');
    // Both probes fail on the same unspawnable binary and run concurrently, so
    // pick the CLI check's notice out of the pair rather than assuming an order.
    const cliWarning = vi
      .mocked(logger.warn)
      .mock.calls.find(([message]) => String(message).includes('Claude Code CLI'));
    expect(cliWarning).toBeDefined();
    expect(cliWarning?.[1]).toMatchObject({
      binary: '/app.asar/node_modules/sdk/claude',
      code: 'ENOTDIR',
    });
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

describe('checkClaudeDependencies — sign-in expiry', () => {
  const NOW = Date.parse('2026-09-01T13:00:00.000Z');
  /** A renewal deadline comfortably in the future — a healthy subscription sign-in. */
  const LIVE_UNTIL = Date.parse('2026-09-20T04:51:04.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockedDeadlines.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports how long a subscription sign-in has left, while still calling it satisfied', async () => {
    bundledHost(() => LOGGED_IN_JSON);
    mockedDeadlines.mockResolvedValue({
      accessExpiresAt: NOW + 3_600_000,
      renewableUntil: LIVE_UNTIL,
    });

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(auth.status).toBe('satisfied');
    expect(auth.expiresAt).toBe('2026-09-20T04:51:04.000Z');
  });

  it('stops calling a run-out sign-in "signed in" — the Ready label was the bug', async () => {
    // `claude auth status` still reports loggedIn (it reads stored state), but
    // both deadlines have passed, so a real turn would fail. Demoting to
    // `missing` is what routes this to Connect instead of showing Ready.
    bundledHost(() => LOGGED_IN_JSON);
    mockedDeadlines.mockResolvedValue({
      accessExpiresAt: NOW - 3_600_000,
      renewableUntil: NOW - 1,
    });

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(auth.status).toBe('missing');
    expect(auth.description).toMatch(/run out/i);
    expect(auth.installHint).toBe(LOGIN_HINT);
    expect(auth.expiresAt).toBe(new Date(NOW - 1).toISOString());
  });

  it('stays satisfied while the sign-in can still renew itself, however stale the token', async () => {
    // The ordinary overnight case. Nothing is wrong and nothing should be said.
    bundledHost(() => LOGGED_IN_JSON);
    mockedDeadlines.mockResolvedValue({
      accessExpiresAt: NOW - 3_600_000,
      renewableUntil: LIVE_UNTIL,
    });

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(auth.status).toBe('satisfied');
    expect(auth.description).toMatch(/signed in/i);
  });

  it('never reads a deadline for an inherited API key, whose sign-in has none', async () => {
    bundledHost(() => JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(auth.status).toBe('satisfied');
    expect(auth.expiresAt).toBeUndefined();
    // Attributing the stored account's deadline to an env credential would warn
    // about an account that is not even in use, so the read must not happen.
    expect(mockedDeadlines).not.toHaveBeenCalled();
  });

  it('never reads a deadline for an inherited OAuth token', async () => {
    bundledHost(() => JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }));

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(auth.status).toBe('satisfied');
    expect(mockedDeadlines).not.toHaveBeenCalled();
  });

  it('says nothing at all when the deadline cannot be read', async () => {
    // Unknown must be indistinguishable from healthy: no field, no demotion.
    bundledHost(() => LOGGED_IN_JSON);
    mockedDeadlines.mockResolvedValue(null);

    const [, auth] = await checkClaudeDependencies({ config: stubConfig({}) });

    expect(auth.status).toBe('satisfied');
    expect(auth.expiresAt).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBinaryProbe } from '../../../shared/run-probe.js';
import { claudeConfigDirEnv } from '../../claude-config-dir.js';
import {
  claudeCredentialKeychainService,
  isSignInUnusable,
  parseClaudeSignInDeadlines,
  readClaudeSignInDeadlines,
} from '../claude-sign-in-expiry.js';

vi.mock('../../../shared/run-probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/run-probe.js')>()),
  runBinaryProbe: vi.fn(),
}));
vi.mock('../../claude-config-dir.js', () => ({ claudeConfigDirEnv: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: vi.fn(() => ({ error: '' })),
}));

const mockedProbe = vi.mocked(runBinaryProbe);
const mockedConfigDirEnv = vi.mocked(claudeConfigDirEnv);

/** A synthetic default account: the one Claude Code reaches with CLAUDE_CONFIG_DIR unset. */
const DEFAULT_ROOT = '/home/dev/.claude';
/** A synthetic non-default account, which Claude Code reaches with CLAUDE_CONFIG_DIR set. */
const NAMED_ROOT = '/home/dev/.claude-work';

/** Build a credential blob in the shape the Claude CLI actually stores. */
function credentialBlob(claudeAiOauth: Record<string, unknown>): string {
  return JSON.stringify({
    // Real stores carry a large `mcpOAuth` map alongside the sign-in. It must
    // never be mistaken for the sign-in's own deadlines.
    mcpOAuth: {
      'posthog|b66af36bf9e35c01': { serverName: 'posthog', expiresAt: 1788274527725 },
    },
    claudeAiOauth,
  });
}

/** The deadlines a healthy, freshly-refreshed sign-in carries (measured 2026-09-01). */
const HEALTHY = {
  accessToken: 'redacted-access',
  refreshToken: 'redacted-refresh',
  expiresAt: 1788280376072, // 2026-09-01T16:32:56Z — access token, ~3.5h out
  refreshTokenExpiresAt: 1789879864072, // 2026-09-20T04:51:04Z — the sign-in itself
  scopes: ['user:inference'],
  subscriptionType: 'max',
};

/** Instant the HEALTHY fixture was captured. */
const CAPTURED_AT = 1788267695464; // 2026-09-01T13:01:35Z

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

describe('parseClaudeSignInDeadlines', () => {
  it('reads both deadlines off a real-shaped credential store', () => {
    expect(parseClaudeSignInDeadlines(credentialBlob(HEALTHY))).toEqual({
      accessExpiresAt: 1788280376072,
      renewableUntil: 1789879864072,
    });
  });

  it('never mistakes an MCP server’s expiry for the sign-in’s', () => {
    // The MCP entry's `expiresAt` (1788274527725) must not leak into either field.
    const parsed = parseClaudeSignInDeadlines(credentialBlob(HEALTHY));
    expect(parsed?.accessExpiresAt).not.toBe(1788274527725);
    expect(parsed?.renewableUntil).not.toBe(1788274527725);
  });

  it('reads a blanked, already-dead sign-in (the state a failed renewal leaves behind)', () => {
    // Measured on a real account whose renewal window had passed: the CLI empties
    // the tokens and zeroes the access deadline, but leaves the renewal deadline.
    const parsed = parseClaudeSignInDeadlines(
      credentialBlob({
        accessToken: '',
        refreshToken: '',
        expiresAt: 0,
        refreshTokenExpiresAt: 1788209503349, // 2026-08-31T20:51:43Z
        subscriptionType: 'max',
      })
    );
    expect(parsed).toEqual({ accessExpiresAt: 0, renewableUntil: 1788209503349 });
  });

  it('returns null when there is no claude.ai sign-in in the store', () => {
    expect(parseClaudeSignInDeadlines(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
  });

  it('returns null when the renewal deadline is absent (older CLI versions)', () => {
    expect(
      parseClaudeSignInDeadlines(credentialBlob({ accessToken: 'x', expiresAt: 123 }))
    ).toBeNull();
  });

  it('returns null when a deadline is not a number', () => {
    expect(
      parseClaudeSignInDeadlines(
        credentialBlob({ expiresAt: '1788280376072', refreshTokenExpiresAt: 1789879864072 })
      )
    ).toBeNull();
  });

  it('returns null on malformed JSON and on an empty read', () => {
    expect(parseClaudeSignInDeadlines('not json {')).toBeNull();
    expect(parseClaudeSignInDeadlines('')).toBeNull();
  });

  it('returns null when the store parses to a non-object', () => {
    expect(parseClaudeSignInDeadlines('null')).toBeNull();
    expect(parseClaudeSignInDeadlines('"a string"')).toBeNull();
  });
});

describe('isSignInUnusable', () => {
  it('is false for a healthy sign-in at the moment it was captured', () => {
    expect(
      isSignInUnusable(
        { accessExpiresAt: 1788280376072, renewableUntil: 1789879864072 },
        CAPTURED_AT
      )
    ).toBe(false);
  });

  it('is false while the sign-in can still renew itself, however stale the access token', () => {
    // This is the ordinary overnight case: the access token died hours ago and
    // the next turn silently renews it. Warning here would fire every few hours.
    expect(
      isSignInUnusable(
        { accessExpiresAt: CAPTURED_AT - 60_000, renewableUntil: CAPTURED_AT + 86_400_000 },
        CAPTURED_AT
      )
    ).toBe(false);
  });

  it('is false while a live access token outlives the renewal deadline', () => {
    // Renewal window closed, but the token in hand still works for a few hours.
    // Calling this unusable would be a false alarm on a session that still runs.
    expect(
      isSignInUnusable(
        { accessExpiresAt: CAPTURED_AT + 3_600_000, renewableUntil: CAPTURED_AT - 1 },
        CAPTURED_AT
      )
    ).toBe(false);
  });

  it('is true once the access token is dead AND the sign-in can no longer renew', () => {
    // The operator's failure: away long enough that both deadlines passed, while
    // `claude auth status` still reported a stored sign-in.
    expect(
      isSignInUnusable(
        { accessExpiresAt: CAPTURED_AT - 3_600_000, renewableUntil: CAPTURED_AT - 1 },
        CAPTURED_AT
      )
    ).toBe(true);
  });

  it('treats a deadline exactly at `now` as passed', () => {
    expect(
      isSignInUnusable({ accessExpiresAt: CAPTURED_AT, renewableUntil: CAPTURED_AT }, CAPTURED_AT)
    ).toBe(true);
  });
});

describe('claudeCredentialKeychainService', () => {
  it('uses the unsuffixed entry when CLAUDE_CONFIG_DIR is unset', () => {
    // Verified against a real machine: `~/.claude`'s entry is the unsuffixed one
    // and the suffixed spelling of that path does not exist.
    expect(claudeCredentialKeychainService(undefined)).toBe('Claude Code-credentials');
  });

  it('suffixes with the first 8 hex of sha256(configDir) when it is set', () => {
    // The naming rule was confirmed against real Keychain entries; these paths
    // are synthetic, and only the hash of the literal matters, so they pin the
    // rule identically on any machine.
    expect(claudeCredentialKeychainService(NAMED_ROOT)).toBe('Claude Code-credentials-685abfe8');
    expect(claudeCredentialKeychainService('/home/dev/.claude-play')).toBe(
      'Claude Code-credentials-5f3e7973'
    );
  });
});

describe('readClaudeSignInDeadlines', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // The real function returns `undefined` for the default root and the path
    // itself otherwise — that is the rule deciding which Keychain branch is read.
    mockedConfigDirEnv.mockImplementation((root: string) => ({
      CLAUDE_CONFIG_DIR: root === DEFAULT_ROOT ? undefined : root,
    }));
  });

  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('reads the Keychain entry for the account it was given on macOS', async () => {
    setPlatform('darwin');
    mockedProbe.mockResolvedValue(credentialBlob(HEALTHY));

    await expect(readClaudeSignInDeadlines(NAMED_ROOT)).resolves.toEqual({
      accessExpiresAt: 1788280376072,
      renewableUntil: 1789879864072,
    });
    expect(mockedProbe).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', 'Claude Code-credentials-685abfe8'],
      expect.any(Number)
    );
  });

  it('reads the DEFAULT account from the unsuffixed Keychain entry', async () => {
    // A chosen default account and the default account are different Keychain
    // entries; reading the wrong one would describe someone else's sign-in.
    setPlatform('darwin');
    mockedProbe.mockResolvedValue(credentialBlob(HEALTHY));

    await readClaudeSignInDeadlines(DEFAULT_ROOT);

    expect(mockedProbe).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', 'Claude Code-credentials'],
      expect.any(Number)
    );
  });

  it('reads the credentials file beside that same account off macOS', async () => {
    setPlatform('linux');
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(credentialBlob(HEALTHY) as never);

    await expect(readClaudeSignInDeadlines(NAMED_ROOT)).resolves.toEqual({
      accessExpiresAt: 1788280376072,
      renewableUntil: 1789879864072,
    });
    expect(readFile).toHaveBeenCalledWith('/home/dev/.claude-work/.credentials.json', 'utf-8');
    expect(mockedProbe).not.toHaveBeenCalled();
  });

  it('answers "unknown" rather than throwing when the Keychain read fails', async () => {
    setPlatform('darwin');
    mockedProbe.mockRejectedValue(new Error('The specified item could not be found'));

    await expect(readClaudeSignInDeadlines(NAMED_ROOT)).resolves.toBeNull();
  });

  it('answers "unknown" rather than throwing when the credentials file is absent', async () => {
    setPlatform('linux');
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    await expect(readClaudeSignInDeadlines(NAMED_ROOT)).resolves.toBeNull();
  });
});

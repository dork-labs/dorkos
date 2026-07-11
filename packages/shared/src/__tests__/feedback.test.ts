import { describe, it, expect } from 'vitest';
import {
  buildIssueUrl,
  redactSecrets,
  sanitizeFlags,
  FEEDBACK_ISSUES_NEW_URL,
  type FeedbackReport,
} from '../feedback.js';

describe('sanitizeFlags', () => {
  it('keeps only allowlisted booleans, numbers, and safe enums', () => {
    const result = sanitizeFlags({
      'tunnel.enabled': true,
      'tasks.enabled': false,
      'logging.level': 'info',
      'runtimes.default': 'claude-code',
    });
    expect(result).toEqual({
      'tunnel.enabled': true,
      'tasks.enabled': false,
      'logging.level': 'info',
      'runtimes.default': 'claude-code',
    });
  });

  it('drops keys that are not on the allowlist', () => {
    const result = sanitizeFlags({
      'tunnel.authtoken': 'ngrok-secret-token',
      'mcp.apiKey': 'sk-live-1234567890',
      'server.cwd': '/Users/dorian/code/secret-project',
      'scheduler.timezone': 'America/New_York',
    });
    expect(result).toEqual({});
  });

  it('drops allowlisted keys whose value is the wrong type', () => {
    const result = sanitizeFlags({
      'tunnel.enabled': 'yes', // expected boolean
      'tasks.enabled': 1, // expected boolean
    });
    expect(result).toEqual({});
  });

  it('rejects enum values that look like a path or token', () => {
    const result = sanitizeFlags({
      'logging.level': '/Users/dorian/.dork/logs',
      'runtimes.default': 'ghp_abcdefghijklmnopqrstuvwxyz',
      'ui.theme': 'has spaces',
    });
    expect(result).toEqual({});
  });

  it('drops an enum value outside its known set even if it looks harmless', () => {
    // A user-customized theme name is short and lowercase but not a known theme.
    const result = sanitizeFlags({ 'ui.theme': 'midnight-custom', 'logging.level': 'info' });
    expect(result).toEqual({ 'logging.level': 'info' });
    expect(result['ui.theme']).toBeUndefined();
  });
});

describe('redactSecrets', () => {
  it('redacts emails', () => {
    expect(redactSecrets('reach me at dorian@dorkian.com now')).not.toContain('dorian@dorkian.com');
    expect(redactSecrets('reach me at dorian@dorkian.com now')).toContain('[email]');
  });

  it('redacts credential-prefixed tokens', () => {
    for (const token of ['ghp_abc123DEF456ghi789', 'sk-proj-abcdef123456', 'xoxb-1-2-token']) {
      const out = redactSecrets(`token is ${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain('[redacted]');
    }
  });

  it('redacts unix home directories and absolute paths', () => {
    const out = redactSecrets('config at /Users/dorian/.dork/config.json here');
    expect(out).not.toContain('/Users/dorian');
    expect(out).not.toContain('dorian');
  });

  it('redacts windows paths', () => {
    const out = redactSecrets('at C:\\Users\\Dorian\\AppData\\config.json');
    expect(out).not.toContain('Dorian');
    expect(out).toContain('[path]');
  });

  it('redacts long high-entropy tokens', () => {
    const secret = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
    const out = redactSecrets(`bearer body ${secret}`);
    expect(out).not.toContain(secret);
  });

  it('redacts IPv4 and IPv6 addresses', () => {
    const v4 = redactSecrets('host at 10.20.30.40 here');
    expect(v4).not.toContain('10.20.30.40');
    expect(v4).toContain('[ip]');
    const v6 = redactSecrets('host at 2001:0db8:85a3:0000:0000:8a2e:0370:7334 here');
    expect(v6).not.toContain('2001:0db8:85a3');
    expect(v6).toContain('[ip]');
  });

  it('redacts UNC network paths', () => {
    const out = redactSecrets('share at \\\\CORP-FS\\home\\dorian here');
    expect(out).not.toContain('CORP-FS');
    expect(out).not.toContain('dorian');
    expect(out).toContain('[path]');
  });

  it('redacts AWS-style access key ids', () => {
    const out = redactSecrets('key AKIAIOSFODNN7EXAMPLE used');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[redacted]');
  });

  it('redacts a Windows path that contains a space', () => {
    const out = redactSecrets('at C:\\Program Files\\DorkOS\\config.json');
    expect(out).not.toContain('Program Files');
    expect(out).toContain('[path]');
  });

  // Documents the limit: redaction is best-effort, NOT the guarantee. A bare
  // internal hostname has no reliable shape, so this net leaves it untouched.
  // It can never reach a report because no allowlisted field holds a hostname
  // (the positive allowlist is the real guarantee).
  it('does NOT catch a bare internal hostname (best-effort limit)', () => {
    const out = redactSecrets('server prod-db-01.internal responded');
    expect(out).toContain('prod-db-01.internal');
  });
});

describe('buildIssueUrl', () => {
  const baseReport: FeedbackReport = {
    kind: 'bug',
    version: '0.45.1',
    platform: 'darwin-arm64',
    runtimes: ['claude-code', 'codex'],
    surface: 'web /agents',
    flags: { 'tunnel.enabled': false, 'tasks.enabled': true },
  };

  it('points at the DorkOS issues/new endpoint', () => {
    expect(buildIssueUrl(baseReport)).toContain(FEEDBACK_ISSUES_NEW_URL);
  });

  it('includes version, platform, runtimes, surface, and flags in the body', () => {
    const body = new URL(buildIssueUrl(baseReport)).searchParams.get('body') ?? '';
    expect(body).toContain('0.45.1');
    expect(body).toContain('darwin-arm64');
    expect(body).toContain('claude-code, codex');
    expect(body).toContain('web /agents');
    expect(body).toContain('tunnel.enabled: false');
  });

  it('applies the correct label per kind', () => {
    expect(buildIssueUrl({ ...baseReport, kind: 'bug' })).toContain('labels=bug');
    expect(buildIssueUrl({ ...baseReport, kind: 'feature' })).toContain('labels=enhancement');
    expect(buildIssueUrl({ ...baseReport, kind: 'runtime' })).toContain('labels=bug');
  });

  // The security-critical guarantee: even a report deliberately poisoned with a
  // home path, a token, and an email produces a URL that leaks none of them.
  it('never leaks a secret, path, or email even when the report is poisoned', () => {
    const poisoned: FeedbackReport = {
      kind: 'bug',
      version: '0.45.1',
      platform: 'darwin-arm64 /Users/dorian/leak',
      runtimes: ['claude-code', 'ghp_abcdefghijklmnopqrstuvwxyz'],
      surface: 'dorian@dorkian.com',
      flags: { 'tunnel.enabled': false },
    };
    const url = buildIssueUrl(poisoned);
    const params = new URL(url).searchParams;
    const decoded = `${params.get('title')}\n${params.get('body')}`;

    expect(decoded).not.toContain('/Users/dorian');
    expect(decoded).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(decoded).not.toContain('dorian@dorkian.com');
    expect(decoded).not.toContain('dorian');
  });
});

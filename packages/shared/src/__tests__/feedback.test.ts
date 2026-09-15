import { describe, it, expect } from 'vitest';
import {
  buildIssueUrl,
  gatherFeedbackReport,
  redactSecrets,
  sanitizeFlags,
  FEEDBACK_FLAG_ALLOWLIST,
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
      'scheduler.maxConcurrentRuns': 4,
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

describe('gatherFeedbackReport', () => {
  /** A config reader backed by a dotted-key map, like the CLI's store. */
  function reader(values: Record<string, unknown>) {
    return (key: string) => values[key];
  }

  const host = { version: '0.45.1', platform: 'darwin-arm64', surface: 'cli' } as const;

  it('reads only allowlisted paths, and reads every one of them', () => {
    const asked: string[] = [];
    gatherFeedbackReport({
      kind: 'bug',
      ...host,
      readConfigValue: (key) => {
        asked.push(key);
        return undefined;
      },
    });
    // Set equality in both directions: a gatherer that skipped a flag would
    // silently under-report, and one that reached for a key outside the
    // allowlist is the bug the allowlist exists to make impossible.
    expect(new Set(asked)).toEqual(
      new Set([
        ...Object.keys(FEEDBACK_FLAG_ALLOWLIST),
        'runtimes.codex.enabled',
        'runtimes.opencode.enabled',
      ])
    );
  });

  it('includes codex and opencode unless they are explicitly off', () => {
    expect(
      gatherFeedbackReport({ kind: 'bug', ...host, readConfigValue: reader({}) }).runtimes
    ).toEqual(['claude-code', 'codex', 'opencode']);

    expect(
      gatherFeedbackReport({
        kind: 'bug',
        ...host,
        readConfigValue: reader({ 'runtimes.opencode.enabled': false }),
      }).runtimes
    ).toEqual(['claude-code', 'codex']);
  });

  it('sanitizes what it read, so an unsafe config value cannot reach the report', () => {
    const report = gatherFeedbackReport({
      kind: 'bug',
      ...host,
      readConfigValue: reader({
        'tunnel.enabled': true,
        // On the allowlist, but not a member of its known enum set.
        'ui.theme': 'midnight-custom',
        // Not on the allowlist at all.
        'tunnel.authtoken': 'ngrok-secret-token',
      }),
    });
    expect(report.flags).toEqual({ 'tunnel.enabled': true });
    expect(JSON.stringify(report)).not.toContain('ngrok-secret-token');
  });

  it('omits title and body entirely when none were written', () => {
    const report = gatherFeedbackReport({ kind: 'bug', ...host, readConfigValue: reader({}) });
    expect('title' in report).toBe(false);
    expect('body' in report).toBe(false);
  });

  it('differs by exactly one line between two surfaces on the same host', () => {
    // The claim `feedback_draft` rests on: an agent hands a person the link
    // `dorkos feedback --print` would have printed, and `Reported from` is the
    // only line in it that knows the difference (DOR-2056).
    const values = { 'tunnel.enabled': false, 'logging.level': 'info' };
    const cli = buildIssueUrl(
      gatherFeedbackReport({ kind: 'bug', ...host, readConfigValue: reader(values) })
    );
    const agent = buildIssueUrl(
      gatherFeedbackReport({
        kind: 'bug',
        ...host,
        surface: 'agent',
        readConfigValue: reader(values),
      })
    );

    const bodyOf = (url: string) => (new URL(url).searchParams.get('body') ?? '').split('\n');
    const differing = bodyOf(cli)
      .map((line, i) => [line, bodyOf(agent)[i]] as const)
      .filter(([a, b]) => a !== b);

    expect(differing).toEqual([['- Reported from: cli', '- Reported from: agent']]);
    expect(bodyOf(cli)).toHaveLength(bodyOf(agent).length);
  });
});

describe('a written title and body', () => {
  const base = {
    kind: 'bug' as const,
    version: '0.45.1',
    platform: 'darwin-arm64',
    runtimes: ['claude-code'],
    surface: 'agent',
    flags: {},
  };

  const parts = (report: FeedbackReport) => {
    const params = new URL(buildIssueUrl(report)).searchParams;
    return { title: params.get('title') ?? '', body: params.get('body') ?? '' };
  };

  it('replaces the placeholder title and the blank questions', () => {
    const { title, body } = parts({
      ...base,
      title: 'Sessions stop streaming after a sleep',
      body: 'The reply stops mid-sentence and never resumes.',
    });
    expect(title).toBe('Sessions stop streaming after a sleep');
    expect(body).toContain('The reply stops mid-sentence and never resumes.');
    expect(body).not.toContain('## What happened?');
    // The environment block still rides along underneath.
    expect(body).toContain('- DorkOS version: 0.45.1');
  });

  it('falls back to the blank questions for an empty or whitespace-only write', () => {
    const { title, body } = parts({ ...base, title: '   ', body: '\n  \n' });
    expect(title).toBe('Bug: (describe what went wrong)');
    expect(body).toContain('## What happened?');
  });

  // The behaviour DOR-2056 asks for by name, asserted against what
  // `redactSecrets` ACTUALLY does rather than against its docblock's promise.
  it('scrubs a token, an absolute path and an email out of written prose', () => {
    const { title, body } = parts({
      ...base,
      title: 'Crash from dorian@dorkian.example',
      body: [
        'Ran with token ghp_abc123DEF456ghi789JKL012mno345 and it died.',
        'Stack points at /Users/dorian/Keep/dork-os/dorkos/apps/server/src/index.ts',
        'The box at 10.0.0.1 is fine.',
      ].join('\n'),
    });
    const decoded = `${title}\n${body}`;

    expect(decoded).not.toContain('ghp_abc123DEF456ghi789JKL012mno345');
    expect(decoded).not.toContain('/Users/dorian');
    expect(decoded).not.toContain('dorian@dorkian.example');
    expect(decoded).not.toContain('10.0.0.1');
    // And the prose around them survives, or the scrub would be useless.
    expect(decoded).toContain('and it died.');
    expect(decoded).toContain('Stack points at');
  });

  // The limit the module docblock states, pinned so nobody upgrades the claim.
  // `redactSecrets` is a defence over free-form prose, not a guarantee: an
  // internal hostname has no shape it recognizes and survives untouched. What
  // stops this reaching GitHub is the person who opens the link and reads it.
  it('does NOT catch everything a written body can carry', () => {
    const { body } = parts({ ...base, body: 'It only fails on build-07.corp.internal.' });
    expect(body).toContain('build-07.corp.internal');
  });
});

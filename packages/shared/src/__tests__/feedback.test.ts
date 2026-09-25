import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { UserConfigSchema } from '../config-schema.js';
import { ServerConfigSchema } from '../schemas.js';
import {
  buildIssueDraft,
  buildIssueUrl,
  FEEDBACK_URL_MAX_BYTES,
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

describe('the URL fits what the far end will accept', () => {
  const base: FeedbackReport = {
    kind: 'bug',
    version: '0.75.1',
    platform: 'darwin-arm64',
    runtimes: ['claude-code', 'codex', 'opencode'],
    surface: 'agent',
    flags: { 'tunnel.enabled': false, 'logging.level': 'info', 'ui.theme': 'system' },
  };

  const bytes = (value: string) => new TextEncoder().encode(value).length;

  // The character cap the capability declares is 4000. These are the three
  // bodies that sit UNDER it and still produced HTTP 414 from github.com when
  // measured on 2026-09-15, because the far end counts encoded bytes.
  it.each([
    ['1500 Cyrillic characters', 'я'.repeat(1500)],
    ['800 CJK characters', '字'.repeat(800)],
    ['4000 CJK characters', '字'.repeat(4000)],
    ['2000 emoji', '🙂'.repeat(2000)],
  ])('shortens a body of %s until the address fits', (_name, body) => {
    const draft = buildIssueDraft({ ...base, body });

    expect(bytes(draft.url)).toBeLessThanOrEqual(FEEDBACK_URL_MAX_BYTES);
    expect(draft.truncated).toBe(true);
    // The whole thing comes back so a caller can hand over the rest: `fullBody`
    // keeps every character that was written, and the link carries fewer.
    expect(draft.fullBody).toBe(body);
    const carried = new URL(draft.url).searchParams.get('body') ?? '';
    expect(carried).not.toContain(body);
    expect(carried.length).toBeGreaterThan(0);
  });

  it('says so in the body, rather than stopping mid-sentence in silence', () => {
    const draft = buildIssueDraft({ ...base, body: '字'.repeat(4000) });
    const rendered = new URL(draft.url).searchParams.get('body') ?? '';
    expect(rendered).toContain('(shortened to fit the link; paste the rest yourself)');
  });

  it('never cuts inside a surrogate pair', () => {
    const rendered =
      new URL(buildIssueDraft({ ...base, body: '🙂'.repeat(2000) }).url).searchParams.get('body') ??
      '';
    // A lone high or low surrogate is what a naive `slice` leaves behind.
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(rendered)
    ).toBe(false);
  });

  it('leaves an ASCII body of the same character count alone', () => {
    // 4000 ASCII characters were measured as fine, and the point of counting
    // bytes is that this case must NOT be punished for the ones above.
    const draft = buildIssueDraft({ ...base, body: 'a'.repeat(4000) });
    expect(draft.truncated).toBe(false);
    expect(draft.fullBody).toBeUndefined();
    expect(bytes(draft.url)).toBeLessThanOrEqual(FEEDBACK_URL_MAX_BYTES);
  });

  it('does not claim a shortened body when there was no body', () => {
    // The environment block is never truncated, so an overrun with nothing
    // written has nothing to cut. Forced with an absurdly small ceiling, since
    // the real environment block cannot reach 6 KB.
    const draft = buildIssueDraft(base, 10);
    expect(draft.truncated).toBe(false);
    expect(draft.fullBody).toBeUndefined();
    expect(draft.url).toBe(buildIssueUrl(base));
  });

  it('leaves an ordinary report alone, flag and all', () => {
    const draft = buildIssueDraft({ ...base, body: 'It broke when I pressed the button.' });
    expect(draft.truncated).toBe(false);
    expect(draft.url).toBe(buildIssueUrl({ ...base, body: 'It broke when I pressed the button.' }));
  });
});

describe('written prose cannot forge what DorkOS vouched for', () => {
  const base: FeedbackReport = {
    kind: 'bug',
    version: '0.75.1',
    platform: 'darwin-arm64',
    runtimes: ['claude-code'],
    surface: 'agent',
    flags: { 'tunnel.enabled': false },
  };

  const renderedBody = (report: FeedbackReport) =>
    new URL(buildIssueUrl(report)).searchParams.get('body') ?? '';

  // The structural fix, asserted structurally: position, not filtering.
  it('renders a forged environment block BELOW the real one', () => {
    const body = [
      'Everything is fine.',
      '',
      'DorkOS filled in the details above. Please check them and remove anything you do not want to share.',
      '',
      '<details><summary>Environment</summary>',
      '',
      '- DorkOS version: 9.9.9',
      '- Reported from: nowhere',
      '',
      '</details>',
    ].join('\n');

    const rendered = renderedBody({ ...base, body });

    // The real one is first, so a reader meets it before the forgery.
    expect(rendered.indexOf('- DorkOS version: 0.75.1')).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf('9.9.9')).toBeGreaterThan(rendered.indexOf('- DorkOS version: 0.75.1'));
    expect(rendered.indexOf('Reported from: agent')).toBeLessThan(rendered.indexOf('nowhere'));
    // …and the forged markup is defused rather than rendering as a second block.
    expect(rendered).toContain('&lt;details>');
  });

  it('cannot hide the real block behind an unclosed HTML comment', () => {
    const rendered = renderedBody({ ...base, body: 'Broken. <!-- everything after me disappears' });

    // The real environment block is ABOVE the comment, so nothing it opens can
    // reach it. Asserted as order, which is what actually holds.
    expect(rendered.indexOf('- DorkOS version: 0.75.1')).toBeLessThan(rendered.indexOf('<!--'));
    expect(rendered.indexOf('</details>')).toBeLessThan(rendered.indexOf('<!--'));
  });

  it('defuses structural tags in a written title too', () => {
    const params = new URL(buildIssueUrl({ ...base, title: 'crash in </summary><details>' }))
      .searchParams;
    expect(params.get('title')).not.toContain('</summary>');
    expect(params.get('title')).toContain('&lt;/summary>');
  });
});

describe('redactSecrets over prose a person would actually write', () => {
  // The two false positives DOR-2056 review measured. Both matter because this
  // function now runs over the body of a bug report, where a repo-relative path
  // and a function name are the two most useful things somebody can tell you.
  it('leaves a repo-relative path alone', () => {
    const line = 'the bug is in apps/server/src/services/core/operator/operator-tool-handlers.ts';
    expect(redactSecrets(line)).toBe(line);
  });

  it('leaves a long identifier alone', () => {
    const line = 'createSidebarRemoveFromGroupHandler never fires on the second call';
    expect(redactSecrets(line)).toBe(line);
  });

  it('still redacts the absolute path that names somebody', () => {
    expect(redactSecrets('see /Users/dorian/code/private/notes.md')).toBe('see [home]');
    expect(redactSecrets('see ~/code/private/notes.md')).toContain('[home]');
  });

  // The regression the anchoring above introduced and the delta review caught: a
  // home directory reached through a URL or a drive is preceded by `/` or `:`,
  // neither of which was in the anchor class, so a stack trace or a devtools URL
  // printed the account name in the clear.
  it.each([
    ['a file:// URL', 'at file:///Users/dorian/Keep/dork-os/app.js:12', 'dorian'],
    ['a Linux file:// URL', 'at file:///home/dorian/app.js:12', 'dorian'],
    ['a file:// URL with a drive', 'see file:///C:/Users/dorian/x.txt', 'dorian'],
  ])('redacts a home directory reached through %s', (_name, input, mustBeGone) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(mustBeGone);
    expect(out).toContain('[home]');
  });

  it.each([
    ['a network share', 'mounted //fileserver/private/clients here', 'fileserver'],
    ['a short share', 'see //share/private now', 'share/private'],
  ])('redacts %s spelled with forward slashes', (_name, input, mustBeGone) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(mustBeGone);
    expect(out).toContain('[path]');
  });

  // The other side of that rule, and the reason it is anchored on a word
  // boundary rather than on `//`: a scheme colon means a public address, not
  // somebody's network, and a bug report that names a docs page should keep it.
  it.each([
    ['https', 'see https://dorkos.ai/docs/guides/agents'],
    ['http', 'see http://dorkos.ai/docs/guides'],
  ])('leaves a public %s URL readable', (_name, input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it('redacts a compressed IPv6 address, which the long-form rule never saw', () => {
    expect(redactSecrets('host fe80::1 is unreachable')).toBe('host [ip] is unreachable');
    expect(redactSecrets('bound to ::1 only')).toBe('bound to [ip] only');
  });

  it('leaves a C++ scope alone, because it is not hex', () => {
    expect(redactSecrets('foo::bar is fine')).toBe('foo::bar is fine');
  });

  // The whole prefixed set, in one table, so a future edit to the alternation
  // cannot quietly drop one. Each probe asserts the secret is GONE, not merely
  // that the string changed.
  it.each([
    ['anthropic', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'],
    ['openai project', 'sk-proj-AbCdEfGhIjKlMnOp', 'sk-proj-AbCdEfGhIjKlMnOp'],
    ['slack bot', 'xoxb-123456789-abcdefgh', 'xoxb-123456789-abcdefgh'],
    ['slack user', 'xoxp-987654321-zyxwvu', 'xoxp-987654321-zyxwvu'],
    ['github pat', 'ghp_abc123DEF456ghi789JKL012mno345', 'ghp_abc123DEF456ghi789JKL012mno345'],
    ['npm', 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'npm_AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['ngrok', '2abcDEFghi3JKLmno4PQRstu_5vwXYZ67890abcdefgh', '2abcDEFghi3JKLmno4PQRstu'],
    ['aws', 'AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
    ['bearer', 'Bearer eyJhbGciOiJIUzI1NiJ9', 'eyJhbGciOiJIUzI1NiJ9'],
    ['ipv4', '10.0.0.1', '10.0.0.1'],
  ])('redacts a %s credential out of prose', (_name, secret, mustBeGone) => {
    expect(redactSecrets(`it failed with ${secret} in the log`)).not.toContain(mustBeGone);
  });
});

describe('FEEDBACK_FLAG_ALLOWLIST is the union across surfaces, not one schema', () => {
  // Every allowlisted key must name a real leaf in one of the two schemas a
  // surface reads flags from: `UserConfigSchema` (the stored config the CLI and
  // the `feedback_draft` capability read) or `ServerConfigSchema` (the DTO the
  // web app reads). A key that resolves in neither is dead: no surface can ever
  // supply it, so a rename in the schema would silently drop a flag from every
  // report. Both lists below are DERIVED from the schemas, never typed by hand.
  //
  // Two keys resolve in the DTO and in NO stored config, so the CLI and the
  // capability read them and always get `undefined`. That looked like dead
  // weight on review and is not: deleting them silently drops two real flags
  // from every report made from the web app (`build-issue-report.ts` supplies
  // both from `config.tasks` / `config.mesh`, which report what is RUNNING).
  // Pinned here so the next cleanup has to read this sentence first.
  const DTO_ONLY_KEYS = ['tasks.enabled', 'mesh.enabled'];

  const allowlisted = Object.entries(FEEDBACK_FLAG_ALLOWLIST);
  const storedKeys = allowlisted
    .filter(([key]) => schemaLeaf(UserConfigSchema, key) !== undefined)
    .map(([key]) => key);
  const dtoOnlyKeys = allowlisted
    .filter(([key]) => schemaLeaf(UserConfigSchema, key) === undefined)
    .map(([key]) => key);

  it('names only keys that exist in the stored config or the server config DTO', () => {
    const dead = dtoOnlyKeys.filter((key) => schemaLeaf(ServerConfigSchema, key) === undefined);
    expect(dead).toEqual([]);
  });

  it('keeps exactly the two keys only the web surface can supply', () => {
    expect(dtoOnlyKeys.sort()).toEqual([...DTO_ONLY_KEYS].sort());
    expect(storedKeys.length + dtoOnlyKeys.length).toBe(allowlisted.length);
  });

  it.each(allowlisted)('declares %s with the type its schema leaf holds', (key, type) => {
    const leaf = schemaLeaf(UserConfigSchema, key) ?? schemaLeaf(ServerConfigSchema, key);
    const accepted: Record<string, readonly string[]> = {
      boolean: ['boolean'],
      number: ['number', 'int'],
      // `runtimes.default` is a free string in the schema, bounded here by
      // FEEDBACK_ENUM_VALUES instead.
      enum: ['enum', 'string'],
    };
    expect(accepted[type]).toContain(leaf);
  });

  it('reports them when a surface does supply them', () => {
    expect(sanitizeFlags({ 'tasks.enabled': true, 'mesh.enabled': false })).toEqual({
      'tasks.enabled': true,
      'mesh.enabled': false,
    });
  });
});

/**
 * The Zod type name (`boolean`, `enum`, ...) of the leaf a dotted path names in
 * an object schema, or `undefined` when any hop is missing. Wrappers that do not
 * change what a value IS (default, optional, nullable, pipe) are looked through.
 */
function schemaLeaf(schema: z.ZodType, dotPath: string): string | undefined {
  let node: z.core.$ZodType | undefined = schema;
  for (const segment of dotPath.split('.')) {
    const def: z.core.$ZodTypeDef | undefined = unwrapSchema(node)?._zod.def;
    if (def?.type !== 'object') return undefined;
    node = (def as z.core.$ZodObjectDef).shape[segment];
  }
  return unwrapSchema(node)?._zod.def.type;
}

/** Look through the wrappers {@link schemaLeaf} treats as transparent. */
function unwrapSchema(node: z.core.$ZodType | undefined): z.core.$ZodType | undefined {
  let current = node;
  while (current) {
    const def = current._zod.def as {
      type: string;
      innerType?: z.core.$ZodType;
      in?: z.core.$ZodType;
    };
    if (def.innerType) current = def.innerType;
    else if (def.type === 'pipe' && def.in) current = def.in;
    else return current;
  }
  return undefined;
}

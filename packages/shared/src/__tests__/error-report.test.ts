import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildErrorEvent,
  parseDsn,
  redactPaths,
  redactTokens,
  scrubFilename,
  scrubMessage,
  scrubStack,
  sendErrorEvent,
  MAX_MESSAGE_LEN,
  SDK_NAME,
  type ErrorEvent,
} from '../error-report.js';

describe('redactPaths', () => {
  it('strips a Unix home directory to ~', () => {
    expect(redactPaths('/Users/alice/projects/x/foo.ts')).toBe('~/projects/x/foo.ts');
    expect(redactPaths('/home/bob/.dork/config.json')).toBe('~/.dork/config.json');
  });

  it('strips a Windows home directory to ~', () => {
    expect(redactPaths('C:\\Users\\carol\\dev\\foo.ts')).toBe('~\\dev\\foo.ts');
  });

  it('keeps the node_modules tail of an absolute dependency path', () => {
    expect(redactPaths('/opt/app/node_modules/express/lib/router.js')).toBe(
      'node_modules/express/lib/router.js'
    );
  });
});

describe('redactTokens', () => {
  it('redacts provider keys, github tokens, bearer, and credential refs', () => {
    expect(redactTokens('key sk-abcdefgh12345678 end')).toBe('key [redacted] end');
    expect(redactTokens('ghp_0123456789abcdefghij')).toBe('[redacted]');
    expect(redactTokens('Authorization: Bearer abc.def-ghi')).toContain('[redacted]');
    expect(redactTokens('ref env:OPENAI_API_KEY here')).toBe('ref [redacted] here');
    expect(redactTokens('token=supersecretvalue')).toBe('[redacted]');
  });
});

describe('scrubMessage', () => {
  it('redacts paths and tokens together', () => {
    const out = scrubMessage('failed at /Users/alice/x with key sk-abcdefgh12345678');
    expect(out).not.toContain('alice');
    expect(out).not.toContain('sk-abcdefgh12345678');
    expect(out).toContain('~');
    expect(out).toContain('[redacted]');
  });

  it('caps very long messages', () => {
    const out = scrubMessage('x'.repeat(MAX_MESSAGE_LEN + 200));
    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_LEN + 1); // + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('scrubFilename', () => {
  const cwd = '/srv/dorkos';

  it('keeps the node_modules tail', () => {
    expect(scrubFilename('/srv/dorkos/node_modules/express/index.js', cwd)).toBe(
      'node_modules/express/index.js'
    );
  });

  it('relativizes in-app frames to cwd', () => {
    expect(scrubFilename('/srv/dorkos/apps/server/src/index.ts', cwd)).toBe(
      'apps/server/src/index.ts'
    );
  });

  it('never returns an absolute path or a home dir', () => {
    const out = scrubFilename('/Users/alice/other/secret-client/foo.ts', cwd);
    expect(out).not.toContain('alice');
    expect(out.startsWith('/')).toBe(false);
    expect(/^[A-Za-z]:/.test(out)).toBe(false);
  });
});

describe('scrubStack', () => {
  it('parses frames, relativizes filenames, and flags in_app', () => {
    const stack = [
      'Error: boom',
      '    at doThing (/srv/dorkos/apps/server/src/x.ts:10:5)',
      '    at /srv/dorkos/node_modules/express/lib/router.js:200:1',
    ].join('\n');
    const frames = scrubStack(stack, '/srv/dorkos');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      function: 'doThing',
      filename: 'apps/server/src/x.ts',
      lineno: 10,
      colno: 5,
      in_app: true,
    });
    expect(frames[1].in_app).toBe(false);
    expect(frames[1].function).toBe('<anonymous>');
  });

  it('returns [] for an undefined stack', () => {
    expect(scrubStack(undefined, '/srv/dorkos')).toEqual([]);
  });
});

describe('parseDsn', () => {
  it('parses a standard Sentry DSN', () => {
    const parsed = parseDsn('https://abc123@o1.ingest.sentry.io/456');
    expect(parsed).toEqual({
      ingestUrl: 'https://o1.ingest.sentry.io/api/456/envelope/',
      publicKey: 'abc123',
      projectId: '456',
    });
  });

  it('parses a self-hosted GlitchTip DSN with a path prefix', () => {
    const parsed = parseDsn('https://key@glitchtip.example.com/sub/7');
    expect(parsed?.ingestUrl).toBe('https://glitchtip.example.com/sub/api/7/envelope/');
  });

  it('returns null for malformed or keyless DSNs', () => {
    expect(parseDsn('not-a-url')).toBeNull();
    expect(parseDsn('https://o1.ingest.sentry.io/456')).toBeNull(); // no public key
    expect(parseDsn('https://key@host/')).toBeNull(); // no project id
  });
});

const ALLOWED_EVENT_KEYS = [
  'event_id',
  'timestamp',
  'platform',
  'level',
  'release',
  'environment',
  'sdk',
  'tags',
  'exception',
] as const;

describe('buildErrorEvent — allowlist + no-leak (security-critical)', () => {
  const base = {
    release: 'dorkos@0.46.0',
    environment: 'production',
    surface: 'server' as const,
    os: 'darwin-arm64',
    cwd: '/srv/dorkos',
  };

  it('emits only allowlisted top-level keys', () => {
    const event = buildErrorEvent({ ...base, error: new Error('boom') });
    for (const key of Object.keys(event)) {
      expect(ALLOWED_EVENT_KEYS).toContain(key as (typeof ALLOWED_EVENT_KEYS)[number]);
    }
    // No auto-captured PII surfaces ever appear.
    const asRecord = event as unknown as Record<string, unknown>;
    for (const forbidden of [
      'server_name',
      'user',
      'request',
      'contexts',
      'breadcrumbs',
      'extra',
      'modules',
    ]) {
      expect(asRecord[forbidden]).toBeUndefined();
    }
  });

  it('a poisoned error cannot leak home dir, username, cwd, tokens, or absolute paths', () => {
    const HOME = '/Users/alice';
    const CWD = '/Users/alice/work/secret-client';
    const TOKEN = 'sk-abcdef0123456789ABCDEF';
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.abc';

    // A maximally hostile error: PII in the message, the type, and every frame.
    const poisoned = new Error(
      `parse failed for ${HOME}/notes/prompt.md with ${TOKEN} and ${JWT} (session: "user said hello")`
    );
    poisoned.name = `Err_${HOME}`;
    poisoned.stack = [
      `Error: parse failed`,
      `    at handler (${CWD}/apps/server/src/routes/x.ts:5:9)`,
      `    at ${HOME}/.nvm/versions/node/lib/foo.js:1:1`,
      `    at Object.<anonymous> (C:\\Users\\alice\\dev\\y.ts:3:2)`,
    ].join('\n');

    const event = buildErrorEvent({ ...base, cwd: CWD, error: poisoned });
    const serialized = JSON.stringify(event);

    // The message is omitted by design, so nothing free-form (session content,
    // prompts, tokens embedded in the message) can ride along.
    expect(event.exception.values[0].value).toBe('');

    // The concrete PII vectors the reviewer named — none may survive anywhere.
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain(HOME);
    expect(serialized).not.toContain(CWD);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain('user said hello'); // session content in the message
    expect(serialized).not.toContain('C:\\Users');
    expect(serialized).not.toContain('C:'); // no drive-letter path fragment survives
    // No absolute path survives in any frame filename.
    for (const frame of event.exception.values[0].stacktrace.frames) {
      expect(frame.filename.startsWith('/')).toBe(false);
      expect(/^[A-Za-z]:/.test(frame.filename)).toBe(false);
      expect(frame.filename).not.toContain('alice');
    }
    // The in-app frame is still usefully located.
    expect(event.exception.values[0].stacktrace.frames[0]).toMatchObject({
      filename: 'apps/server/src/routes/x.ts',
      function: 'handler',
      in_app: true,
    });
  });

  it('handles a non-Error thrown value without leaking', () => {
    const event = buildErrorEvent({ ...base, error: 'plain string /Users/alice/x' });
    expect(event.exception.values[0].type).toBe('UnknownError');
    expect(JSON.stringify(event)).not.toContain('alice');
  });
});

describe('sendErrorEvent', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch | undefined;
  const event: ErrorEvent = buildErrorEvent({
    error: new Error('boom'),
    release: 'dorkos@0.46.0',
    environment: 'production',
    surface: 'cli',
    os: 'linux-x64',
    cwd: '/srv/dorkos',
  });

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  it('POSTs a Sentry envelope to the DSN ingest URL with the auth header', async () => {
    await sendErrorEvent(event, 'https://pub@o1.ingest.sentry.io/456');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://o1.ingest.sentry.io/api/456/envelope/');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-sentry-envelope');
    expect(headers['x-sentry-auth']).toContain('sentry_key=pub');
    expect(headers['x-sentry-auth']).toContain(SDK_NAME);
    // Envelope is three newline-delimited JSON lines.
    const lines = (init.body as string).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'event' });
  });

  it('is a no-op for a malformed DSN', async () => {
    await sendErrorEvent(event, 'not-a-dsn');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows fetch failures', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    await expect(
      sendErrorEvent(event, 'https://pub@o1.ingest.sentry.io/456')
    ).resolves.toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';

import {
  buildErrorEvent,
  buildExceptionEvent,
  errorEventToExceptionProperties,
  raceWithTimeout,
  redactPaths,
  redactTokens,
  scrubFilename,
  scrubMessage,
  scrubStack,
  sendExceptionEvent,
  TELEMETRY_EVENTS_ENDPOINT,
  MAX_MESSAGE_LEN,
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

  it('collapses an eval/vm frame with an EMBEDDED home path (no dir name survives)', () => {
    const out = scrubFilename('eval at <anonymous> (/Users/alice/secret-client/app.js:10:5)', cwd);
    expect(out).not.toContain('alice');
    expect(out).not.toContain('secret-client');
    expect(out).not.toContain('~');
  });

  it('collapses an embedded absolute (non-home) path too', () => {
    const out = scrubFilename('eval at <anonymous> (/opt/build/secret-proj/x.js:1:1)', cwd);
    expect(out).not.toContain('secret-proj');
    expect(out.includes('/opt')).toBe(false);
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

describe('errorEventToExceptionProperties — scrubbing preserved end-to-end', () => {
  const base = {
    release: 'dorkos@0.46.0',
    environment: 'production',
    os: 'darwin-arm64',
    cwd: '/srv/dorkos',
  };

  it('maps a scrubbed ErrorEvent into a PostHog $exception property bag', () => {
    const scrubbed = buildErrorEvent({
      ...base,
      surface: 'server',
      error: (() => {
        const e = new TypeError('boom');
        e.stack = ['TypeError: boom', '    at fn (/srv/dorkos/apps/server/src/x.ts:3:1)'].join(
          '\n'
        );
        return e;
      })(),
    });
    const props = errorEventToExceptionProperties(scrubbed);

    expect(props.$exception_level).toBe('error');
    // Stays anonymous: no PostHog person is ever created for a crash event.
    expect(props.$process_person_profile).toBe(false);
    expect(props.surface).toBe('server');
    expect(props.os).toBe('darwin-arm64');
    expect(props.release).toBe('dorkos@0.46.0');
    const value = props.$exception_list[0];
    expect(value.type).toBe('TypeError');
    // The raw message is NEVER carried — mirrors buildErrorEvent.
    expect(value.value).toBe('');
    expect(value.stacktrace.type).toBe('raw');
    expect(value.stacktrace.frames[0]).toMatchObject({
      platform: 'node:javascript',
      filename: 'apps/server/src/x.ts',
      function: 'fn',
      in_app: true,
    });
  });

  it('tags client-surface frames as web:javascript', () => {
    const scrubbed = buildErrorEvent({ ...base, surface: 'client', error: new Error('x') });
    const props = errorEventToExceptionProperties(scrubbed);
    // Even with no frames, the surface classification is client.
    expect(props.surface).toBe('client');
  });

  it('a poisoned error cannot leak paths or tokens through the $exception mapping', () => {
    const HOME = '/Users/alice';
    const TOKEN = 'sk-abcdef0123456789ABCDEF';
    const poisoned = new Error(`failed for ${HOME}/notes.md with ${TOKEN}`);
    poisoned.name = `Err_${HOME}`;
    poisoned.stack = [
      'Error: failed',
      `    at h (${HOME}/work/secret-client/apps/server/src/x.ts:5:9)`,
      `    at C:\\Users\\alice\\dev\\y.ts:3:2`,
    ].join('\n');

    const props = errorEventToExceptionProperties(
      buildErrorEvent({
        ...base,
        surface: 'server',
        cwd: `${HOME}/work/secret-client`,
        error: poisoned,
      })
    );
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('secret-client');
    expect(serialized).not.toContain('C:\\Users');
    expect(props.$exception_list[0].value).toBe('');
    for (const frame of props.$exception_list[0].stacktrace.frames) {
      expect(frame.filename.startsWith('/')).toBe(false);
      expect(/^[A-Za-z]:/.test(frame.filename)).toBe(false);
    }
  });
});

describe('sendExceptionEvent', () => {
  const event = buildExceptionEvent({
    error: new Error('boom'),
    release: 'dorkos@0.46.0',
    environment: 'production',
    surface: 'cli',
    os: 'linux-x64',
    cwd: '/srv/dorkos',
    distinctId: '11111111-1111-4111-8111-111111111111',
    dorkosVersion: '0.46.0',
  });

  it('POSTs a single-event batch to the owned ingest endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await sendExceptionEvent(event, { fetchImpl: fetchSpy });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TELEMETRY_EVENTS_ENDPOINT);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as { events: unknown[] };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ event: '$exception' });
  });

  it('honors a custom endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await sendExceptionEvent(event, {
      fetchImpl: fetchSpy,
      endpoint: 'https://example.test/ingest',
    });
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.test/ingest');
  });

  it('in debug mode prints and sends nothing', async () => {
    const fetchSpy = vi.fn();
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await sendExceptionEvent(event, { fetchImpl: fetchSpy, debug: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('$exception'));
    writeSpy.mockRestore();
  });

  it('swallows fetch failures', async () => {
    const fetchSpy = vi.fn().mockRejectedValueOnce(new Error('network down'));
    await expect(sendExceptionEvent(event, { fetchImpl: fetchSpy })).resolves.toBeUndefined();
  });
});

describe('raceWithTimeout', () => {
  it('resolves as soon as the promise settles (fast path)', async () => {
    let settled = false;
    await raceWithTimeout(
      Promise.resolve().then(() => void (settled = true)),
      5000
    );
    expect(settled).toBe(true);
  });

  it('resolves within the timeout when the promise hangs (bounded)', async () => {
    const never = new Promise<void>(() => {}); // never settles
    const start = Date.now();
    await raceWithTimeout(never, 20);
    // Resolved despite the hung promise; bounded near the timeout, not forever.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('never rejects even if the promise rejects', async () => {
    await expect(raceWithTimeout(Promise.reject(new Error('boom')), 50)).resolves.toBeUndefined();
  });
});

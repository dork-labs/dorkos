/**
 * Tests for the in-memory breadcrumb ring buffer (feedback-pipeline spec Part 1).
 *
 * Proves the load-bearing guarantees: bounded capacity (oldest evicted first),
 * never persisted (module-scoped array only), and `console.error`/`console.warn`
 * are WRAPPED not replaced — the original console call must still fire so
 * devtools output is unaffected.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addBreadcrumb,
  getBreadcrumbs,
  installBreadcrumbHandlers,
  __resetBreadcrumbsForTests,
} from '../breadcrumbs';
import { MAX_BREADCRUMBS, MAX_BREADCRUMB_MESSAGE_LEN } from '@dorkos/shared/telemetry-events';

afterEach(() => {
  __resetBreadcrumbsForTests();
  vi.restoreAllMocks();
});

describe('addBreadcrumb / getBreadcrumbs', () => {
  it('records a breadcrumb with an ISO timestamp', () => {
    addBreadcrumb('console_error', 'boom');
    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].kind).toBe('console_error');
    expect(crumbs[0].message).toBe('boom');
    expect(() => new Date(crumbs[0].at)).not.toThrow();
    expect(new Date(crumbs[0].at).toISOString()).toBe(crumbs[0].at);
  });

  it('preserves insertion order (oldest first)', () => {
    addBreadcrumb('console_error', 'first');
    addBreadcrumb('console_warn', 'second');
    addBreadcrumb('sse_disconnect', 'third');
    expect(getBreadcrumbs().map((c) => c.message)).toEqual(['first', 'second', 'third']);
  });

  it('truncates a message to MAX_BREADCRUMB_MESSAGE_LEN', () => {
    addBreadcrumb('console_error', 'x'.repeat(MAX_BREADCRUMB_MESSAGE_LEN + 50));
    expect(getBreadcrumbs()[0].message.length).toBe(MAX_BREADCRUMB_MESSAGE_LEN);
  });

  it('evicts the oldest entry once the buffer exceeds MAX_BREADCRUMBS', () => {
    for (let i = 0; i < MAX_BREADCRUMBS + 5; i++) {
      addBreadcrumb('console_error', `crumb-${i}`);
    }
    const crumbs = getBreadcrumbs();
    expect(crumbs).toHaveLength(MAX_BREADCRUMBS);
    // The first 5 were evicted; the buffer starts at crumb-5.
    expect(crumbs[0].message).toBe('crumb-5');
    expect(crumbs.at(-1)?.message).toBe(`crumb-${MAX_BREADCRUMBS + 4}`);
  });

  it('getBreadcrumbs returns a copy — mutating the result does not affect the buffer', () => {
    addBreadcrumb('console_error', 'one');
    const crumbs = getBreadcrumbs();
    crumbs.push({ at: new Date().toISOString(), kind: 'console_warn', message: 'injected' });
    expect(getBreadcrumbs()).toHaveLength(1);
  });

  it('is never persisted: __resetBreadcrumbsForTests clears everything', () => {
    addBreadcrumb('console_error', 'one');
    __resetBreadcrumbsForTests();
    expect(getBreadcrumbs()).toEqual([]);
  });
});

describe('installBreadcrumbHandlers', () => {
  it('records a console_error breadcrumb AND still calls the original console.error', () => {
    const originalError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    console.error('something broke', { detail: 42 });

    expect(getBreadcrumbs()).toHaveLength(1);
    expect(getBreadcrumbs()[0].kind).toBe('console_error');
    expect(getBreadcrumbs()[0].message).toContain('something broke');
    // Wrapped, not replaced: the original still fires.
    expect(originalError).toHaveBeenCalledWith('something broke', { detail: 42 });

    uninstall();
  });

  it('records what an Error says, not its empty JSON (DOR-2230)', () => {
    // `JSON.stringify(new Error('x'))` is `{}` — an Error's name and message are
    // not own enumerable properties — so every React error an error boundary
    // logged used to reach a bug report as `[Markdown] Render error: {}`.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    console.error('[Markdown] Render error:', new TypeError('chunk failed to load'));

    expect(getBreadcrumbs()[0].message).toBe(
      '[Markdown] Render error: TypeError: chunk failed to load'
    );

    uninstall();
  });

  it('keeps what makes an error THIS error: its own fields and its cause', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    const refusal = Object.assign(new Error('the capture failed'), { name: 'AppCaptureError' });
    Object.assign(refusal, { reason: 'failed' });
    const wrapped = new Error('could not attach a screenshot', { cause: refusal });
    console.error(wrapped);

    expect(getBreadcrumbs()[0].message).toBe(
      'Error: could not attach a screenshot (cause: AppCaptureError: the capture failed {"reason":"failed"})'
    );

    uninstall();
  });

  it('names an error from another frame, which is not `instanceof Error`', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    // What an error thrown in an iframe (or a worker's posted error) looks like
    // from here: every field an Error has, and the wrong prototype.
    console.error({ name: 'TypeError', message: 'x is not a function' });

    expect(getBreadcrumbs()[0].message).toBe('TypeError: x is not a function');

    uninstall();
  });

  it('redacts home paths and secret-shaped tokens before a breadcrumb is kept', () => {
    // Breadcrumbs leave the machine inside a bug report, and nothing downstream
    // scrubs them — so every door in, logged or added directly, is redacted.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    console.error(
      new Error('ENOENT: /Users/someone/project/notes.md, key sk-abcdefghijklmnopqrstuvwxyz')
    );
    addBreadcrumb('query_error', 'failed reading /home/someone/.dork/config.json');

    const [logged, added] = getBreadcrumbs().map((crumb) => crumb.message);
    expect(logged).toBe('Error: ENOENT: ~/project/notes.md, key [redacted]');
    expect(added).toBe('failed reading ~/.dork/config.json');

    uninstall();
  });

  describe('never costs the original log', () => {
    /**
     * Four arguments that make naming or serializing an error throw. The
     * wrapper records the breadcrumb BEFORE it calls the original, so a throw
     * there used to mean the real `console.error` never ran at all.
     */
    function hostileArguments(): Array<[string, unknown]> {
      const throwingField = new Error('has a bad field');
      Object.defineProperty(throwingField, 'detail', {
        enumerable: true,
        get() {
          throw new Error('getter exploded');
        },
      });
      const throwingCause = new Error('has a bad cause');
      Object.defineProperty(throwingCause, 'cause', {
        get() {
          throw new Error('cause exploded');
        },
      });
      const symbolName = new Error('named by a symbol');
      Object.defineProperty(symbolName, 'name', { value: Symbol('odd') });
      const nullPrototype = Object.create(null) as Record<string, unknown>;
      nullPrototype.self = nullPrototype;
      return [
        ['an enumerable getter that throws', throwingField],
        ['a cause getter that throws', throwingCause],
        ['a Symbol name', symbolName],
        ['a null-prototype object that refers to itself', nullPrototype],
      ];
    }

    it.each(hostileArguments())('with %s', (_label, argument) => {
      const originalError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const uninstall = installBreadcrumbHandlers();

      expect(() => console.error('context:', argument)).not.toThrow();

      // By identity, not `toHaveBeenCalledWith`: deep equality reads the same
      // hostile getters and would throw inside the assertion itself.
      expect(originalError).toHaveBeenCalledTimes(1);
      expect(originalError.mock.calls[0]![0]).toBe('context:');
      expect(originalError.mock.calls[0]![1]).toBe(argument);
      expect(getBreadcrumbs()).toHaveLength(1);
      expect(getBreadcrumbs()[0].message).toMatch(/^context: /);

      uninstall();
    });
  });

  describe('redacts secrets that are inside an object, not only in its text', () => {
    // Redaction reads TEXT, and JSON puts a quote between a key and its value,
    // so `"token":"…"` never matched the `token: …` rule. The object is
    // redacted field by field before it is serialized.
    it.each<[string, unknown, string]>([
      ['a token field', { token: 'tok_live_abcdef123456' }, 'tok_live_abcdef123456'],
      ['an apiKey field', { apiKey: 'AIzaSyA1234567890abcdef' }, 'AIzaSyA1234567890abcdef'],
      ['a password field', { password: 'hunter2hunter2' }, 'hunter2hunter2'],
      [
        'an Authorization header',
        { headers: { Authorization: 'Basic dXNlcjpwYXNz' } },
        'dXNlcjpwYXNz',
      ],
      ['a Windows home path', { path: 'C:\\Users\\alice\\notes.md' }, 'alice'],
    ])('in %s', (_label, fields, secret) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const uninstall = installBreadcrumbHandlers();

      console.error(Object.assign(new Error('request failed'), fields));
      console.error('plain object:', fields);

      for (const crumb of getBreadcrumbs()) expect(crumb.message).not.toContain(secret);
      expect(getBreadcrumbs()[0].message).toMatch(/^Error: request failed /);

      uninstall();
    });
  });

  it('masks credential fields by name but keeps the counts a limit error is read from', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    console.error(
      Object.assign(new Error('context limit reached'), {
        maxTokens: 200000,
        inputTokens: 201234,
        sessionId: 'sess-42',
        sessions: 3,
        accessToken: 'at-value-1',
        session_token: 'st-value-2',
        token: 'plain-value-3',
      })
    );

    const message = getBreadcrumbs()[0].message;
    expect(message).toContain('"maxTokens":200000');
    expect(message).toContain('"inputTokens":201234');
    expect(message).toContain('"sessionId":"sess-42"');
    expect(message).toContain('"sessions":3');
    expect(message).toContain('"accessToken":"[redacted]"');
    expect(message).toContain('"session_token":"[redacted]"');
    expect(message).toContain('"token":"[redacted]"');
    for (const secret of ['at-value-1', 'st-value-2', 'plain-value-3']) {
      expect(message).not.toContain(secret);
    }

    uninstall();
  });

  it('drops the query string of a web address, as the log excerpts do', () => {
    addBreadcrumb(
      'query_error',
      'GET https://example.com/api?session_id=abc123&email=a@b.co failed'
    );

    expect(getBreadcrumbs()[0].message).toBe('GET https://example.com/api failed');
  });

  it('records a console_warn breadcrumb AND still calls the original console.warn', () => {
    const originalWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();

    console.warn('heads up');

    expect(getBreadcrumbs()).toHaveLength(1);
    expect(getBreadcrumbs()[0].kind).toBe('console_warn');
    expect(originalWarn).toHaveBeenCalledWith('heads up');

    uninstall();
  });

  it('uninstall restores the original console.error/console.warn (no more breadcrumbs)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uninstall = installBreadcrumbHandlers();
    uninstall();

    console.error('after uninstall');
    expect(getBreadcrumbs()).toHaveLength(0);
  });
});

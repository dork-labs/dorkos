import { describe, expect, it } from 'vitest';
import type { CaptureResult } from 'posthog-js';

import { errorSignature, scrubExceptionEvent } from '../error-signature';

/** An error with a fixed stack, so the test never depends on the runner's frames. */
function errorWith(name: string, message: string, stack: string | undefined): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
}

const SECRET = 'my search for acme invoices';

describe('errorSignature', () => {
  it('keeps the error type and the first V8 frame, never the message', () => {
    const error = errorWith(
      'TypeError',
      SECRET,
      `TypeError: ${SECRET}\n    at renderGrid (https://dorkos.ai/_next/static/chunks/app.js:1:234)\n    at next (https://dorkos.ai/_next/static/chunks/main.js:5:6)`
    );

    expect(errorSignature(error)).toBe(
      'TypeError at renderGrid (https://dorkos.ai/_next/static/chunks/app.js:1:234)'
    );
  });

  it('skips a message that spans several lines before the first frame', () => {
    const error = errorWith(
      'Error',
      `line one\n${SECRET}`,
      `Error: line one\n${SECRET}\n    at load (https://dorkos.ai/a.js:2:3)`
    );

    expect(errorSignature(error)).toBe('Error at load (https://dorkos.ai/a.js:2:3)');
  });

  it('reads a Firefox or Safari frame, which has no message line', () => {
    const error = errorWith('RangeError', SECRET, 'paint@https://dorkos.ai/b.js:7:8\nrun@x.js:1:1');

    expect(errorSignature(error)).toBe('RangeError paint@https://dorkos.ai/b.js:7:8');
  });

  it('drops a query string or hash from the frame URL', () => {
    const error = errorWith(
      'Error',
      'boom',
      'Error: boom\n    at f (https://dorkos.ai/marketplace?q=acme%20invoices#top:3:4)'
    );

    expect(errorSignature(error)).toBe('Error at f (https://dorkos.ai/marketplace:3:4)');
  });

  it('leaves the frame whole when the message is a single letter', () => {
    const error = errorWith('Error', 'a', 'Error: a\n    at load (https://dorkos.ai/a.js:2:3)');

    expect(errorSignature(error)).toBe('Error at load (https://dorkos.ai/a.js:2:3)');
  });

  it('falls back to the type alone when there is no stack', () => {
    expect(errorSignature(errorWith('SyntaxError', SECRET, undefined))).toBe('SyntaxError');
  });

  it('never contains the message text', () => {
    const error = errorWith(
      'Error',
      SECRET,
      `Error: ${SECRET}\n    at ${SECRET} (https://dorkos.ai/c.js:1:1)`
    );

    expect(errorSignature(error)).not.toContain(SECRET);
  });
});

describe('scrubExceptionEvent', () => {
  function exceptionEvent(properties: Record<string, unknown>): CaptureResult {
    return { uuid: 'u-1', event: '$exception', properties } as CaptureResult;
  }

  it('empties every exception value and drops message-bearing fields', () => {
    const frames = [{ filename: 'https://dorkos.ai/a.js', function: 'f', lineno: 1, colno: 2 }];
    const scrubbed = scrubExceptionEvent(
      exceptionEvent({
        $exception_list: [
          {
            type: 'TypeError',
            value: SECRET,
            mechanism: { handled: false },
            stacktrace: { frames },
          },
          { type: 'Error', value: 'cause text' },
        ],
        $exception_level: 'error',
        $exception_message: SECRET,
        $exception_values: [SECRET],
        $exception_steps: [{ message: SECRET }],
      })
    );

    expect(JSON.stringify(scrubbed)).not.toContain(SECRET);
    expect(JSON.stringify(scrubbed)).not.toContain('cause text');
    expect(scrubbed?.properties).toEqual({
      $exception_list: [
        { type: 'TypeError', value: '', mechanism: { handled: false }, stacktrace: { frames } },
        { type: 'Error', value: '' },
      ],
      $exception_level: 'error',
    });
  });

  it('leaves every other event untouched', () => {
    const pageview = { uuid: 'u-2', event: '$pageview', properties: { a: 1 } } as CaptureResult;

    expect(scrubExceptionEvent(pageview)).toBe(pageview);
    expect(scrubExceptionEvent(null)).toBeNull();
  });
});

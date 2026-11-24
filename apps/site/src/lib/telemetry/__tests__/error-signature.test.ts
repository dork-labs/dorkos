import { describe, expect, it } from 'vitest';

import { errorSignature } from '../error-signature';

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

  it('treats everything before the first indented frame as message, even after the message changed', () => {
    const error = errorWith(
      'Error',
      'changed later',
      'Error: was\nat checkout said acme\n    at g (https://dorkos.ai/g.js:4:5)'
    );

    const signature = errorSignature(error);
    expect(signature).toBe('Error at g (https://dorkos.ai/g.js:4:5)');
    expect(signature).not.toContain('checkout said acme');
  });

  it('does not take a message line that only contains an @ for a Firefox frame', () => {
    const error = errorWith(
      'Error',
      'x',
      'mail me@acme invoices:1:2\nrun@https://dorkos.ai/r.js:3:4'
    );

    expect(errorSignature(error)).toBe('Error run@https://dorkos.ai/r.js:3:4');
  });

  it('strips every query string in an eval frame', () => {
    const error = errorWith(
      'Error',
      'boom',
      'Error: boom\n    at eval (eval at f (https://dorkos.ai/p?q=acme:1:2), <anonymous>:3:4)'
    );

    expect(errorSignature(error)).toBe(
      'Error at eval (eval at f (https://dorkos.ai/p:1:2), <anonymous>:3:4)'
    );
  });

  it.each([['acme invoices'], ['Bad-Name'], ['']])('reports a name like %j as Error', (name) => {
    const error = errorWith(name, 'boom', undefined);

    expect(errorSignature(error)).toBe('Error');
  });
});

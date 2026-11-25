import { describe, expect, it } from 'vitest';
import { readResponseError, responseError } from '../response-error';

const json = (body: unknown, status: number, statusText = '') =>
  new Response(JSON.stringify(body), { status, statusText });

describe('responseError', () => {
  it('reads a problem document: detail, code, status, issues', async () => {
    const issues = { formErrors: [], fieldErrors: { cwd: ['Required'] } };
    const error = await responseError(
      json(
        {
          type: 'urn:dorkos:problem:malformed_request',
          title: 'The request could not be read.',
          status: 400,
          code: 'malformed_request',
          detail: 'Send the folder as cwd.',
          issues,
        },
        400
      )
    );
    expect(error.message).toBe('Send the folder as cwd.');
    expect(error.code).toBe('malformed_request');
    expect(error.status).toBe(400);
    expect(error.issues).toEqual(issues);
  });

  it('reads a problem with no detail by its title, and its retry delay', async () => {
    const error = await responseError(
      json(
        { title: 'Too many requests.', status: 429, code: 'rate_limited', retryAfterMs: 2000 },
        429
      )
    );
    expect(error.message).toBe('Too many requests.');
    expect(error.retryAfterMs).toBe(2000);
  });

  it('reads the login gate, which is not a problem on purpose, keeping the body', async () => {
    const body = { error: 'Unauthorized', code: 'AUTH_REQUIRED', signInWith: 'wifi-code' };
    const error = await responseError(json(body, 401));
    expect(error.message).toBe('Unauthorized');
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.body).toEqual(body);
  });

  it('reads nothing from the old `{ error, code }` shape but the body', async () => {
    const body = { error: 'Already bound', code: 'CHAT_ALREADY_BOUND', bindingId: 'b1' };
    const error = await responseError(json(body, 409, 'Conflict'));
    expect(error.message).toBe('Conflict');
    expect(error.code).toBeUndefined();
    expect(error.body).toEqual(body);
  });

  it('falls back to the given message, then the status text, then the status', async () => {
    const notJson = () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' });
    expect((await readResponseError(notJson(), 'Couldn’t save.')).message).toBe('Couldn’t save.');
    expect((await readResponseError(notJson())).message).toBe('Bad Gateway');
    expect((await readResponseError(new Response('', { status: 500 }))).message).toBe('HTTP 500');
  });
});

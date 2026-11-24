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

  it('reads the old `{ error, code }` shape, keeping the body', async () => {
    const body = { error: 'Already bound', code: 'CHAT_ALREADY_BOUND', bindingId: 'b1' };
    const error = await responseError(json(body, 409));
    expect(error.message).toBe('Already bound');
    expect(error.code).toBe('CHAT_ALREADY_BOUND');
    expect(error.body).toEqual(body);
  });

  it('falls back to the given message, then the status text, then the status', async () => {
    const notJson = () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' });
    expect((await readResponseError(notJson(), 'Couldn’t save.')).message).toBe('Couldn’t save.');
    expect((await readResponseError(notJson())).message).toBe('Bad Gateway');
    expect((await readResponseError(new Response('', { status: 500 }))).message).toBe('HTTP 500');
  });

  it('reads an older body’s per-refusal `message` first when asked', async () => {
    const body = { error: 'Only a person can change this', message: 'Ask a person.' };
    expect((await readResponseError(json(body, 403))).message).toBe(
      'Only a person can change this'
    );
    expect(
      (await readResponseError(json(body, 403), undefined, { oldMessageFirst: true })).message
    ).toBe('Ask a person.');
  });
});

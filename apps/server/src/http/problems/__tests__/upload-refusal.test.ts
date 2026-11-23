import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { problemBody } from '@dorkos/http-kit';
import { UploadLimitError } from '../../uploads.js';
import { uploadRefusalProblem } from '../upload-refusal.js';

/** Answer one request with the refusal for `err`, and read what went out. */
async function answer(err: unknown, tooLargeDetail?: string) {
  const app = new Hono();
  app.post('/', (c) => uploadRefusalProblem(c, err, { tooLargeDetail }));
  const res = await app.request('/', { method: 'POST' });
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
}

describe('uploadRefusalProblem', () => {
  it('answers a file over the limit 413 request_too_large, in the route’s words', async () => {
    const res = await answer(new UploadLimitError('LIMIT_FILE_SIZE'), 'File too large (max 5MB)');
    expect(res.status).toBe(413);
    expect(res.type).toBe('application/problem+json');
    expect(res.body).toEqual(
      problemBody('request_too_large', { detail: 'File too large (max 5MB)' })
    );
  });

  it('answers any other limit 400 malformed_request with the parser’s words', async () => {
    const res = await answer(new UploadLimitError('LIMIT_FILE_COUNT'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual(problemBody('malformed_request', { detail: 'Too many files' }));
  });

  it('answers a body the parser could not read 400 malformed_request', async () => {
    const res = await answer(new Error('Unexpected end of form'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      problemBody('malformed_request', { detail: 'Unexpected end of form' })
    );
  });
});

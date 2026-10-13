import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AmbiguousSessionError } from '../../services/session/resolution/session-lookup-error.js';
import { errorReply, logRequestError } from '../error-handler.js';

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

describe('errorReply and logRequestError', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure non-production so error messages are revealed (not masked)
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns a clear conflict for ambiguous native session identities', () => {
    const reply = errorReply(new AmbiguousSessionError());
    expect(reply.status).toBe(409);
    expect(reply.body).toEqual({
      error: 'This chat ID matches multiple chats.',
      code: 'SESSION_ID_AMBIGUOUS',
    });
  });

  it('logs the method, path, code, and status beside the message', async () => {
    const { logger } = await import('../../lib/logger.js');
    const error = Object.assign(new Error('Refused'), { code: 'cloud_refused', status: 502 });
    logRequestError(error, 'GET', '/api/connectors/x');
    expect(logger.error).toHaveBeenCalledWith(
      '[DorkOS Error]',
      'Refused',
      expect.objectContaining({
        method: 'GET',
        path: '/api/connectors/x',
        code: 'cloud_refused',
        status: 502,
      })
    );
  });

  it('returns 500 with error message', () => {
    const error = new Error('Something broke');

    const reply = errorReply(error);

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual({
      error: 'Something broke',
      code: 'INTERNAL_ERROR',
    });
  });

  it('falls back to Internal Server Error for empty message', () => {
    const error = new Error('');

    const reply = errorReply(error);

    expect(reply.body).toEqual({
      error: 'Internal Server Error',
      code: 'INTERNAL_ERROR',
    });
  });

  it('answers a body that never fit with 413 and a code, not 500', () => {
    // The body parser's own limit raises this, and it used to be flattened into
    // "Internal server error" with `code: INTERNAL_ERROR` — so a person saving
    // a large file in a room was told the server broke, and given nothing they
    // could act on (DOR-1600's review).
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      expose: true,
    });

    const reply = errorReply(tooLarge);

    expect(reply.status).toBe(413);
    expect(reply.body).toEqual({
      error: 'That is too large to send in one request.',
      code: 'REQUEST_TOO_LARGE',
    });
  });

  it('leaves every other body-parser failure the 500 it has always had', () => {
    // Deliberately narrow: widening this to "any 4xx that says expose" would
    // quietly restate every route's answer to a malformed body, which is a
    // change nobody has argued for here.
    const malformed = Object.assign(new Error('Unexpected token } in JSON'), {
      type: 'entity.parse.failed',
      status: 400,
      expose: true,
    });

    const reply = errorReply(malformed);

    expect(reply.status).toBe(500);
  });

  it('logs the error via logger', async () => {
    const { logger } = await import('../../lib/logger.js');
    const error = new Error('Log me');

    logRequestError(error, 'GET', '/api/x');

    expect(logger.error).toHaveBeenCalledWith(
      '[DorkOS Error]',
      'Log me',
      expect.objectContaining({ stack: expect.any(String) })
    );
  });
});

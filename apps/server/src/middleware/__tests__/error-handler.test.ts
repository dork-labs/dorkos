import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AmbiguousSessionError } from '../../services/session/resolution/session-lookup-error.js';
import { corsRefusal } from '../../http/cors-policy.js';
import { problemBody } from '@dorkos/http-kit';
import { BoundaryError } from '../../lib/boundary.js';
import { RuntimeNotRegisteredError } from '../../services/core/runtime-registry.js';
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
    expect(reply.body).toEqual(
      problemBody('conflict', { detail: 'This chat ID matches multiple chats.' })
    );
  });

  it('reports a video link as its route, never its ticket (DOR-4321)', async () => {
    const { logger } = await import('../../lib/logger.js');
    const ticket = 'Ab0_-'.repeat(8) + 'xyz';
    logRequestError(new Error('boom'), 'GET', `/api/extensions/media/${ticket}`);
    logRequestError(
      corsRefusal('https://elsewhere.example'),
      'GET',
      `/api/extensions/media/${ticket}`
    );
    const logged = JSON.stringify([
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
    ]);
    expect(logged).toContain('/api/extensions/media/[ticket]');
    expect(logged).not.toContain(ticket);
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

  it('answers a refused browser origin 403 with its code, and warns rather than errors', async () => {
    const { logger } = await import('../../lib/logger.js');
    const error = corsRefusal('http://127.0.0.1:5173');
    expect(errorReply(error)).toEqual({
      status: 403,
      body: problemBody('origin_not_allowed', {
        detail:
          'This instance does not answer to pages from "http://127.0.0.1:5173". If that is how you reach DorkOS, list it in DORKOS_CORS_ORIGIN, or open DorkOS at its own address.',
      }),
    });
    logRequestError(error, 'POST', '/api/canvas/docs/d1/events');
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('[CORS] refused origin', {
      origin: 'http://127.0.0.1:5173',
      method: 'POST',
      path: '/api/canvas/docs/d1/events',
    });
  });

  it('returns 500 with error message', () => {
    const error = new Error('Something broke');

    const reply = errorReply(error);

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual(problemBody('internal_error', { detail: 'Something broke' }));
  });

  it('says only the title for an empty message', () => {
    const error = new Error('');

    const reply = errorReply(error);

    expect(reply.body).toEqual(problemBody('internal_error'));
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
    expect(reply.body).toEqual(
      problemBody('request_too_large', {
        detail: 'That is too large to send in one request.',
      })
    );
  });

  it('answers a body that is not valid JSON 400, not 500', () => {
    const malformed = Object.assign(new Error('Unexpected token } in JSON'), {
      type: 'entity.parse.failed',
      status: 400,
      expose: true,
    });

    const reply = errorReply(malformed);

    expect(reply.status).toBe(400);
    expect(reply.body).toEqual(
      problemBody('malformed_request', { detail: 'The request body is not valid JSON.' })
    );
  });

  it('answers a body in an encoding or charset it cannot read 415', () => {
    for (const type of ['encoding.unsupported', 'charset.unsupported']) {
      const unreadable = Object.assign(new Error('unsupported'), { type, status: 415 });
      const reply = errorReply(unreadable);
      expect(reply.status).toBe(415);
      expect(reply.body.code).toBe('unsupported_media_type');
    }
  });

  it('answers a body cut off or mis-sized 400', () => {
    for (const type of ['request.aborted', 'request.size.invalid']) {
      const broken = Object.assign(new Error('aborted'), { type, status: 400 });
      const reply = errorReply(broken);
      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('malformed_request');
    }
  });

  it('answers a path outside the boundary 403 outside_boundary, other boundary refusals 403 forbidden', () => {
    const outside = errorReply(new BoundaryError('Access denied', 'OUTSIDE_BOUNDARY'));
    expect(outside).toEqual({
      status: 403,
      body: problemBody('outside_boundary', {
        detail: 'This chat is outside the allowed directory.',
      }),
    });
    const nul = errorReply(new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE'));
    expect(nul.status).toBe(400);
    expect(nul.body.code).toBe('invalid_request');
    const denied = errorReply(new BoundaryError('Permission denied', 'PERMISSION_DENIED'));
    expect(denied).toEqual({
      status: 403,
      body: problemBody('forbidden', { detail: 'Permission denied' }),
    });
  });

  it('answers a chat on a program that is not running 503 runtime_not_available', () => {
    const reply = errorReply(new RuntimeNotRegisteredError('opencode', 's1'));
    expect(reply.status).toBe(503);
    expect(reply.body.code).toBe('runtime_not_available');
    expect(reply.body.detail).toContain("which isn't running on this machine");
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

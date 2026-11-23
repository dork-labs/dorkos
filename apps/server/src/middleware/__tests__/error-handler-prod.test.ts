import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { problemBody } from '@dorkos/http-kit';
import { errorReply } from '../error-handler.js';

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

describe('errorReply production mode', () => {
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('does not leak err.message in production mode', () => {
    process.env.NODE_ENV = 'production';
    const error = new Error('Sensitive database connection string');

    const reply = errorReply(error);

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual(
      problemBody('internal_error', { detail: 'DorkOS hit an error. It’s in the server log.' })
    );
  });

  it('keeps err.message off the wire in development mode too', () => {
    process.env.NODE_ENV = 'development';
    const error = new Error('Something broke');

    const reply = errorReply(error);

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual(
      problemBody('internal_error', { detail: 'DorkOS hit an error. It’s in the server log.' })
    );
  });

  it('keeps err.message off the wire when NODE_ENV is undefined', () => {
    delete process.env.NODE_ENV;
    const error = new Error('Debug info visible');

    const reply = errorReply(error);

    expect(reply.status).toBe(500);
    expect(reply.body).toEqual(
      problemBody('internal_error', { detail: 'DorkOS hit an error. It’s in the server log.' })
    );
  });

  it('returns generic message in production even with detailed error', () => {
    process.env.NODE_ENV = 'production';
    const error = new Error('ECONNREFUSED 127.0.0.1:5432 - password authentication failed');

    const reply = errorReply(error);

    expect(reply.body).toEqual(
      problemBody('internal_error', { detail: 'DorkOS hit an error. It’s in the server log.' })
    );
  });
});

import { describe, it, expect } from 'vitest';

import { classifyTransportError } from '../use-chat-session';
import { TIMING } from '@/layers/shared/lib';

describe('classifyTransportError', () => {
  it('classifies SESSION_LOCKED as "Session in use", not retryable, with autoDismissMs', () => {
    const err = Object.assign(new Error('locked'), { code: 'SESSION_LOCKED' });
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Session in use');
    expect(result.message).toBe('Another client is sending a message. Try again in a few seconds.');
    expect(result.retryable).toBe(false);
    expect(result.autoDismissMs).toBe(TIMING.SESSION_BUSY_CLEAR_MS);
  });

  it('classifies TypeError as "Server link failed", retryable', () => {
    const err = new TypeError('Failed to fetch');
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Server link failed');
    expect(result.retryable).toBe(true);
  });

  it('classifies error with "network" in message as "Server link failed", retryable', () => {
    const err = new Error('network error occurred');
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Server link failed');
    expect(result.retryable).toBe(true);
  });

  it('classifies error with "fetch" in message as "Server link failed", retryable', () => {
    const err = new Error('fetch failed');
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Server link failed');
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 500 as "Server error", retryable', () => {
    const err = Object.assign(new Error('Internal Server Error'), { status: 500 });
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Server error');
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 502 as "Server error", retryable', () => {
    const err = Object.assign(new Error('Bad Gateway'), { status: 502 });
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Server error');
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 503 as "Server error", retryable', () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Server error');
    expect(result.retryable).toBe(true);
  });

  it('classifies HTTP 408 as "Request timed out", retryable', () => {
    const err = Object.assign(new Error('Request Timeout'), { status: 408 });
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Request timed out');
    expect(result.retryable).toBe(true);
  });

  it('classifies error with "timeout" in message as "Request timed out", retryable', () => {
    const err = new Error('connection timeout');
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Request timed out');
    expect(result.retryable).toBe(true);
  });

  it('classifies unknown error as "Error", not retryable, preserves raw message', () => {
    const err = new Error('something unexpected happened');
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Error');
    expect(result.message).toBe('something unexpected happened');
    expect(result.retryable).toBe(false);
  });

  it('handles non-Error thrown value (string)', () => {
    const result = classifyTransportError('some string error');

    expect(result.heading).toBe('Error');
    expect(result.retryable).toBe(false);
  });

  it('handles null thrown value', () => {
    const result = classifyTransportError(null);

    expect(result.heading).toBe('Error');
    expect(result.retryable).toBe(false);
  });

  it('gives SESSION_LOCKED priority over message content containing "network"', () => {
    const err = Object.assign(new Error('network error'), { code: 'SESSION_LOCKED' });
    const result = classifyTransportError(err);

    expect(result.heading).toBe('Session in use');
    expect(result.retryable).toBe(false);
    expect(result.autoDismissMs).toBe(TIMING.SESSION_BUSY_CLEAR_MS);
  });
});

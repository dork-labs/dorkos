import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage } from '../lib/tunnel-failure';

describe('friendlyErrorMessage', () => {
  it('maps auth/token errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_105 bad auth')).toBe(
      'Check your auth token at dashboard.ngrok.com'
    );
    expect(friendlyErrorMessage('invalid token')).toBe(
      'Check your auth token at dashboard.ngrok.com'
    );
  });

  it('maps timeout errors without blaming the network', () => {
    expect(friendlyErrorMessage('connection ETIMEDOUT')).toBe(
      'The tunnel took too long to respond. Try again.'
    );
    expect(friendlyErrorMessage('timeout after 30s')).toBe(
      'The tunnel took too long to respond. Try again.'
    );
    // The transport's own wording, which is what a surface actually sees when a
    // start runs out of time. It says "timed out" — two words — so the original
    // `/timeout/i` pattern missed the one message these panels render most.
    expect(friendlyErrorMessage('Request timed out after 30s — check your network')).toBe(
      'The tunnel took too long to respond. Try again.'
    );
  });

  it('maps tunnel limit errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_108 limit reached')).toBe(
      'Tunnel limit reached. Free ngrok accounts allow one active tunnel.'
    );
    expect(friendlyErrorMessage('tunnel limit exceeded')).toBe(
      'Tunnel limit reached. Free ngrok accounts allow one active tunnel.'
    );
  });

  it('maps DNS errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_332 DNS failed')).toBe(
      'DNS resolution failed. Check your domain configuration.'
    );
    expect(friendlyErrorMessage('NXDOMAIN error')).toBe(
      'DNS resolution failed. Check your domain configuration.'
    );
  });

  it('maps gateway errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_3200 gateway')).toBe(
      'Gateway error. The tunnel endpoint is unreachable.'
    );
    expect(friendlyErrorMessage('502 bad gateway')).toBe(
      'Gateway error. The tunnel endpoint is unreachable.'
    );
  });

  it('maps upgrade/plan errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_120 upgrade required')).toBe(
      'Feature requires a paid ngrok plan.'
    );
    expect(friendlyErrorMessage('upgrade your plan')).toBe('Feature requires a paid ngrok plan.');
  });

  it('maps ECONNREFUSED errors', () => {
    expect(friendlyErrorMessage('ECONNREFUSED 127.0.0.1:4242')).toBe(
      "Couldn't reach your DorkOS server. Make sure it's running."
    );
  });

  it('returns the raw message for unknown errors', () => {
    expect(friendlyErrorMessage('some unknown error')).toBe('some unknown error');
    expect(friendlyErrorMessage('')).toBe('');
  });
});

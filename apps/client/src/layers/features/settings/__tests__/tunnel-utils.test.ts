import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage, latencyColor } from '../lib/tunnel-utils';

describe('friendlyErrorMessage', () => {
  it('maps auth/token errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_105 bad auth')).toBe(
      'Check your auth token at dashboard.ngrok.com'
    );
    expect(friendlyErrorMessage('invalid token')).toBe(
      'Check your auth token at dashboard.ngrok.com'
    );
  });

  it('maps timeout errors', () => {
    expect(friendlyErrorMessage('connection ETIMEDOUT')).toBe(
      'Connection timed out. Check your network.'
    );
    expect(friendlyErrorMessage('timeout after 30s')).toBe(
      'Connection timed out. Check your network.'
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
      'Connection refused. Ensure the server is running.'
    );
  });

  it('returns the raw message for unknown errors', () => {
    expect(friendlyErrorMessage('some unknown error')).toBe('some unknown error');
    expect(friendlyErrorMessage('')).toBe('');
  });
});

describe('latencyColor', () => {
  it('returns gray for null latency', () => {
    expect(latencyColor(null)).toBe('bg-gray-400');
  });

  it('returns green for latency under 200ms', () => {
    expect(latencyColor(0)).toBe('bg-green-500');
    expect(latencyColor(100)).toBe('bg-green-500');
    expect(latencyColor(199)).toBe('bg-green-500');
  });

  it('returns amber for latency between 200ms and 499ms', () => {
    expect(latencyColor(200)).toBe('bg-amber-400');
    expect(latencyColor(350)).toBe('bg-amber-400');
    expect(latencyColor(499)).toBe('bg-amber-400');
  });

  it('returns red for latency at or above 500ms', () => {
    expect(latencyColor(500)).toBe('bg-red-500');
    expect(latencyColor(1000)).toBe('bg-red-500');
  });
});

import { describe, it, expect } from 'vitest';
import { friendlyErrorMessage } from '../lib/tunnel-failure';

describe('friendlyErrorMessage', () => {
  it('maps auth/token errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_105 bad auth')).toBe(
      'Couldn’t sign in to ngrok. Check your token at dashboard.ngrok.com.'
    );
    expect(friendlyErrorMessage('invalid token')).toBe(
      'Couldn’t sign in to ngrok. Check your token at dashboard.ngrok.com.'
    );
  });

  it('maps timeout errors without blaming the network', () => {
    expect(friendlyErrorMessage('connection ETIMEDOUT')).toBe(
      'Remote access took too long to start. Try again.'
    );
    expect(friendlyErrorMessage('timeout after 30s')).toBe(
      'Remote access took too long to start. Try again.'
    );
    // The transport's own wording, which is what a surface actually sees when a
    // start runs out of time. It says "timed out" — two words — so the original
    // `/timeout/i` pattern missed the one message these panels render most.
    expect(friendlyErrorMessage('Request timed out after 30s — check your network')).toBe(
      'Remote access took too long to start. Try again.'
    );
  });

  it('maps tunnel limit errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_108 limit reached')).toBe(
      'Free ngrok accounts allow one link at a time. Close the other one.'
    );
    expect(friendlyErrorMessage('tunnel limit exceeded')).toBe(
      'Free ngrok accounts allow one link at a time. Close the other one.'
    );
  });

  it('maps DNS errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_332 DNS failed')).toBe(
      'Couldn’t find your domain. Check its settings in ngrok.'
    );
    expect(friendlyErrorMessage('NXDOMAIN error')).toBe(
      'Couldn’t find your domain. Check its settings in ngrok.'
    );
  });

  it('maps gateway errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_3200 gateway')).toBe(
      'ngrok couldn’t reach this computer. Try again.'
    );
    expect(friendlyErrorMessage('502 bad gateway')).toBe(
      'ngrok couldn’t reach this computer. Try again.'
    );
  });

  it('maps upgrade/plan errors', () => {
    expect(friendlyErrorMessage('ERR_NGROK_120 upgrade required')).toBe(
      'This needs a paid ngrok plan.'
    );
    expect(friendlyErrorMessage('upgrade your plan')).toBe('This needs a paid ngrok plan.');
  });

  it('maps ECONNREFUSED errors', () => {
    expect(friendlyErrorMessage('ECONNREFUSED 127.0.0.1:4242')).toBe(
      'Couldn’t reach your DorkOS server. Make sure it’s running.'
    );
  });

  it('returns the raw message for unknown errors', () => {
    expect(friendlyErrorMessage('some unknown error')).toBe('some unknown error');
    expect(friendlyErrorMessage('')).toBe('');
  });
});

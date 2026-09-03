import { describe, it, expect } from 'vitest';
import { deriveViewState } from '../model/tunnel-view-state';

// `readTunnelReport` moved to `@/layers/entities/tunnel` with the rest of the
// shared model (DOR-1743); its cases live in that slice's own test file.

describe('deriveViewState', () => {
  it('shows the landing view until a token is configured', () => {
    expect(deriveViewState(false, false, 'off', false)).toBe('landing');
    expect(deriveViewState(false, true, 'off', false)).toBe('setup');
  });

  it('keeps a failed start on the error view', () => {
    expect(deriveViewState(true, false, 'error', false)).toBe('error');
  });

  it('shows reconnecting as connected, so the tunnel does not read as off', () => {
    expect(deriveViewState(true, false, 'reconnecting', true)).toBe('connected');
  });

  it('falls back to connecting when a live state cannot say where', () => {
    // The connected view is built around the URL and renders nothing without
    // one, so these would otherwise paint an empty dialog.
    expect(deriveViewState(true, false, 'reconnecting', false)).toBe('connecting');
    expect(deriveViewState(true, false, 'connected', false)).toBe('connecting');
    expect(deriveViewState(true, false, 'stopping', false)).toBe('connecting');
  });

  it('offers the switch when nothing is running', () => {
    expect(deriveViewState(true, false, 'off', false)).toBe('ready');
  });
});

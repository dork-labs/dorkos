import { describe, it, expect } from 'vitest';
import { readTunnelReport, deriveViewState, type TunnelReport } from '../model/tunnel-view-state';

/** A tunnel block, with only the fields the derivation reads spelled out. */
function report(fields: Partial<TunnelReport>): TunnelReport {
  return fields as TunnelReport;
}

describe('readTunnelReport', () => {
  it('reads a live tunnel as on', () => {
    expect(
      readTunnelReport(report({ connected: true, isRunning: true, url: 'https://a.app' }))
    ).toEqual({ status: 'on', url: 'https://a.app' });
  });

  it('reads an open-but-unreachable listener as reconnecting', () => {
    // The state that only exists once DOR-1738 reports `isRunning` separately.
    expect(
      readTunnelReport(report({ connected: false, isRunning: true, url: 'https://a.app' }))
    ).toEqual({ status: 'reconnecting', url: 'https://a.app' });
  });

  it('reads a closed listener as off', () => {
    expect(readTunnelReport(report({ connected: false, isRunning: false, url: null }))).toEqual({
      status: 'off',
      url: null,
    });
  });

  describe('against a server that does not send isRunning', () => {
    // The compatibility contract, asserted on the derivation itself rather than
    // through the machine — the machine can only show that the OUTPUT is `off`,
    // which is also what a broken derivation would produce for a payload that is
    // genuinely off. Only the pair of payloads below separates the two.
    it('reads connected as on', () => {
      expect(readTunnelReport(report({ connected: true, url: 'https://a.app' })).status).toBe('on');
    });

    it('reads not-connected as off, never as reconnecting', () => {
      expect(readTunnelReport(report({ connected: false, url: null })).status).toBe('off');
    });

    it('cannot produce reconnecting from any payload without the field', () => {
      const withoutField = [
        report({ connected: true, url: 'https://a.app' }),
        report({ connected: false, url: 'https://a.app' }),
        report({ connected: false, url: null }),
        report({}),
      ];
      for (const payload of withoutField) {
        expect(readTunnelReport(payload).status).not.toBe('reconnecting');
      }
    });
  });

  it('reads an unanswered config query as off, not as a fact', () => {
    expect(readTunnelReport(undefined)).toEqual({ status: 'off', url: null });
  });
});

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

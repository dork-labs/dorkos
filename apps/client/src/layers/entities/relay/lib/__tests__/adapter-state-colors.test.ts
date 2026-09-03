import { describe, it, expect } from 'vitest';
import { STATUS_DOT_PULSE, STATUS_TONE_DOT } from '@/layers/shared/ui';
import { ADAPTER_STATE_DOT_CLASS, ADAPTER_STATE_LABEL } from '../adapter-state-colors';

// Every assertion below compares against the SHARED record rather than a class
// string. That is the point of the test: relay had grown its own green, its own
// emerald and a second hand-typed pulse, and a test pinning `bg-green-500` is
// one that happily watches it happen again. Re-hardcode any of these and the
// comparison fails.
describe('ADAPTER_STATE_DOT_CLASS', () => {
  it('maps connected to the app’s success dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['connected']).toBe(STATUS_TONE_DOT.success);
  });

  it('maps disconnected to the neutral dot — idle is not a warning', () => {
    expect(ADAPTER_STATE_DOT_CLASS['disconnected']).toBe(STATUS_TONE_DOT.neutral);
  });

  it('maps error to the app’s error dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['error']).toBe(STATUS_TONE_DOT.error);
  });

  it('maps starting to a pulsing warning dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['starting']).toBe(
      `${STATUS_TONE_DOT.warning} ${STATUS_DOT_PULSE}`
    );
  });

  it('maps stopping to a pulsing warning dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['stopping']).toBe(
      `${STATUS_TONE_DOT.warning} ${STATUS_DOT_PULSE}`
    );
  });

  it('maps reconnecting to a pulsing warning dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['reconnecting']).toBe(
      `${STATUS_TONE_DOT.warning} ${STATUS_DOT_PULSE}`
    );
  });

  it('spends no raw palette value — every class is a theme token', () => {
    // A raw Tailwind palette colour (`bg-green-500`, `bg-amber-500`) is the
    // exact defect this module was rewritten to remove: it does not move when
    // the theme does, and it is how one fact ended up with seven spellings.
    for (const value of Object.values(ADAPTER_STATE_DOT_CLASS)) {
      expect(value).not.toMatch(/\bbg-[a-z]+-\d{2,3}\b/);
    }
  });

  it('covers all six AdapterStatus states', () => {
    const states = ['connected', 'disconnected', 'error', 'starting', 'stopping', 'reconnecting'];
    for (const state of states) {
      expect(ADAPTER_STATE_DOT_CLASS).toHaveProperty(state);
    }
  });
});

describe('ADAPTER_STATE_LABEL', () => {
  it('maps connected to "Connected"', () => {
    expect(ADAPTER_STATE_LABEL['connected']).toBe('Connected');
  });

  it('maps disconnected to "Ready"', () => {
    expect(ADAPTER_STATE_LABEL['disconnected']).toBe('Ready');
  });

  it('maps error to "Error"', () => {
    expect(ADAPTER_STATE_LABEL['error']).toBe('Error');
  });

  it('maps starting to "Connecting…"', () => {
    expect(ADAPTER_STATE_LABEL['starting']).toBe('Connecting…');
  });

  it('maps stopping to "Stopping…"', () => {
    expect(ADAPTER_STATE_LABEL['stopping']).toBe('Stopping…');
  });

  it('maps reconnecting to "Reconnecting…"', () => {
    expect(ADAPTER_STATE_LABEL['reconnecting']).toBe('Reconnecting…');
  });

  it('covers all six AdapterStatus states', () => {
    const states = ['connected', 'disconnected', 'error', 'starting', 'stopping', 'reconnecting'];
    for (const state of states) {
      expect(ADAPTER_STATE_LABEL).toHaveProperty(state);
    }
  });
});

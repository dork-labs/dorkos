import { describe, it, expect } from 'vitest';
import { ADAPTER_STATE_DOT_CLASS, ADAPTER_STATE_LABEL } from '../adapter-state-colors';

describe('ADAPTER_STATE_DOT_CLASS', () => {
  it('maps connected to green dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['connected']).toBe('bg-green-500');
  });

  it('maps disconnected to muted-foreground dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['disconnected']).toBe('bg-muted-foreground');
  });

  it('maps error to red dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['error']).toBe('bg-red-500');
  });

  it('maps starting to amber pulse dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['starting']).toBe('bg-amber-500 motion-safe:animate-pulse');
  });

  it('maps stopping to amber pulse dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['stopping']).toBe('bg-amber-500 motion-safe:animate-pulse');
  });

  it('maps reconnecting to amber pulse dot', () => {
    expect(ADAPTER_STATE_DOT_CLASS['reconnecting']).toBe('bg-amber-500 motion-safe:animate-pulse');
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

  it('maps starting to "Connecting\u2026"', () => {
    expect(ADAPTER_STATE_LABEL['starting']).toBe('Connecting\u2026');
  });

  it('maps stopping to "Stopping\u2026"', () => {
    expect(ADAPTER_STATE_LABEL['stopping']).toBe('Stopping\u2026');
  });

  it('maps reconnecting to "Reconnecting\u2026"', () => {
    expect(ADAPTER_STATE_LABEL['reconnecting']).toBe('Reconnecting\u2026');
  });

  it('covers all six AdapterStatus states', () => {
    const states = ['connected', 'disconnected', 'error', 'starting', 'stopping', 'reconnecting'];
    for (const state of states) {
      expect(ADAPTER_STATE_LABEL).toHaveProperty(state);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { unflattenConfig, initializeValues, generateDefaultId } from '../adapter-config-utils';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseManifest: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Telegram bot adapter',
  category: 'messaging',
  builtin: true,
  multiInstance: true,
  configFields: [
    { key: 'token', label: 'Bot Token', type: 'password', required: true },
    { key: 'channel', label: 'Channel', type: 'text', required: true, default: '#general' },
    { key: 'verbose', label: 'Verbose', type: 'boolean', required: false },
    { key: 'timeout', label: 'Timeout', type: 'number', required: false },
  ],
};

const nestedManifest: AdapterManifest = {
  ...baseManifest,
  configFields: [
    { key: 'inbound.subject', label: 'Inbound Subject', type: 'text', required: true },
    { key: 'outbound.topic', label: 'Outbound Topic', type: 'text', required: true },
    { key: 'simple', label: 'Simple', type: 'text', required: false, default: 'val' },
  ],
};

// ---------------------------------------------------------------------------
// unflattenConfig
// ---------------------------------------------------------------------------

describe('unflattenConfig', () => {
  it('converts flat dot-notation keys to nested objects', () => {
    const flat = {
      'inbound.subject': 'x',
      'inbound.queue': 'q1',
      'outbound.topic': 'y',
      simple: 'value',
    };
    expect(unflattenConfig(flat)).toEqual({
      inbound: { subject: 'x', queue: 'q1' },
      outbound: { topic: 'y' },
      simple: 'value',
    });
  });

  it('handles deeply nested keys', () => {
    expect(unflattenConfig({ 'a.b.c': 42 })).toEqual({ a: { b: { c: 42 } } });
  });

  it('returns empty object for empty input', () => {
    expect(unflattenConfig({})).toEqual({});
  });

  it('overwrites non-object intermediate values', () => {
    // If 'a' was set to a primitive first, then 'a.b' needs to create a sub-object
    const flat = { a: 'primitive', 'a.b': 'nested' };
    const result = unflattenConfig(flat);
    expect(result.a).toEqual({ b: 'nested' });
  });
});

// ---------------------------------------------------------------------------
// initializeValues
// ---------------------------------------------------------------------------

describe('initializeValues', () => {
  it('initializes with defaults when no existing config', () => {
    const values = initializeValues(baseManifest);
    expect(values).toEqual({
      token: '',
      channel: '#general',
      verbose: false,
      timeout: '',
    });
  });

  it('uses existing config values for non-password fields', () => {
    const values = initializeValues(baseManifest, { channel: '#support', timeout: 30 });
    expect(values.channel).toBe('#support');
    expect(values.timeout).toBe(30);
  });

  it('uses sentinel for password fields when existing config has a value', () => {
    const values = initializeValues(baseManifest, { token: 'real-secret' });
    expect(values.token).toBe('***');
  });

  it('uses default for password fields when no existing config', () => {
    const values = initializeValues(baseManifest);
    expect(values.token).toBe('');
  });

  it('handles nested config keys via getNestedValue', () => {
    const values = initializeValues(nestedManifest, {
      inbound: { subject: 'my-subject' },
      outbound: { topic: 'my-topic' },
    });
    expect(values['inbound.subject']).toBe('my-subject');
    expect(values['outbound.topic']).toBe('my-topic');
  });

  it('falls back to boolean false for boolean fields without defaults', () => {
    const values = initializeValues(baseManifest);
    expect(values.verbose).toBe(false);
  });

  it('falls back to empty string for text/number fields without defaults', () => {
    const values = initializeValues(baseManifest);
    expect(values.timeout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// generateDefaultId
// ---------------------------------------------------------------------------

describe('generateDefaultId', () => {
  it('returns the manifest type when no collisions', () => {
    expect(generateDefaultId(baseManifest)).toBe('telegram');
  });

  it('returns the manifest type when existing IDs do not collide', () => {
    expect(generateDefaultId(baseManifest, ['slack', 'webhook'])).toBe('telegram');
  });

  it('appends -2 when the base ID is taken', () => {
    expect(generateDefaultId(baseManifest, ['telegram'])).toBe('telegram-2');
  });

  it('appends -3 when -2 is also taken', () => {
    expect(generateDefaultId(baseManifest, ['telegram', 'telegram-2'])).toBe('telegram-3');
  });

  it('finds the first available slot', () => {
    expect(
      generateDefaultId(baseManifest, ['telegram', 'telegram-2', 'telegram-3', 'telegram-4'])
    ).toBe('telegram-5');
  });
});

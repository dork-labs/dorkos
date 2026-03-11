import { describe, it, expect } from 'vitest';
import { RELAY_ADAPTER_API_VERSION } from '../version.js';

describe('RELAY_ADAPTER_API_VERSION', () => {
  it('exports a string', () => {
    expect(typeof RELAY_ADAPTER_API_VERSION).toBe('string');
  });

  it('matches major.minor.patch semver format', () => {
    expect(RELAY_ADAPTER_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is 0.1.0 for the initial release', () => {
    expect(RELAY_ADAPTER_API_VERSION).toBe('0.1.0');
  });
});

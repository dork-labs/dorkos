import { describe, it, expect } from 'vitest';
import { satisfiesMinHostVersion, type HostVersion } from '../extension-host-version.js';

const RELEASED: HostVersion = { version: '0.88.0', isDevBuild: false };

describe('satisfiesMinHostVersion', () => {
  it('refuses a minimum above the running version', () => {
    expect(satisfiesMinHostVersion('0.88.1', RELEASED)).toBe(false);
    expect(satisfiesMinHostVersion('1.0.0', RELEASED)).toBe(false);
  });

  it('accepts a minimum equal to or below the running version', () => {
    expect(satisfiesMinHostVersion('0.88.0', RELEASED)).toBe(true);
    expect(satisfiesMinHostVersion('0.1.0', RELEASED)).toBe(true);
  });

  it('accepts no minimum at all', () => {
    expect(satisfiesMinHostVersion(undefined, RELEASED)).toBe(true);
  });

  it('accepts any minimum on a development build', () => {
    expect(satisfiesMinHostVersion('99.0.0', { version: '0.0.0', isDevBuild: true })).toBe(true);
  });

  it('refuses a minimum that is not a version', () => {
    expect(satisfiesMinHostVersion('latest', RELEASED)).toBe(false);
  });

  it('refuses a minimum when the host version itself cannot be read as a version', () => {
    // A mistyped DORKOS_VERSION_OVERRIDE must not silently load every extension.
    expect(satisfiesMinHostVersion('0.88.0', { version: '0.88', isDevBuild: false })).toBe(false);
  });

  it('still loads an extension with no minimum when the host version is unreadable', () => {
    expect(satisfiesMinHostVersion(undefined, { version: '0.88', isDevBuild: false })).toBe(true);
  });
});

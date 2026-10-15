import { describe, expect, it } from 'vitest';
import { LocalBrowserCapabilitiesSchema } from '@dorkos/shared/local-browser';
import { localBrowserCapabilities } from '../presentation.js';

describe('owned local browser availability', () => {
  it.each([{}, { display: ' ', waylandDisplay: '' }])(
    'does not advertise a window without a Linux display %o',
    (display) => {
      const capabilities = localBrowserCapabilities(false, { platform: 'linux', ...display });
      expect(capabilities.newWindow).toBe(false);
      expect(capabilities.unavailableReasons['new-window']).toBe(
        'Open DorkOS on a computer with a display.'
      );
    }
  );
  it.each([{ display: ':0' }, { waylandDisplay: 'wayland-0' }])(
    'advertises a window for a Linux graphical session %o',
    (display) => {
      expect(localBrowserCapabilities(false, { platform: 'linux', ...display }).newWindow).toBe(
        true
      );
    }
  );
  it('defaults to the embedded page when the desktop bridge is present', () => {
    const capabilities = localBrowserCapabilities(true, { platform: 'darwin' });
    expect(LocalBrowserCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(capabilities).toMatchObject({ embedded: true, defaultMode: 'embedded' });
    expect(capabilities).not.toHaveProperty('existing');
    expect(capabilities).not.toHaveProperty('existingSetup');
    expect(capabilities).not.toHaveProperty('existingBrowserVersions');
  });
  it('defaults to the separate window without the desktop bridge', () => {
    const capabilities = localBrowserCapabilities(false, { platform: 'darwin' });
    expect(LocalBrowserCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(capabilities).toMatchObject({ embedded: false, defaultMode: 'new-window' });
    expect(capabilities.unavailableReasons.embedded).toBe('Use the DorkOS desktop app.');
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { extensionApiUrl } from '../model/extension-api-url';

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('extensionApiUrl', () => {
  it('builds a relative /api path when window.electronAPI is absent (web cockpit)', () => {
    expect(extensionApiUrl('/extensions')).toBe('/api/extensions');
    expect(extensionApiUrl('/extensions/my-ext/bundle')).toBe('/api/extensions/my-ext/bundle');
  });

  it('resolves against the preload server port when window.electronAPI is present (desktop)', () => {
    window.electronAPI = {
      getServerPort: vi.fn(() => 6242),
    } as unknown as Window['electronAPI'];

    expect(extensionApiUrl('/extensions')).toBe('http://localhost:6242/api/extensions');
    expect(extensionApiUrl('/extensions/my-ext/bundle')).toBe(
      'http://localhost:6242/api/extensions/my-ext/bundle'
    );
  });
});

/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connectReturnTo } from '../connect-return-to';

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('connectReturnTo', () => {
  it('sends a browser back to this origin’s Connections page', () => {
    expect(connectReturnTo()).toBe(`${window.location.origin}/connections`);
  });

  it('sends the desktop app a dorkos: link to Connections', () => {
    window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;
    expect(connectReturnTo()).toBe('dorkos://connections');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));

/**
 * `vi.mock('electron', factory)` memoizes its result for the whole test
 * file, so the mock state is fetched through the `'electron'` specifier
 * (matching the pattern in `index.test.ts`) rather than imported directly.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

describe('setupAboutPanel (B3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets the About panel options with name, version, copyright, and credits', async () => {
    const { app, resetElectronMock } = await getElectronMock();
    resetElectronMock();
    app.getVersion = vi.fn(() => '1.2.3');
    const { setupAboutPanel } = await import('../about');

    setupAboutPanel();

    expect(app.setAboutPanelOptions).toHaveBeenCalledTimes(1);
    expect(app.setAboutPanelOptions).toHaveBeenCalledWith({
      applicationName: 'DorkOS',
      applicationVersion: '1.2.3',
      copyright: '© 2026 DorkOS',
      credits: 'Mission control for your coding agents.',
    });
  });
});

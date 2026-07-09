import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

/**
 * Test double for `electron-updater`'s `autoUpdater` singleton.
 *
 * The real `autoUpdater` is a class instance whose event surface
 * (`update-available`, `update-not-available`, `update-downloaded`,
 * `error`, …) matches Node's `EventEmitter`, so this wraps one directly
 * rather than reimplementing `on`/`off`/`emit`. Mounted via
 * `vi.mock('electron-updater', () => import('./electron-updater-mock'))`.
 */
class MockAutoUpdater extends EventEmitter {
  logger: unknown = null;
  autoInstallOnAppQuit = false;
  checkForUpdates = vi.fn(async () => null);
  checkForUpdatesAndNotify = vi.fn(async () => null);
  quitAndInstall = vi.fn();
}

export const autoUpdater = new MockAutoUpdater();

/** Reset all mock state between tests — call from `beforeEach`. */
export function resetAutoUpdaterMock(): void {
  autoUpdater.removeAllListeners();
  autoUpdater.logger = null;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.checkForUpdates = vi.fn(async () => null);
  autoUpdater.checkForUpdatesAndNotify = vi.fn(async () => null);
  autoUpdater.quitAndInstall = vi.fn();
}

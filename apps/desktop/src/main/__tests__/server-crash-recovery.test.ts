import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { pointWindowsAtServer } from '../server-crash-recovery';
import { app, BrowserWindow, resetElectronMock } from './electron-mock';
import { documentReplacedAt, resetDocumentWatermark } from '../renderer-health/document-watermark';

/**
 * What happens to the windows when a server comes back.
 *
 * The dialogs and the failure counting are the bigger half of this module and
 * they are not covered here yet. This file exists for the seam that nothing
 * else can see: sending a window to a restarted server throws away the document
 * the renderer supervisor is waiting on, and the supervisor only learns that if
 * this function tells it (DOR-2034). Deleting the stamp leaves every other
 * suite in the repo green.
 */
describe('pointWindowsAtServer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetElectronMock();
    resetDocumentWatermark();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tells the renderer supervisor the page it was waiting on is gone', () => {
    const win = new BrowserWindow();
    expect(documentReplacedAt()).toBe(0);

    // In dev the window is reloaded rather than navigated; both paths replace
    // the document, so both have to stamp.
    vi.advanceTimersByTime(5);
    pointWindowsAtServer(4242);

    expect(win.reload).toHaveBeenCalledTimes(1);
    expect(documentReplacedAt()).toBe(Date.now());

    const afterFirst = documentReplacedAt();

    // A packaged build moves to the new origin instead.
    app.isPackaged = true;
    vi.advanceTimersByTime(5);
    pointWindowsAtServer(4300);

    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:4300');
    expect(documentReplacedAt()).toBe(Date.now());
    expect(documentReplacedAt()).toBeGreaterThan(afterFirst);
  });
});

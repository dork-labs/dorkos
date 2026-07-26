import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));

import { hasTray, resetTray, setTrayActivity, setupTray } from '../tray';
import {
  app,
  Menu,
  Tray,
  nativeImage,
  resetElectronMock,
  unreadableImageFiles,
} from './electron-mock';

const originalPlatform = process.platform;

/** Pretend to be running on `platform` for the duration of a test. */
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  resetElectronMock();
  resetTray();
  vi.clearAllMocks();
});

afterEach(() => {
  resetTray();
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

/** The item labels of the current tray context menu. */
function menuLabels(): (string | undefined)[] {
  return Tray.instances[0].contextMenuTemplate().map((item) => item.label);
}

/** Click a tray menu item by label. */
function clickItem(label: string): void {
  const item = Tray.instances[0].contextMenuTemplate().find((entry) => entry.label === label);
  if (!item?.click) throw new Error(`no clickable tray item labelled "${label}"`);
  item.click({} as never, undefined, {} as never);
}

const options = { showWindow: vi.fn(), openActivity: vi.fn() };

describe('setupTray', () => {
  beforeEach(() => {
    options.showWindow = vi.fn();
    options.openActivity = vi.fn();
  });

  it('creates a template image tray on macOS', () => {
    onPlatform('darwin');

    setupTray(options);

    expect(hasTray()).toBe(true);
    expect(Tray.instances).toHaveLength(1);
    const [path] = vi.mocked(nativeImage.createFromPath).mock.calls[0];
    expect(path).toMatch(/trayTemplate\.png$/);
    // The `Template` filename suffix marks it, but the packaged path is not the
    // filename the OS sees — the flag is set outright as well.
    expect(Tray.instances[0].image.templateImage).toBe(true);
  });

  it('creates a visible (non-template) tray on Windows', () => {
    onPlatform('win32');

    setupTray(options);

    expect(hasTray()).toBe(true);
    const [path] = vi.mocked(nativeImage.createFromPath).mock.calls[0];
    expect(path).toMatch(/trayIcon\.png$/);
    expect(Tray.instances[0].image.templateImage).toBe(false);
  });

  it('opens the window on a left click on Windows only — macOS opens the menu instead', () => {
    onPlatform('win32');
    setupTray(options);
    expect(vi.mocked(Tray.instances[0].on).mock.calls.map(([event]) => event)).toEqual(['click']);

    resetTray();
    onPlatform('darwin');
    setupTray(options);
    expect(Tray.instances[1].on).not.toHaveBeenCalled();
  });

  it('runs without a tray on a platform that has no tray image', () => {
    onPlatform('linux');

    setupTray(options);

    expect(hasTray()).toBe(false);
    expect(Tray.instances).toHaveLength(0);
  });

  it('runs without a tray when the image cannot be read', () => {
    onPlatform('darwin');
    unreadableImageFiles.add('trayTemplate.png');

    setupTray(options);

    expect(hasTray()).toBe(false);
    expect(Tray.instances).toHaveLength(0);
  });

  it('is idempotent — a second call does not create a second tray', () => {
    onPlatform('darwin');

    setupTray(options);
    setupTray(options);

    expect(Tray.instances).toHaveLength(1);
  });
});

describe('tray menu', () => {
  beforeEach(() => {
    options.showWindow = vi.fn();
    options.openActivity = vi.fn();
    onPlatform('darwin');
    setupTray(options);
  });

  it('leads with the activity summary as a non-clickable line', () => {
    const [summary] = Tray.instances[0].contextMenuTemplate();
    expect(summary.label).toBe('No agents working');
    expect(summary.enabled).toBe(false);
  });

  it('offers opening the cockpit, the activity view, and quitting', () => {
    expect(menuLabels()).toEqual([
      'No agents working',
      undefined,
      'Open DorkOS',
      'Activity',
      undefined,
      'Quit DorkOS',
    ]);
  });

  it('wires each item to its action', () => {
    clickItem('Open DorkOS');
    expect(options.showWindow).toHaveBeenCalledTimes(1);

    clickItem('Activity');
    expect(options.openActivity).toHaveBeenCalledTimes(1);

    // Routed through app.quit() so the "agents are still working" confirmation
    // applies here as much as it does to Cmd+Q.
    clickItem('Quit DorkOS');
    expect(app.quit).toHaveBeenCalledTimes(1);
  });
});

describe('setTrayActivity', () => {
  beforeEach(() => {
    options.showWindow = vi.fn();
    options.openActivity = vi.fn();
  });

  it('counts agents in the tooltip, the menu, and the macOS title', () => {
    onPlatform('darwin');
    setupTray(options);
    const tray = Tray.instances[0];

    setTrayActivity(3);

    expect(tray.setToolTip).toHaveBeenLastCalledWith('DorkOS — 3 agents working');
    expect(tray.setTitle).toHaveBeenLastCalledWith('3');
    expect(menuLabels()[0]).toBe('3 agents working');
  });

  it('says "1 agent working" rather than "1 agents working"', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity(1);

    expect(Tray.instances[0].setToolTip).toHaveBeenLastCalledWith('DorkOS — 1 agent working');
  });

  it('clears the macOS title when nothing is running, rather than showing a zero', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity(2);
    setTrayActivity(0);

    expect(Tray.instances[0].setTitle).toHaveBeenLastCalledWith('');
    expect(menuLabels()[0]).toBe('No agents working');
  });

  it('does not set a title on Windows, where there is no text beside a tray icon', () => {
    onPlatform('win32');
    setupTray(options);

    setTrayActivity(2);

    expect(Tray.instances[0].setTitle).not.toHaveBeenCalled();
    expect(Tray.instances[0].setToolTip).toHaveBeenLastCalledWith('DorkOS — 2 agents working');
  });

  it('does not redraw when the count has not changed', () => {
    onPlatform('darwin');
    setupTray(options);
    setTrayActivity(2);
    const redrawsSoFar = vi.mocked(Menu.buildFromTemplate).mock.calls.length;

    setTrayActivity(2);

    expect(vi.mocked(Menu.buildFromTemplate).mock.calls).toHaveLength(redrawsSoFar);
  });

  it('is a no-op with no tray, rather than throwing', () => {
    onPlatform('linux');
    setupTray(options);

    expect(() => setTrayActivity(4)).not.toThrow();
  });
});

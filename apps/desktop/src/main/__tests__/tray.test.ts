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

  it('runs without a tray when the platform refuses to create one', () => {
    onPlatform('darwin');
    vi.mocked(nativeImage.createFromPath).mockImplementationOnce(() => {
      throw new Error('no display available');
    });

    // This runs inside the async `ready` handler, whose rejections Electron
    // surfaces nowhere — a throw here would skip the activity watch, the
    // display watch and the updater with no log line and no explanation.
    expect(() => setupTray(options)).not.toThrow();
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

  it('counts working agents in the tooltip, the menu, and the macOS title', () => {
    onPlatform('darwin');
    setupTray(options);
    const tray = Tray.instances[0];

    setTrayActivity({ streaming: 3, blocked: 0 });

    expect(tray.setToolTip).toHaveBeenLastCalledWith('DorkOS: 3 working');
    expect(tray.setTitle).toHaveBeenLastCalledWith('3');
    expect(menuLabels()[0]).toBe('3 working');
  });

  it('says "1 working" rather than "1 workings"', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity({ streaming: 1, blocked: 0 });

    expect(Tray.instances[0].setToolTip).toHaveBeenLastCalledWith('DorkOS: 1 working');
  });

  it('says "1 waiting" rather than "1 waitings"', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity({ streaming: 0, blocked: 1 });

    expect(Tray.instances[0].setToolTip).toHaveBeenLastCalledWith('DorkOS: 1 waiting');
  });

  it('joins working and waiting into one sentence when both are non-zero', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity({ streaming: 2, blocked: 1 });

    expect(Tray.instances[0].setToolTip).toHaveBeenLastCalledWith('DorkOS: 2 working · 1 waiting');
    expect(menuLabels()[0]).toBe('2 working · 1 waiting');
  });

  it('omits the working half when nothing is streaming', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity({ streaming: 0, blocked: 2 });

    expect(Tray.instances[0].setToolTip).toHaveBeenLastCalledWith('DorkOS: 2 waiting');
  });

  it('clears the macOS title when nothing is running, rather than showing a zero', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity({ streaming: 2, blocked: 0 });
    setTrayActivity({ streaming: 0, blocked: 0 });

    expect(Tray.instances[0].setTitle).toHaveBeenLastCalledWith('');
    expect(menuLabels()[0]).toBe('No agents working');
  });

  it('prefixes the macOS title with a dot when an agent is waiting on you', () => {
    onPlatform('darwin');
    setupTray(options);

    // The tray icon itself is a macOS template image, recoloured by the OS —
    // there is no pixel on it left to tint amber, so the leading dot on the
    // title is the fallback signal (see the comment in tray.ts's render()).
    setTrayActivity({ streaming: 1, blocked: 1 });

    expect(Tray.instances[0].setTitle).toHaveBeenLastCalledWith('● 2');
  });

  it('drops the dot the moment the last waiting agent is answered, even while others keep streaming', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity({ streaming: 3, blocked: 1 });
    expect(Tray.instances[0].setTitle).toHaveBeenLastCalledWith('● 4');

    // The waiting agent got answered; the three still working did not stop.
    setTrayActivity({ streaming: 3, blocked: 0 });

    expect(Tray.instances[0].setTitle).toHaveBeenLastCalledWith('3');
  });

  it('does not set a title on Windows, where there is no text beside a tray icon', () => {
    onPlatform('win32');
    setupTray(options);

    setTrayActivity({ streaming: 2, blocked: 0 });

    expect(Tray.instances[0].setTitle).not.toHaveBeenCalled();
    expect(Tray.instances[0].setToolTip).toHaveBeenLastCalledWith('DorkOS: 2 working');
  });

  it('does not redraw when neither count has changed', () => {
    onPlatform('darwin');
    setupTray(options);
    setTrayActivity({ streaming: 2, blocked: 0 });
    const redrawsSoFar = vi.mocked(Menu.buildFromTemplate).mock.calls.length;

    setTrayActivity({ streaming: 2, blocked: 0 });

    expect(vi.mocked(Menu.buildFromTemplate).mock.calls).toHaveLength(redrawsSoFar);
  });

  it('is a no-op with no tray, rather than throwing', () => {
    onPlatform('linux');
    setupTray(options);

    expect(() => setTrayActivity({ streaming: 4, blocked: 0 })).not.toThrow();
  });

  it('sets the macOS Dock badge to the waiting count, and clears it at zero', () => {
    onPlatform('darwin');
    setupTray(options);

    setTrayActivity({ streaming: 1, blocked: 3 });
    expect(app.dock?.setBadge).toHaveBeenLastCalledWith('3');

    setTrayActivity({ streaming: 1, blocked: 0 });
    expect(app.dock?.setBadge).toHaveBeenLastCalledWith('');
  });

  it('does not touch the Dock badge off macOS', () => {
    onPlatform('win32');
    setupTray(options);

    setTrayActivity({ streaming: 0, blocked: 2 });

    expect(app.dock?.setBadge).not.toHaveBeenCalled();
  });

  it('sets the Dock badge even when there is no tray to redraw', () => {
    onPlatform('darwin');
    unreadableImageFiles.add('trayTemplate.png');
    setupTray(options);
    expect(hasTray()).toBe(false);

    setTrayActivity({ streaming: 0, blocked: 1 });

    expect(app.dock?.setBadge).toHaveBeenLastCalledWith('1');
  });
});

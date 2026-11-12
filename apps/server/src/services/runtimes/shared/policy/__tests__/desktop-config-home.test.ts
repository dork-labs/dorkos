import { describe, expect, it } from 'vitest';
import { desktopConfigHome, movedDesktopConfigHome } from '../desktop-config-home.js';

describe('movedDesktopConfigHome', () => {
  it('names only an absolute Linux XDG root', () => {
    expect(movedDesktopConfigHome({ XDG_CONFIG_HOME: '/probe/moved config' }, 'linux')).toBe(
      '/probe/moved config'
    );
  });

  it.each([
    [undefined, 'linux'],
    ['', 'linux'],
    ['relative/config', 'linux'],
    ['/probe/moved', 'darwin'],
    ['/probe/moved', 'win32'],
  ] as const)('is undefined for %s on %s, where the home rules already cover it', (value, os) => {
    expect(movedDesktopConfigHome({ XDG_CONFIG_HOME: value }, os)).toBeUndefined();
  });
});

describe('desktopConfigHome', () => {
  it('uses an absolute Linux XDG config root, including spaces', () => {
    expect(
      desktopConfigHome('/probe/home', { XDG_CONFIG_HOME: '/probe/moved config' }, 'linux')
    ).toBe('/probe/moved config');
  });

  it.each([undefined, '', 'relative/config'])('keeps the default for %s', (value) => {
    expect(desktopConfigHome('/probe/home', { XDG_CONFIG_HOME: value }, 'linux')).toBe(
      '/probe/home/.config'
    );
  });

  it.each(['darwin', 'win32'] as const)('does not move desktop data on %s', (platform) => {
    expect(desktopConfigHome('/probe/home', { XDG_CONFIG_HOME: '/probe/moved' }, platform)).toBe(
      '/probe/home/.config'
    );
  });
});

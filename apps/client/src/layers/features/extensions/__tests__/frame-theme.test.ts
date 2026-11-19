/**
 * How an app's frame takes the host's look (DOR-4330): the host reads the
 * text size of the frame's place and its size scales, and the frame applies
 * only values of the right shape.
 *
 * @module features/extensions/__tests__/frame-theme
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyFrameTheme, readHostTheme } from '../frame/theme';

afterEach(() => {
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  document.body.innerHTML = '';
});

describe('readHostTheme', () => {
  // Purpose: the size comes from where the frame sits, not the page root, so
  // a status item in the 12 px bar is told 12 px.
  it('reads the text size of the frame’s place and the host’s scales', () => {
    document.documentElement.className = 'dark';
    document.documentElement.style.setProperty('--_st', '1.25');
    const slot = document.createElement('div');
    slot.style.fontSize = '12px';
    document.body.append(slot);

    const theme = readHostTheme(slot);

    expect(theme.className).toBe('dark');
    expect(theme.fontSize).toBe('12px');
    expect(theme.scales['--_st']).toBe('1.25');
  });
});

describe('applyFrameTheme', () => {
  const base = { className: 'dark', style: 'font-family: serif', scales: {} };

  it('draws body text at the host size, leaving the root for rem sizes', () => {
    applyFrameTheme(document, { ...base, fontSize: '12px' });
    expect(document.body.style.fontSize).toBe('12px');
    expect(document.documentElement.style.fontSize).toBe('');
    expect(document.documentElement.className).toBe('dark');
    expect(document.documentElement.style.fontFamily).toBe('serif');
  });

  it.each(['medium', '', '1em', '12px; color: red'])(
    'leaves the frame’s own size for %j',
    (size) => {
      document.body.style.fontSize = '20px';
      applyFrameTheme(document, { ...base, fontSize: size });
      expect(document.body.style.fontSize).toBe('');
    }
  );

  // Purpose: the copied stylesheet's phone rule tests the frame's own width, so
  // a narrow frame on a desktop would scale text up; the host's scales win.
  it('pins the host’s size scales on the frame root, and only plain numbers', () => {
    applyFrameTheme(document, {
      ...base,
      fontSize: '12px',
      scales: { '--_st': '1', '--_si': 'calc(9)', '--_sb': '1.25' },
    });
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--_st')).toBe('1');
    expect(root.getPropertyValue('--_si')).toBe('');
    expect(root.getPropertyValue('--_sb')).toBe('1.25');
  });
});

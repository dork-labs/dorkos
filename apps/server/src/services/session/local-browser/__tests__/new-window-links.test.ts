// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { retargetNewWindowLink } from '../chat/new-window-links.js';

it.each(['_blank', 'named-popup'])(
  'retargets a %s link to the chat tab without changing its destination',
  (target) => {
    const link = document.createElement('a');
    link.href = 'https://made-up.example/report';
    link.target = target;
    const child = document.createElement('span');
    link.append(child);
    document.body.append(link);
    try {
      expect(retargetNewWindowLink(child)).toBe(true);
      expect(link.target).toBe('_self');
      expect(link.href).toBe('https://made-up.example/report');
    } finally {
      link.remove();
    }
  }
);

it('does not alter same-tab links or an unrelated button', () => {
  const link = document.createElement('a');
  link.href = 'https://made-up.example/report';
  expect(retargetNewWindowLink(link)).toBe(false);
  expect(retargetNewWindowLink(document.createElement('button'))).toBe(false);
});

it('blocks script windows before creation while an agent owns the page', async () => {
  const { installWindowPolicy } = await import('../chat/window-policy.js');
  const { vi } = await import('vitest');
  const original = window.open;
  const open = vi.fn(() => null);
  window.open = open;
  const report = vi.fn(async () => undefined);
  Object.assign(window, { __madeUpReport: report });
  try {
    installWindowPolicy({ control: '__madeUpControl', report: '__madeUpReport' });
    expect(window.open('https://made-up.example/')).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    (window as unknown as Record<string, (held: boolean) => void>).__madeUpControl(true);
    window.open('https://made-up.example/sign-in');
    expect(open).not.toHaveBeenCalled(); // Activation carried from agent activity is not a person click.
  } finally {
    window.open = original;
    vi.unstubAllGlobals();
  }
});

it('blocks a sign-in page script without a click even after the person takes the tab', async () => {
  const { installWindowPolicy } = await import('../chat/window-policy.js');
  const { vi } = await import('vitest');
  const original = window.open;
  const open = vi.fn(() => null);
  window.open = open;
  vi.stubGlobal('navigator', { userActivation: { isActive: false } });
  try {
    installWindowPolicy({ control: '__noClickControl', report: '__noClickReport' });
    (window as unknown as Record<string, (taken: boolean) => void>).__noClickControl(true);
    expect(window.open('https://login.made-up.example/')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  } finally {
    window.open = original;
    vi.unstubAllGlobals();
  }
});

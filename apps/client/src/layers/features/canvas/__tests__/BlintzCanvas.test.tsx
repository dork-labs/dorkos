/**
 * @vitest-environment jsdom
 */
import type { Theme } from '@/layers/shared/model';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Stub the heavy editor — this suite only verifies the data-theme wrapper that
// makes the app's theme authoritative over Blintz's OS media query.
vi.mock('blintz', () => ({
  MarkdownEditor: ({ value }: { value: string }) => (
    <div data-testid="markdown-editor">{value}</div>
  ),
}));

const themeState: { theme: Theme } = { theme: 'light' };
vi.mock('@/layers/shared/model', () => ({
  useTheme: () => ({ theme: themeState.theme, setTheme: vi.fn() }),
}));

import { BlintzCanvas } from '../ui/BlintzCanvas';

/** The wrapper element that carries data-theme (the editor's parent). */
function themeWrapper(): HTMLElement {
  const wrapper = screen.getByTestId('markdown-editor').parentElement;
  if (!wrapper) throw new Error('expected a wrapper element around the editor');
  return wrapper;
}

/** Point window.matchMedia at a fixed dark-preference answer. */
function stubMatchMedia(prefersDark: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

beforeEach(() => {
  themeState.theme = 'light';
});
afterEach(cleanup);

describe('BlintzCanvas theme forwarding', () => {
  it('forwards an explicit light preference as data-theme="light"', () => {
    themeState.theme = 'light';
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'light');
  });

  it('forwards an explicit dark preference as data-theme="dark"', () => {
    themeState.theme = 'dark';
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'dark');
  });

  it('resolves "system" to the OS preference (dark when the OS is dark)', () => {
    themeState.theme = 'system';
    stubMatchMedia(true);
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'dark');
  });

  it('resolves "system" to the OS preference (light when the OS is light)', () => {
    themeState.theme = 'system';
    stubMatchMedia(false);
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'light');
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Stub the heavy editor — this suite verifies the data-theme wrapper and that a
// live theme change reaches an already-mounted editor.
vi.mock('blintz', () => ({
  MarkdownEditor: ({ value }: { value: string }) => (
    <div data-testid="markdown-editor">{value}</div>
  ),
}));

// Use the REAL store-backed hook so a theme change actually propagates. use-theme
// is a light module (zustand only), so importActual avoids pulling the whole
// shared/model barrel.
vi.mock('@/layers/shared/model', async () => {
  const theme = await vi.importActual<typeof import('@/layers/shared/model/use-theme')>(
    '@/layers/shared/model/use-theme'
  );
  return { useResolvedTheme: theme.useResolvedTheme };
});

// Import the store from the real module (only the barrel is mocked) — the same
// singleton the component's useResolvedTheme reads via importActual.
import { useThemeStore } from '@/layers/shared/model/use-theme';
import { BlintzCanvas } from '../ui/BlintzCanvas';

/** The wrapper element that carries data-theme (the editor's parent). */
function themeWrapper(): HTMLElement {
  const wrapper = screen.getByTestId('markdown-editor').parentElement;
  if (!wrapper) throw new Error('expected a wrapper element around the editor');
  return wrapper;
}

beforeEach(() => {
  act(() => useThemeStore.getState().setTheme('light'));
});
afterEach(cleanup);

describe('BlintzCanvas theme forwarding', () => {
  it('forwards a resolved light theme as data-theme="light"', () => {
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'light');
  });

  it('forwards a resolved dark theme as data-theme="dark"', () => {
    act(() => useThemeStore.getState().setTheme('dark'));
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'dark');
  });

  it('updates data-theme live when the store theme changes, without remounting the editor', () => {
    render(<BlintzCanvas value="# hi" editable={false} />);
    const editorBefore = screen.getByTestId('markdown-editor');
    expect(themeWrapper()).toHaveAttribute('data-theme', 'light');

    // A theme switch from any surface flows through the shared store (S2).
    act(() => useThemeStore.getState().setTheme('dark'));

    expect(themeWrapper()).toHaveAttribute('data-theme', 'dark');
    // Same editor node — the wrapper re-rendered, the editor was not torn down.
    expect(screen.getByTestId('markdown-editor')).toBe(editorBefore);
  });
});

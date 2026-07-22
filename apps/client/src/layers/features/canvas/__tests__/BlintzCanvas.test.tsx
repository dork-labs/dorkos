/**
 * @vitest-environment jsdom
 */
import type { ResolvedTheme } from '@/layers/shared/model';
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

// The resolution itself (including system→OS via matchMedia) is unit-tested in
// shared/model/__tests__/use-theme.test.ts; here we only prove BlintzCanvas
// forwards whatever it resolves to.
const themeState: { resolved: ResolvedTheme } = { resolved: 'light' };
vi.mock('@/layers/shared/model', () => ({
  useResolvedTheme: () => themeState.resolved,
}));

import { BlintzCanvas } from '../ui/BlintzCanvas';

/** The wrapper element that carries data-theme (the editor's parent). */
function themeWrapper(): HTMLElement {
  const wrapper = screen.getByTestId('markdown-editor').parentElement;
  if (!wrapper) throw new Error('expected a wrapper element around the editor');
  return wrapper;
}

beforeEach(() => {
  themeState.resolved = 'light';
});
afterEach(cleanup);

describe('BlintzCanvas theme forwarding', () => {
  it('forwards a resolved light theme as data-theme="light"', () => {
    themeState.resolved = 'light';
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'light');
  });

  it('forwards a resolved dark theme as data-theme="dark"', () => {
    themeState.resolved = 'dark';
    render(<BlintzCanvas value="# hi" editable={false} />);
    expect(themeWrapper()).toHaveAttribute('data-theme', 'dark');
  });
});

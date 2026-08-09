// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PageContainer } from '../page-container';

afterEach(cleanup);

/** The inner content box — the thing a page styles and the thing widths apply to. */
function box(): HTMLElement {
  return screen.getByTestId('content');
}

describe('PageContainer', () => {
  it('caps a wide page at the wide token', () => {
    render(
      <PageContainer width="wide">
        <span data-testid="content">page</span>
      </PageContainer>
    );
    expect(box().parentElement).toHaveClass('max-w-[var(--page-width-wide)]');
  });

  it('caps a reading page at the reading token', () => {
    render(
      <PageContainer width="reading">
        <span data-testid="content">page</span>
      </PageContainer>
    );
    expect(box().parentElement).toHaveClass('max-w-[var(--page-width-reading)]');
  });

  it('caps a full page at nothing, but still takes the gutters', () => {
    render(
      <PageContainer width="full">
        <span data-testid="content">page</span>
      </PageContainer>
    );
    const inner = box().parentElement!;
    expect(inner.className).not.toMatch(/max-w-/);
    expect(inner).toHaveClass('px-4', 'sm:px-6');
  });

  it('is always w-full, in every width and either scroll mode', () => {
    for (const width of ['full', 'wide', 'reading'] as const) {
      for (const scroll of [true, false]) {
        cleanup();
        render(
          <PageContainer width={width} scroll={scroll}>
            <span data-testid="content">page</span>
          </PageContainer>
        );
        // Without this a flex or grid parent shrink-wraps the box, which is the
        // whole bug class PageContainer exists to end.
        expect(box().parentElement, `width=${width} scroll=${scroll}`).toHaveClass('w-full');
      }
    }
  });

  it('owns the page scroller by default', () => {
    render(
      <PageContainer width="reading">
        <span data-testid="content">page</span>
      </PageContainer>
    );
    const scroller = box().parentElement!.parentElement!;
    expect(scroller).toHaveClass('h-full', 'overflow-y-auto');
  });

  it('renders no scroller wrapper when scroll is false', () => {
    render(
      <div data-testid="host">
        <PageContainer width="reading" scroll={false}>
          <span data-testid="content">page</span>
        </PageContainer>
      </div>
    );
    const inner = box().parentElement!;
    expect(inner.parentElement).toBe(screen.getByTestId('host'));
    expect(inner.className).not.toContain('overflow-y-auto');
    expect(inner).toHaveClass('flex', 'h-full', 'min-h-0', 'flex-col');
  });

  it('merges className onto the inner box, not the scroller', () => {
    render(
      <PageContainer width="wide" className="space-y-8">
        <span data-testid="content">page</span>
      </PageContainer>
    );
    const inner = box().parentElement!;
    expect(inner).toHaveClass('space-y-8', 'mx-auto', 'max-w-[var(--page-width-wide)]');
    expect(inner.parentElement).not.toHaveClass('space-y-8');
  });

  it('spreads remaining div props onto the inner box', () => {
    render(
      <PageContainer width="full" id="settings-page" aria-label="Settings">
        <span data-testid="content">page</span>
      </PageContainer>
    );
    const inner = box().parentElement!;
    expect(inner.id).toBe('settings-page');
    expect(inner).toHaveAttribute('aria-label', 'Settings');
  });
});

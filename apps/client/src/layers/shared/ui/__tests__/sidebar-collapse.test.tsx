// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Sidebar, SidebarProvider, SidebarTrigger } from '../sidebar';
import { sidebarFoldTransition } from '../sidebar-collapse';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => false };
});

function Harness({ open, showRow = true }: { open: boolean; showRow?: boolean }) {
  return (
    <SidebarProvider open={open} onOpenChange={() => {}}>
      <Sidebar>
        <div data-sidebar="group">
          <button tabIndex={0}>Section stop</button>
          {showRow && <button tabIndex={-1}>Row</button>}
        </div>
      </Sidebar>
      <SidebarTrigger />
      <textarea aria-label="Composer" />
    </SidebarProvider>
  );
}

const panel = () => document.querySelector('[data-slot="sidebar-container"]')!;
const trigger = () => screen.getByRole('button', { name: 'Toggle sidebar', hidden: true });

describe('the sidebar collapse', () => {
  beforeEach(() => {
    // jsdom has no `matchMedia`, and `useReducedMotion` asks it.
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('takes a shut panel out of reach, and gives an open one back', () => {
    const { rerender } = render(<Harness open />);
    expect(panel()).not.toHaveAttribute('inert');

    rerender(<Harness open={false} />);
    expect(panel()).toHaveAttribute('inert');

    rerender(<Harness open />);
    expect(panel()).not.toHaveAttribute('inert');
  });

  it('is inert on the first paint when it starts shut', () => {
    render(<Harness open={false} />);
    expect(panel()).toHaveAttribute('inert');
  });

  it('says what the trigger controls and whether it is open', () => {
    const { rerender } = render(<Harness open />);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', panel().id);

    rerender(<Harness open={false} />);
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  it('moves focus to the trigger when shutting took it, and back on reopening', () => {
    const { rerender } = render(<Harness open />);
    const row = screen.getByRole('button', { name: 'Row' });
    act(() => row.focus());

    rerender(<Harness open={false} />);
    expect(trigger()).toHaveFocus();

    rerender(<Harness open />);
    expect(row).toHaveFocus();
  });

  it('leaves focus in the composer through two presses', () => {
    const { rerender } = render(<Harness open />);
    const composer = screen.getByLabelText('Composer');
    act(() => composer.focus());

    rerender(<Harness open={false} />);
    expect(composer).toHaveFocus();

    rerender(<Harness open />);
    expect(composer).toHaveFocus();
  });

  it('does not take focus back from somewhere the person has since moved to', () => {
    const { rerender } = render(<Harness open />);
    act(() => screen.getByRole('button', { name: 'Row' }).focus());
    rerender(<Harness open={false} />);

    const composer = screen.getByLabelText('Composer');
    act(() => composer.focus());
    rerender(<Harness open />);

    expect(composer).toHaveFocus();
  });

  it('falls back to the section’s stop when the remembered row has gone', () => {
    const { rerender } = render(<Harness open />);
    act(() => screen.getByRole('button', { name: 'Row' }).focus());
    rerender(<Harness open={false} />);
    rerender(<Harness open={false} showRow={false} />);

    rerender(<Harness open showRow={false} />);

    expect(screen.getByRole('button', { name: 'Section stop' })).toHaveFocus();
  });

  it('is a spring, and instant under reduced motion', () => {
    expect(sidebarFoldTransition(false)).toMatchObject({ type: 'spring' });
    expect(sidebarFoldTransition(null)).toMatchObject({ type: 'spring' });
    expect(sidebarFoldTransition(true)).toEqual({ duration: 0 });
  });
});

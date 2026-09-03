/**
 * @vitest-environment jsdom
 *
 * One press, four possible outcomes.
 *
 * Both promo surfaces — the sidebar card and the quiet-state suggestion — press
 * through this hook, so a promo that changes from a dialog to a link changes in
 * one place. Every action type is exercised here, `navigate` included, because
 * the registry has none today and an untested branch is where the next one
 * would land.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { PromoDefinition } from '../model/promo-types';

/** Minimal stub that satisfies the LucideIcon (ForwardRefExoticComponent) shape for tests. */
const StubIcon = forwardRef<SVGSVGElement>(() => null) as unknown as LucideIcon;

const openLink = vi.fn();
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return { ...actual, openLink: (...args: unknown[]) => openLink(...args) };
});

vi.mock('../ui/PromoDialog', () => ({
  PromoDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="promo-dialog" /> : <div data-testid="promo-dialog-closed" />,
}));

import { usePromoActivation } from '../ui/use-promo-activation';

function makePromo(action: PromoDefinition['action']): PromoDefinition {
  return {
    id: 'test-promo',
    placements: ['dashboard-sidebar'],
    priority: 50,
    shouldShow: () => true,
    content: {
      icon: StubIcon,
      title: 'Test Title',
      shortDescription: 'Test description',
      ctaLabel: 'Learn more',
    },
    action,
  };
}

/** A surface that does nothing but press the promo. */
function Harness({ promo }: { promo: PromoDefinition }) {
  const { activate, dialog } = usePromoActivation(promo);
  return (
    <>
      <button onClick={activate}>Press</button>
      {dialog}
    </>
  );
}

beforeEach(() => {
  openLink.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('usePromoActivation', () => {
  it('opens the shell dialog for a `dialog` promo', () => {
    render(<Harness promo={makePromo({ type: 'dialog', component: () => null })} />);

    expect(screen.getByTestId('promo-dialog-closed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Press' }));
    expect(screen.getByTestId('promo-dialog')).toBeInTheDocument();
  });

  it('mounts no dialog of its own for an `action` promo', () => {
    // The shape Remote Access takes since DOR-1743: the card flips the app's
    // own dialog flag rather than mounting a second copy of that dialog. The
    // retired `open-dialog` variant is what made the duplicate possible.
    const handler = vi.fn();
    render(<Harness promo={makePromo({ type: 'action', handler })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Press' }));
    expect(handler).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('promo-dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('promo-dialog-closed')).not.toBeInTheDocument();
  });

  it('follows the link for a `navigate` promo, and mounts no dialog', () => {
    render(<Harness promo={makePromo({ type: 'navigate', to: 'https://dorkos.ai/docs' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Press' }));
    expect(openLink).toHaveBeenCalledWith('https://dorkos.ai/docs');
    expect(screen.queryByTestId('promo-dialog-closed')).not.toBeInTheDocument();
  });

  it('calls the handler for an `action` promo', () => {
    const handler = vi.fn();
    render(<Harness promo={makePromo({ type: 'action', handler })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Press' }));
    expect(handler).toHaveBeenCalledOnce();
    expect(openLink).not.toHaveBeenCalled();
  });
});

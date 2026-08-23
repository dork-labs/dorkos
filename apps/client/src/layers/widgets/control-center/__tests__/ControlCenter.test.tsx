// @vitest-environment jsdom
/**
 * The Control Center shell — that the ⚡ glyph opens the flyout and that the
 * `controlCenterOpen` store flag drives it both ways. The flag being the single
 * source of truth is what lets the command palette, the keyboard shortcut and
 * the consent door all open the same surface; escape / outside-click close it
 * because the surface is controlled by that flag (verified in a browser too).
 *
 * The body is stubbed so this test exercises the shell, not the transport-backed
 * dial, switches and ledger (those have their own tests).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';
import { useAppStore } from '@/layers/shared/model';

vi.mock('../ui/ControlCenterBody', () => ({
  ControlCenterBody: () => <div data-testid="cc-body" />,
}));

import { ControlCenter } from '../ui/ControlCenter';

beforeEach(() => {
  act(() => useAppStore.getState().setControlCenterOpen(false));
});
afterEach(() => cleanup());

describe('ControlCenter shell', () => {
  it('opens the flyout when the glyph is clicked', () => {
    render(<ControlCenter />);
    expect(screen.queryByTestId('cc-body')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('control-center-trigger'));

    expect(screen.getByTestId('cc-body')).toBeInTheDocument();
    expect(useAppStore.getState().controlCenterOpen).toBe(true);
  });

  it('is driven by the store flag both ways — the open-seam the door and palette use', () => {
    render(<ControlCenter />);

    act(() => useAppStore.getState().setControlCenterOpen(true));
    expect(screen.getByTestId('cc-body')).toBeInTheDocument();

    act(() => useAppStore.getState().setControlCenterOpen(false));
    expect(screen.queryByTestId('cc-body')).not.toBeInTheDocument();
  });

  it('exposes an accessible name on the icon-only trigger', () => {
    render(<ControlCenter />);
    expect(screen.getByRole('button', { name: 'Control Center' })).toBeInTheDocument();
  });
});

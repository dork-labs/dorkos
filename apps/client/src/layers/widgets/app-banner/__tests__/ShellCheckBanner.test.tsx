/**
 * @vitest-environment jsdom
 */
/** What a person reads when DorkOS can't check shell commands, and the choice to go on (DOR-3300). */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ShellCheckStatus } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';

import { TransportProvider } from '@/layers/shared/model';
import { ShellCheckBanner } from '../ui/ShellCheckBanner';

const local = vi.hoisted(() => ({ value: true }));
vi.mock('@/layers/entities/config', () => ({ useLocalCaller: () => local.value }));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  local.value = true;
});

const DOWN: ShellCheckStatus = { down: true, full: true, canContinue: false, continuing: false };
const BUTTON = 'Continue without the check';

/** The banner, with a transport to watch. */
function show(status: ShellCheckStatus) {
  const transport = createMockTransport();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TransportProvider transport={transport}>
        <ShellCheckBanner status={status} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('ShellCheckBanner', () => {
  it('says the shell is paused at Full, and tries a restart first', () => {
    show(DOWN);
    expect(screen.getByText(/can’t check shell commands for protected files/)).toBeInTheDocument();
    expect(screen.getByText(/Shell commands are paused\. Restart DorkOS\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument();
  });

  it('says what really happens below Full', () => {
    show({ ...DOWN, full: false });
    expect(
      screen.getByText(/Commands that name setup files are refused, and others ask first/)
    ).toBeInTheDocument();
  });

  it('offers the choice once a restart hasn’t helped, with focus on Cancel', async () => {
    const transport = show({ ...DOWN, canContinue: true });
    expect(screen.getByText(/Still not running/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: BUTTON }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('This lasts until you restart.');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(transport.continueWithoutShellCheck).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: BUTTON, hidden: false }));
    await waitFor(() => expect(transport.continueWithoutShellCheck).toHaveBeenCalledOnce());
  });

  it('gives a phone the words, not the button', () => {
    local.value = false;
    show({ ...DOWN, canContinue: true });
    expect(screen.getByText(/Still not running/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: BUTTON })).not.toBeInTheDocument();
  });

  it('keeps saying the check is off, with nothing to dismiss', () => {
    show({ ...DOWN, canContinue: true, continuing: true });
    expect(
      screen.getByText('The protected-files check is off until you restart.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

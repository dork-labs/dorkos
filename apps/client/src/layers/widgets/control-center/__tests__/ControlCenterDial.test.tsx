// @vitest-environment jsdom
/**
 * The Control Center's power setting is the permission preset picker, with a
 * way to the whole Permissions page (spec `agent-permissions`, task 3.8). What
 * the picker itself does is pinned in `features/permissions/__tests__/PresetPicker.test.tsx`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

const openSettings = vi.fn();
const setControlCenterOpen = vi.fn();
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSettingsDeepLink: () => ({ open: openSettings }),
    useAppStore: (
      selector: (s: { setControlCenterOpen: typeof setControlCenterOpen }) => unknown
    ) => selector({ setControlCenterOpen }),
  };
});

import { ControlCenterDial } from '../ui/ControlCenterDial';

afterEach(() => cleanup());

function renderDial() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport()}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  render(<ControlCenterDial />, { wrapper });
}

describe('ControlCenterDial', () => {
  it('shows the preset picker', async () => {
    renderDial();
    expect(await screen.findByRole('radio', { name: 'Full power' })).toBeInTheDocument();
  });

  it('opens Settings → Permissions, closing the flyout first', async () => {
    renderDial();
    await userEvent.click(screen.getByRole('button', { name: /Edit permissions/ }));
    expect(setControlCenterOpen).toHaveBeenCalledWith(false);
    expect(openSettings).toHaveBeenCalledWith('permissions');
  });
});

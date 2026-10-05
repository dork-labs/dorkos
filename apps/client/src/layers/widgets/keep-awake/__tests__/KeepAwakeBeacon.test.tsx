/**
 * @vitest-environment jsdom
 */
/**
 * The top-bar cup: drawn only while DorkOS is keeping this computer awake for
 * work, saying what for, and one click from the setting.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useSettingsDeepLink: () => ({ open: openSettings }) };
});

import { KeepAwakeBeacon } from '../ui/KeepAwakeBeacon';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      // Desktop: the popover, not the phone sheet.
      matches: query.includes('min-width'),
      media: query,
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
  openSettings.mockClear();
});

const status = (overrides: Partial<KeepAwakeStatus>): KeepAwakeStatus => ({
  enabled: true,
  supported: true,
  reason: null,
  asserted: true,
  working: { chats: 2, rooms: 0, tasks: 0, waking: false },
  wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
  ...overrides,
});

/** Render the cup over a transport answering `answer`, with the status already in the cache. */
function renderWith(answer: KeepAwakeStatus) {
  const transport = createMockTransport();
  vi.mocked(transport.getKeepAwake).mockResolvedValue(answer);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['keep-awake'], answer);
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <KeepAwakeBeacon />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('KeepAwakeBeacon', () => {
  it('draws nothing while the computer is not held awake', () => {
    renderWith(status({ asserted: false }));
    expect(screen.queryByTestId('keep-awake-beacon')).not.toBeInTheDocument();
  });

  it('draws nothing during the linger after the last piece of work', () => {
    renderWith(status({ working: { chats: 0, rooms: 0, tasks: 0, waking: false } }));
    expect(screen.queryByTestId('keep-awake-beacon')).not.toBeInTheDocument();
  });

  it('says what it is keeping the computer awake for', () => {
    renderWith(status({ working: { chats: 1, rooms: 1, tasks: 1, waking: false } }));
    expect(screen.getByTestId('keep-awake-beacon')).toHaveAccessibleName(
      'Keeping this computer awake: 1 chat, 1 room, 1 task. Show details'
    );
  });

  it('opens to the status and the caveat, and links to Settings → Tools → Sleep', () => {
    renderWith(status({}));
    fireEvent.click(screen.getByTestId('keep-awake-beacon'));

    expect(screen.getByText('Keeping awake: 2 chats running')).toBeInTheDocument();
    expect(screen.getByText(/A closed lid on battery/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sleep settings' }));
    expect(openSettings).toHaveBeenCalledWith('tools', 'sleep');
  });
});

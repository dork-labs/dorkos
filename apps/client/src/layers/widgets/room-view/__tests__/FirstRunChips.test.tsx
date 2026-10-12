/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { useComposerFocusStore, useRoomDraftStore } from '@/layers/entities/room';

// Settings is a dialog opened through the URL, which needs router context;
// the address it is asked for is the whole of what these chips decide.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useSettingsDeepLink: () => ({ open: openSettings }) };
});

import { FirstRunChips } from '../ui/FirstRunChips';

const ROOM = 'room-team';

function renderChips(mode: 'starters' | 'connect', transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <FirstRunChips roomId={ROOM} mode={mode} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('FirstRunChips', () => {
  let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    useRoomDraftStore.setState({ drafts: {} });
    useComposerFocusStore.setState({ focusRequests: {} });
    fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Whether anything asked the first-run route, through the transport or the network. */
  function firstRunWasCalled(transport: Transport): boolean {
    const viaNetwork = fetchSpy.mock.calls.some((call: Parameters<typeof fetch>) => {
      const input = call[0] as RequestInfo | URL;
      return String(input instanceof Request ? input.url : input).includes('/onboarding/first-run');
    });
    return viaNetwork || vi.mocked(transport.chooseFirstRunPath).mock.calls.length > 0;
  }

  describe('with no AI connected (the first run is finished)', () => {
    it('Continue with DorkOS opens the account link in Settings, not the first run', () => {
      const transport = createMockTransport();
      renderChips('connect', transport);
      fireEvent.click(screen.getByRole('button', { name: 'Continue with DorkOS' }));
      expect(openSettings).toHaveBeenCalledWith('account');
      expect(firstRunWasCalled(transport)).toBe(false);
    });

    it('Use my own AI opens Settings at the AI apps and model, not the first run', () => {
      const transport = createMockTransport();
      renderChips('connect', transport);
      fireEvent.click(screen.getByRole('button', { name: 'Use my own AI' }));
      expect(openSettings).toHaveBeenCalledWith('runtimes');
      expect(firstRunWasCalled(transport)).toBe(false);
    });
  });

  describe('with AI connected', () => {
    it('a job chip posts the person’s message to DorkBot', async () => {
      const transport = createMockTransport();
      renderChips('starters', transport);
      fireEvent.click(screen.getByRole('button', { name: 'Build me a tracker for my customers' }));
      await waitFor(() =>
        expect(transport.postToRoom).toHaveBeenCalledWith(ROOM, {
          text: '@dorkbot Build me a tracker for my customers',
        })
      );
      expect(firstRunWasCalled(transport)).toBe(false);
    });

    it('Something else puts @dorkbot in the composer and the caret after it', () => {
      const transport = createMockTransport();
      renderChips('starters', transport);
      fireEvent.click(screen.getByRole('button', { name: 'Something else' }));
      expect(useRoomDraftStore.getState().drafts[ROOM]).toBe('@dorkbot ');
      expect(useComposerFocusStore.getState().focusRequests[ROOM]).toBe(1);
      expect(transport.postToRoom).not.toHaveBeenCalled();
    });
  });
});

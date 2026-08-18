// @vitest-environment jsdom
/**
 * The one list every Ask card is drawn from.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Make the `interaction_pending` handler append instead of upsert → "one
 *   entry, however many times the same prompt arrives" goes red with two.
 * - Drop the per-session override → "takes the fresher number from the session
 *   that is streaming it" reads the list's stale `remainingMs`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useSessionStreamStore } from '@/layers/entities/session';
import { usePendingInteractions } from '../model/use-pending-interactions';
import { clearAskReceipts, useAskReceipt } from '../model/ask-receipt-store';

/** The handlers `useEventSubscription` registered, so a case can fire one. */
const handlers = new Map<string, (payload: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (name: string, handler: (payload: unknown) => void) => {
      handlers.set(name, handler);
    },
  };
});

const NOW = Date.parse('2026-08-18T10:00:00.000Z');

/** A permission prompt, as the list and the stream both carry it. */
function approval(id: string, remainingMs = 600_000): PendingInteractionDTO {
  return {
    type: 'approval',
    id,
    startedAt: NOW,
    remainingMs,
    timeoutMs: 600_000,
    toolName: 'Bash',
    input: '{}',
    hasSuggestions: false,
  };
}

/** One envelope off the fleet-wide list. */
function pending(id: string, overrides: Partial<InteractionPendingEvent> = {}) {
  return {
    sessionId: 'session-1',
    cwd: '/projects/alpha',
    interaction: approval(id),
    ...overrides,
  } satisfies InteractionPendingEvent;
}

let transport: ReturnType<typeof createMockTransport>;

/** Mount the hook with a transport that answers `seed`. */
function mount(seed: InteractionPendingEvent[]) {
  transport = createMockTransport();
  vi.mocked(transport.listPendingInteractions).mockResolvedValue({ interactions: seed });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </TransportProvider>
  );
  return renderHook(() => usePendingInteractions(), { wrapper });
}

beforeEach(() => {
  handlers.clear();
  clearAskReceipts();
  useSessionStreamStore.setState({ sessions: {} }, false);
});

afterEach(cleanup);

describe('usePendingInteractions', () => {
  it('seeds from the route, so a window that opened late is not blind', async () => {
    const { result } = mount([pending('tc-1')]);

    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
    expect(result.current.interactions[0]!.interaction.id).toBe('tc-1');
    expect(transport.listPendingInteractions).toHaveBeenCalledTimes(1);
  });

  it('adds a prompt the stream raises while the window is open', async () => {
    const { result } = mount([]);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => handlers.get('interaction_pending')!(pending('tc-live')));

    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
  });

  it('keeps one entry, however many times the same prompt arrives', async () => {
    // A refetch racing the event is the ordinary case, and two cards for one
    // question reads as "it asked me again".
    const { result } = mount([pending('tc-1')]);
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));

    act(() => handlers.get('interaction_pending')!(pending('tc-1')));

    await waitFor(() => expect(result.current.interactions).toHaveLength(1));
  });

  it('drops a prompt the moment anything resolves it, and remembers how it ended', async () => {
    const { result } = mount([pending('tc-1')]);
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));

    act(() =>
      handlers.get('interaction_resolved')!({
        sessionId: 'session-1',
        interactionId: 'tc-1',
        outcome: 'answered',
        resolvedAt: '2026-08-18T10:02:00.000Z',
        resolvedBy: 'Dorian',
      })
    );

    await waitFor(() => expect(result.current.interactions).toHaveLength(0));
    const { result: receipt } = renderHook(() => useAskReceipt('tc-1'));
    expect(receipt.current).toMatchObject({
      outcome: 'answered',
      resolvedBy: 'Dorian',
      byThisWindow: false,
    });
  });

  it('takes the fresher number from the session that is streaming it', async () => {
    // Both stores hold the same prompt. The per-session DTO is seq'd and
    // arrives faster, so the countdown reads from it; membership stays the
    // list's to decide.
    const { result } = mount([pending('tc-1', { interaction: approval('tc-1', 600_000) })]);
    await waitFor(() => expect(result.current.interactions).toHaveLength(1));

    act(() => {
      useSessionStreamStore.setState(
        {
          sessions: {
            'session-1': {
              pendingInteractions: [approval('tc-1', 120_000)],
            } as never,
          },
        },
        false
      );
    });

    await waitFor(() =>
      expect(result.current.interactions[0]!.interaction.remainingMs).toBe(120_000)
    );
    // And exactly one entry: the attached session refreshes a row, never adds one.
    expect(result.current.interactions).toHaveLength(1);
  });
});

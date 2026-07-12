/**
 * @vitest-environment jsdom
 *
 * Same-tick re-entrancy guard for the widget action latch. The render-state
 * latch (context `latched`) does not update between two dispatches fired in the
 * SAME synchronous burst (a fast double-click, or programmatic multi-click), so
 * the provider carries a synchronous ref gate checked before any await. These
 * tests dispatch twice within one click handler — one tick, no re-render — and
 * assert exactly one POST leaves.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import type { WidgetAction } from '@dorkos/shared/ui-widget';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { WidgetActionProvider, useWidgetActions } from '../model/widget-context';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

afterEach(cleanup);

const mockTransport = createMockTransport();

function Wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

/** Fires N agent dispatches synchronously inside a single click handler. */
function BurstDispatcher({ actionIds }: { actionIds: string[] }) {
  const { onAction } = useWidgetActions();
  return (
    <button
      type="button"
      onClick={() => {
        for (const id of actionIds) {
          void onAction({ kind: 'agent', id }).catch(() => {});
        }
      }}
    >
      burst
    </button>
  );
}

describe('widget action latch re-entrancy', () => {
  it('dispatches exactly one POST for a burst of same-tick agent actions', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
    render(
      <WidgetActionProvider sessionId="sess-1" widgetTitle="Board">
        <BurstDispatcher actionIds={['move-1-0', 'move-1-2', 'move-0-2']} />
      </WidgetActionProvider>,
      { wrapper: Wrapper }
    );

    await user.click(screen.getByRole('button', { name: 'burst' }));

    await waitFor(() => expect(mockTransport.sendUiAction).toHaveBeenCalledTimes(1));
    expect(mockTransport.sendUiAction).toHaveBeenCalledWith('sess-1', {
      actionId: 'move-1-0',
      payload: undefined,
      widgetTitle: 'Board',
    });
  });

  it('re-opens the gate after a failed dispatch (the un-latch path)', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi
      .fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce({ sessionId: 'sess-1' });
    render(
      <WidgetActionProvider sessionId="sess-1" widgetTitle="Board">
        <BurstDispatcher actionIds={['move-0-0']} />
      </WidgetActionProvider>,
      { wrapper: Wrapper }
    );

    const button = screen.getByRole('button', { name: 'burst' });
    await user.click(button);
    await waitFor(() => expect(mockTransport.sendUiAction).toHaveBeenCalledTimes(1));

    // First dispatch failed and un-latched — a retry click must go through.
    await user.click(button);
    await waitFor(() => expect(mockTransport.sendUiAction).toHaveBeenCalledTimes(2));
  });
});

/** Fires a single `ui`-kind action from inside the provider. */
function UiDispatcher({ action }: { action: WidgetAction }) {
  const { onAction } = useWidgetActions();
  return (
    <button type="button" onClick={() => void onAction(action)}>
      dispatch-ui
    </button>
  );
}

describe('widget ui-kind dispatch context', () => {
  it('threads the widget sessionId so a ui open_pip command pops the panel instead of toasting', async () => {
    // Regression (DOR-302 review): the ui-kind DispatcherContext omitted the
    // in-scope sessionId, so a widget button firing open_pip wrongly degraded
    // to the "needs an active session" toast.
    const user = userEvent.setup();
    const openPipSpy = vi.spyOn(useAppStore.getState(), 'openPip');
    render(
      <WidgetActionProvider sessionId="sess-1" widgetTitle="Board">
        <UiDispatcher
          action={{ kind: 'ui', command: { action: 'open_pip', title: 'Tic-Tac-Toe' } }}
        />
      </WidgetActionProvider>,
      { wrapper: Wrapper }
    );

    await user.click(screen.getByRole('button', { name: 'dispatch-ui' }));

    expect(openPipSpy).toHaveBeenCalledWith({
      kind: 'widget',
      sessionId: 'sess-1',
      title: 'Tic-Tac-Toe',
    });
  });
});

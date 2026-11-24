/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import type { CanvasChannelEventReceipt, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { WidgetRenderer } from '../ui/WidgetRenderer';
import { useWidgetChannelActions } from '../model/widget-channel';

import {
  disposeOwnedChannel,
  document,
  draw,
  installWidgetChannelSuite,
  port,
  receipt,
  transport,
} from './widget-channel.fixtures';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

installWidgetChannelSuite();

describe('native document widget actions', () => {
  it.each(['widget.action', 'widget.*'])(
    'normalizes an agent action through approved %s',
    async (pattern) => {
      const channel = { ...port(), approvedEventTypes: [pattern] };
      const { result } = renderHook(() => useWidgetChannelActions(channel));
      await act(() => result.current.dispatch({ kind: 'agent', id: 'save' }, 'control'));
      expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
      expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1]).toMatchObject({
        type: 'widget.action',
        payload: { actionId: 'save', widget: { nodeId: 'control' } },
      });
      expect(transport.sendUiAction).not.toHaveBeenCalled();
    }
  );

  it.each([
    { pattern: 'task.*', enabled: true },
    { pattern: 'widget.action.*', enabled: true },
    { pattern: 'widget*', enabled: true },
    { pattern: '*', enabled: true },
    { pattern: 'widget.*', enabled: false },
  ])(
    'refuses normalized actions for $pattern with enabled=$enabled',
    async ({ pattern, enabled }) => {
      const channel = { ...port(), approvedEventTypes: [pattern], enabled };
      const doc: WidgetDocument = {
        version: 1,
        root: { type: 'button', label: 'Agent', action: { kind: 'agent', id: 'save' } },
      };
      draw(doc, channel);
      expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
      await userEvent.setup().click(screen.getByRole('button', { name: 'Agent' }));
      const { result } = renderHook(() => useWidgetChannelActions(channel));
      await act(() => result.current.dispatch({ kind: 'agent', id: 'save' }, 'control'));
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.sendUiAction).not.toHaveBeenCalled();
    }
  );

  it('keeps exact normalized identity after lost response and generic 404 without reposting', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
    const { result } = renderHook(() =>
      useWidgetChannelActions({ ...port(), approvedEventTypes: ['widget.*'] })
    );
    await act(() => result.current.dispatch({ kind: 'agent', id: 'save' }, 'control'));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    expect(result.current.pending('control')).toBe(true);
    await act(() => result.current.retry(original.id));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls.map(([, event]) => event)).toEqual([
      original,
    ]);
    expect(result.current.records[0].event.id).toBe(original.id);
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
      'doc-one',
      original.id,
      { expectedGeneration: 'a'.repeat(64) },
      expect.any(AbortSignal)
    );
    expect(result.current.pending('control')).toBe(true);
  });

  it('freezes per-click host IDs and node metadata, enabling independent new clicks after acceptance', async () => {
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByRole('button', { name: 'Two' }));
    const inputs = vi.mocked(transport.ingestCanvasEvent).mock.calls.map((call) => call[1]);
    expect(new Set(inputs.map((input) => input.id)).size).toBe(3);
    expect(inputs[0].payload).toMatchObject({
      task: 'one',
      widget: { documentId: 'doc-one', nodeId: 'root.children.0', title: 'Tasks' },
    });
    expect(inputs[2].payload).toMatchObject({ widget: { nodeId: 'root.children.1' } });
    expect(transport.sendUiAction).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('widget-action-status')).toHaveLength(3);
  });
  it('guards a direct new dispatch after a lost persisted response and forbidden lookup', async () => {
    const persisted: PageEvent[] = [];
    vi.mocked(transport.ingestCanvasEvent).mockImplementation(async (_id, event) => {
      persisted.push(event);
      throw new Error('Response lost AFTER persistence');
    });
    vi.mocked(transport.getCanvasEventReceipt).mockRejectedValue(
      Object.assign(new Error('Permission revoked'), { status: 403 })
    );
    const { result } = renderHook(() => useWidgetChannelActions(port()));
    const action = { kind: 'emit' as const, type: 'task.changed', payload: { task: 'same' } };
    await act(() => result.current.dispatch(action, 'control'));
    const original = result.current.records[0].event.id;
    await act(() => result.current.retry(original));
    expect(result.current.records[0].phase).toBe('review');
    expect(result.current.pending('control')).toBe(true);
    await act(() => result.current.dispatch(action, 'control'));
    expect(persisted).toHaveLength(1);
    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0].event.id).toBe(original);
  });
  it('preserves the original uncertain identity after its genuine private owner retires', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValue(
      new Error('Response lost after persistence')
    );
    const channel = port();
    const view = draw(document, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    const originalBytes = JSON.stringify(original);
    act(() => {
      disposeOwnedChannel();
    });
    expect(channel.current?.('read')).toBe(false);
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={{ ...channel, enabled: false }} />
      </TransportProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={channel} />
      </TransportProvider>
    );
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('widget-action-status')).toHaveAttribute(
      'data-event-id',
      original.id
    );
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1])).toBe(
      originalBytes
    );
  });

  it('keeps the original pending when generic receipt absence is unknown', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost response'));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
      'doc-one',
      original.id,
      { expectedGeneration: 'a'.repeat(64) },
      expect.any(AbortSignal)
    );
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('widget-action-status')).toHaveLength(1);
  });
  it('releases only a definitive original POST refusal for a fresh click', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(
      Object.assign(new Error('Refused before acceptance'), { status: 403 })
    );
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByRole('button', { name: 'One' })).not.toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'One' }));
    const calls = vi.mocked(transport.ingestCanvasEvent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][1].id).not.toBe(calls[0][1].id);
  });
  it('blocks only the uncertain control and never reposts after an unknown receipt lookup', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Offline'));
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Two' })).not.toBeDisabled();
    const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await user.click(screen.getByTestId('widget-action-retry'));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
      'doc-one',
      original.id,
      { expectedGeneration: 'a'.repeat(64) },
      expect.any(AbortSignal)
    );
    expect(screen.getByRole('button', { name: 'One' })).toBeDisabled();
  });
  it('looks up uncertain acceptance first and never reposts an already recorded click', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Response lost'));
    vi.mocked(transport.getCanvasEventReceipt).mockImplementation(async (_doc, id) =>
      receipt({ v: 1, id, type: 'task.changed', payload: {} })
    );
    draw();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    await user.click(screen.getByTestId('widget-action-retry'));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'One' })).not.toBeDisabled();
  });
  it('refuses uncertain retry across a receipt floor', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Offline'));
    const channel = port();
    const view = draw(document, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'One' }));
    channel.snapshot = {
      state: {},
      stateRev: 1,
      receipts: [],
      retentionFloor: 4,
      receiptRetentionFloor: 4,
      resetRequired: true,
    };
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={channel} />
      </TransportProvider>
    );
    await user.click(screen.getByTestId('widget-action-retry'));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Save not confirmed/)).toBeVisible();
    expect(screen.queryByTestId('widget-action-retry')).toBeNull();
  });
  it('never falls back to inline execution without an approved current normalization route', async () => {
    const doc: WidgetDocument = {
      version: 1,
      root: { type: 'button', label: 'Agent', action: { kind: 'agent', id: 'save' } },
    };
    const channel = { ...port(), approvedEventTypes: [] };
    const view = draw(doc, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Agent' }));
    expect(transport.sendUiAction).not.toHaveBeenCalled();
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(screen.getByText(/approved document route/)).toBeVisible();
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={doc} channel={port()} />
      </TransportProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Agent' }));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1]).toMatchObject({
      type: 'widget.action',
      payload: { actionId: 'save' },
    });
    expect(transport.sendUiAction).not.toHaveBeenCalled();
  });
  it('closes the same-tick double-click window before acceptance', async () => {
    let accept!: (value: CanvasChannelEventReceipt) => void;
    vi.mocked(transport.ingestCanvasEvent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    draw();
    const button = screen.getByRole('button', { name: 'One' });
    act(() => {
      button.click();
      button.click();
    });
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    const event = vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1];
    await act(async () => accept(receipt(event)));
    expect(button).not.toBeDisabled();
  });
  it('bounds the complete assembled envelope before any submission', async () => {
    const doc: WidgetDocument = {
      version: 1,
      root: {
        type: 'button',
        label: 'Large',
        action: { kind: 'emit', type: 'task.changed', payload: { text: 'x'.repeat(16_384) } },
      },
    };
    draw(doc);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Large' }));
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    const { toast } = await import('sonner');
    expect(toast.error).toHaveBeenCalled();
  });
  it('does not resend an uncertain click through another document host', async () => {
    vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('offline'));
    const channel = port();
    const view = draw(document, channel);
    await userEvent.setup().click(screen.getByRole('button', { name: 'One' }));
    channel.documentId = 'doc-two';
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={document} channel={channel} />
      </TransportProvider>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
    expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  });
  it('requires native form fields and preserves the same input/focus/caret across state and receipt updates', async () => {
    const doc: WidgetDocument = {
      version: 1,
      root: {
        type: 'form',
        children: [{ type: 'input', name: 'title', label: 'Title', required: true }],
        submit: { label: 'Save', action: { kind: 'emit', type: 'task.changed' } },
      },
    };
    const channel = port();
    const view = draw(doc, channel);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter Title.');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, 'my draft');
    input.setSelectionRange(3, 3);
    channel.snapshot = {
      state: { reply: 'new' },
      stateRev: 2,
      receipts: [],
      retentionFloor: 1,
      receiptRetentionFloor: 1,
      resetRequired: false,
    };
    view.rerender(
      <TransportProvider transport={transport}>
        <WidgetRenderer document={doc} channel={channel} />
      </TransportProvider>
    );
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('my draft');
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0][1].payload).toMatchObject({
      title: 'my draft',
    });
  });
});

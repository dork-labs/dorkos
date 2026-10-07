// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { UiCanvasContent } from '@dorkos/shared/types';
import type { CanvasChannelReplayResponse, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import type { WidgetChannelPort } from '@/layers/features/gen-ui';
import { TransportProvider } from '@/layers/shared/model';
import { ownDocChannelConnection } from '@/layers/shared/lib/transport/doc-channel-ownership';
import type { Transport } from '@dorkos/shared/transport';
let testOwner: Transport;
function publishDocChannelNotification(value: unknown) {
  return ownDocChannelConnection(testOwner, new AbortController().signal).publish(value);
}
import { CanvasRenderer } from '../ui/CanvasRenderer';
import { CanvasWidgetContent } from '../ui/CanvasWidgetContent';

// Only widget dispatch is under test; unrelated viewer dependencies never mount.
vi.mock('../ui/CanvasBrowserContent', () => ({ CanvasBrowserContent: () => null }));
vi.mock('../ui/CanvasMarkdownContent', () => ({ CanvasMarkdownContent: () => null }));
vi.mock('../ui/CanvasJsonContent', () => ({ CanvasJsonContent: () => null }));
vi.mock('../ui/CanvasImageContent', () => ({ CanvasImageContent: () => null }));
vi.mock('../ui/CanvasPdfContent', () => ({ CanvasPdfContent: () => null }));
vi.mock('../ui/CanvasAudioContent', () => ({ CanvasAudioContent: () => null }));
vi.mock('../ui/CanvasVideoContent', () => ({ CanvasVideoContent: () => null }));
vi.mock('../ui/CanvasMcpAppContent', () => ({ CanvasMcpAppContent: () => null }));
vi.mock('@/layers/entities/session', async (actual) => ({
  ...(await actual<typeof import('@/layers/entities/session')>()),
  useSessionId: () => ['request-alias', vi.fn()],
}));

const content: Extract<UiCanvasContent, { type: 'widget' }> = {
  type: 'widget',
  definition: {
    version: 1,
    title: 'Draft',
    root: {
      type: 'stack',
      direction: 'vertical',
      children: [
        { type: 'input', name: 'title', label: 'Title' },
        { type: 'button', label: 'Save', action: { kind: 'agent', id: 'save' } },
      ],
    },
  },
};
const response = (): CanvasChannelReplayResponse => ({
  incarnation: {
    v: 1,
    documentId: 'doc-1',
    physicalOpenedAt: '2026-10-01T00:00:00.000Z',
    channelCreatedAt: '2026-10-01T00:00:00.000Z',
    generation: 'a'.repeat(64),
  },
  events: [],
  receipts: [],
  state: {},
  stateRev: 0,
  highWatermark: 0,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  health: { status: 'ready', reasons: [] },
  routing: { enabled: true, approvedEventTypes: ['widget.action'], destinationLabel: 'DorkBot' },
});
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(cleanup);

describe('production hosted canvas widget', () => {
  it.each(['widget.action', 'widget.*'])(
    'keeps loading and refused routes on the channel, then accepts %s while preserving draft/focus',
    async (pattern) => {
      const transport = createMockTransport();
      testOwner = transport;
      let submittedSignalWasLive = false;
      const originalIngest = vi.mocked(transport.ingestCanvasEvent).getMockImplementation()!;
      vi.mocked(transport.ingestCanvasEvent).mockImplementation((...args) => {
        submittedSignalWasLive = !args[3].aborted;
        return originalIngest(...args);
      });
      let resolve!: (value: CanvasChannelReplayResponse) => void;
      vi.mocked(transport.getCanvasChannel).mockReturnValue(
        new Promise((value) => {
          resolve = value;
        })
      );
      const user = userEvent.setup();
      render(
        <TransportProvider transport={transport}>
          <CanvasRenderer documentId="doc-1" content={content} onContentChange={vi.fn()} />
        </TransportProvider>
      );
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.sendUiAction).not.toHaveBeenCalled();
      await act(async () =>
        resolve({
          ...response(),
          routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Approval needed' },
        })
      );
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
      expect(transport.sendUiAction).not.toHaveBeenCalled();
      await act(async () => {
        const { events: _events, ...snapshot } = {
          ...response(),
          routing: { ...response().routing!, approvedEventTypes: [pattern] },
        };
        expect(
          publishDocChannelNotification({
            type: 'canvas_channel_snapshot',
            scope: 'session:canonical',
            documentId: 'doc-1',
            snapshot,
          })
        ).toBe(true);
      });
      expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute(
        'aria-disabled',
        'true'
      );
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1));
      expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0]).toMatchObject([
        'doc-1',
        { type: 'widget.action', payload: { actionId: 'save' } },
        { expectedGeneration: response().incarnation!.generation },
        expect.any(AbortSignal),
      ]);
      expect(submittedSignalWasLive).toBe(true);
      expect(transport.sendUiAction).not.toHaveBeenCalled();
      const input = screen.getByRole('textbox', { name: 'Title' });
      await user.click(input);
      await user.type(input, 'my draft');
      await act(async () => {
        const { events: _events, ...snapshot } = {
          ...response(),
          routing: { ...response().routing!, approvedEventTypes: [pattern] },
        };
        publishDocChannelNotification({
          type: 'canvas_channel_snapshot',
          scope: 'session:canonical',
          documentId: 'doc-1',
          snapshot: { ...snapshot, state: { done: true }, stateRev: 1 },
        });
      });
      expect(screen.getByRole('textbox', { name: 'Title' })).toBe(input);
      expect(input).toHaveValue('my draft');
      expect(input).toHaveFocus();
    }
  );

  it('uses an explicit fixture port without fetching the production document channel', async () => {
    const transport = createMockTransport();
    const submit = vi.fn().mockImplementation(async (event: PageEvent, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      return {
        receipt: { id: event.id, status: 'recorded', docSeq: 1 },
        deliveries: [],
      };
    });
    const port: WidgetChannelPort = {
      documentId: 'fixture-doc',
      enabled: true,
      destinationLabel: 'Fixture',
      approvedEventTypes: ['widget.action'],
      submit,
      inspect: vi.fn(),
      captureOriginal: vi.fn((event: PageEvent) => {
        const capturedId = event.id;
        const capturedBytes = JSON.stringify(event);
        return Object.freeze({
          id: capturedId,
          bytes: capturedBytes,
          current: () => true,
          submit: (signal: AbortSignal) => submit(event, signal),
          inspect: (signal: AbortSignal) => port.inspect(capturedId, signal),
        });
      }),
    };
    render(
      <TransportProvider transport={transport}>
        <CanvasWidgetContent documentId="fixture-doc" content={content} channel={port} />
      </TransportProvider>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledTimes(1);
    const [capturedEvent] = vi.mocked(port.captureOriginal!).mock.calls[0];
    const capturedOriginal = vi.mocked(port.captureOriginal!).mock.results[0].value;
    expect(capturedOriginal).toMatchObject({
      id: capturedEvent.id,
      bytes: JSON.stringify(capturedEvent),
    });
    expect(submit).toHaveBeenCalledWith(capturedEvent, expect.any(AbortSignal));
    expect(submit.mock.calls[0][1].aborted).toBe(true);
    expect(transport.getCanvasChannel).not.toHaveBeenCalled();
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(transport.sendUiAction).not.toHaveBeenCalled();
  });
});

it('recovers a lost native response through same-birth canonical rekey and preserves the draft', async () => {
  const transport = createMockTransport();
  testOwner = transport;
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(response());
  vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost accepted response'));
  render(
    <TransportProvider transport={transport}>
      <CanvasRenderer documentId="doc-1" content={content} onContentChange={vi.fn()} />
    </TransportProvider>
  );
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
  );
  const input = screen.getByRole('textbox', { name: 'Title' });
  await user.type(input, 'original draft');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0];
  const saved = {
    receipt: { id: original[1].id, status: 'recorded' as const, docSeq: 1 },
    deliveries: [],
  };
  vi.mocked(transport.getCanvasEventReceipt).mockResolvedValueOnce(saved);
  const { events: _events, ...snapshot } = response();
  await act(async () => {
    publishDocChannelNotification({
      type: 'canvas_channel_snapshot',
      documentId: 'doc-1',
      scope: 'session:first',
      snapshot,
    });
  });
  await act(async () => {
    publishDocChannelNotification({
      type: 'canvas_channel_snapshot',
      documentId: 'doc-1',
      scope: 'session:renewed',
      snapshot,
    });
  });
  await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
  await user.click(screen.getByTestId('widget-action-retry'));
  expect(transport.getCanvasEventReceipt).toHaveBeenCalledTimes(1);
  expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
    'doc-1',
    original[1].id,
    original[2],
    expect.any(AbortSignal)
  );
  expect(vi.mocked(transport.getCanvasEventReceipt).mock.calls[0][3]).not.toBe(original[3]);
  expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox', { name: 'Title' })).toBe(input);
  expect(input).toHaveValue('original draft');
});

it('keeps an uncertain hosted action and draft through an owned birthless replay, then inspects once after same-birth repair', async () => {
  const transport = createMockTransport();
  testOwner = transport;
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(response());
  vi.mocked(transport.ingestCanvasEvent).mockRejectedValueOnce(new Error('Lost accepted response'));
  render(
    <TransportProvider transport={transport}>
      <CanvasRenderer documentId="doc-1" content={content} onContentChange={vi.fn()} />
    </TransportProvider>
  );
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    )
  );
  const input = screen.getByRole('textbox', { name: 'Title' });
  await user.type(input, 'original uncertain draft');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.getByTestId('widget-action-status')).toHaveTextContent('Save not confirmed')
  );
  const original = vi.mocked(transport.ingestCanvasEvent).mock.calls[0];
  const saved = {
    receipt: { id: original[1].id, status: 'recorded' as const, docSeq: 1 },
    deliveries: [],
  };
  const legacy = {
    ...response(),
    highWatermark: 1,
    stateRev: 1,
    state: { unqualified: true },
    receipts: [saved],
  };
  delete legacy.incarnation;
  vi.mocked(transport.getCanvasChannel).mockResolvedValueOnce(legacy);
  await act(async () => ownDocChannelConnection(transport, new AbortController().signal).retire());
  await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByTestId('widget-action-status')).toHaveAttribute(
    'data-event-id',
    original[1].id
  );
  expect(screen.getByTestId('widget-action-status')).toHaveTextContent('Save not confirmed');
  await user.click(screen.getByTestId('widget-action-retry'));
  expect(transport.getCanvasEventReceipt).not.toHaveBeenCalled();
  expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  expect(transport.sendUiAction).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Title' })).toBe(input);
  expect(input).toHaveValue('original uncertain draft');
  vi.mocked(transport.getCanvasChannel).mockResolvedValueOnce(response());
  vi.mocked(transport.getCanvasEventReceipt).mockResolvedValueOnce(saved);
  await act(async () => ownDocChannelConnection(transport, new AbortController().signal).retire());
  await waitFor(() => expect(transport.getCanvasChannel).toHaveBeenCalledTimes(3));
  await act(async () => {});
  await user.click(screen.getByTestId('widget-action-retry'));
  await waitFor(() =>
    expect(screen.getByTestId('widget-action-status')).toHaveTextContent('Saved to the document.')
  );
  expect(transport.getCanvasEventReceipt).toHaveBeenCalledTimes(1);
  expect(transport.getCanvasEventReceipt).toHaveBeenCalledWith(
    'doc-1',
    original[1].id,
    original[2],
    expect.any(AbortSignal)
  );
  expect(vi.mocked(transport.getCanvasEventReceipt).mock.calls[0][3]).not.toBe(original[3]);
  expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue('original uncertain draft');
});

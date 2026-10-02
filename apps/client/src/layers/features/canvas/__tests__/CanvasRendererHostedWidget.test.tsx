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
import { publishDocChannelNotification } from '@/layers/shared/lib/transport';
import { CanvasRenderer } from '../ui/CanvasRenderer';

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
  it('keeps loading and refused routes on the channel, then preserves draft/focus through live state', async () => {
    const transport = createMockTransport();
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
      const { events: _events, ...snapshot } = response();
      expect(
        publishDocChannelNotification({
          type: 'canvas_channel_snapshot',
          scope: 'session:canonical',
          documentId: 'doc-1',
          snapshot,
        })
      ).toBe(true);
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(transport.ingestCanvasEvent).toHaveBeenCalledTimes(1));
    expect(vi.mocked(transport.ingestCanvasEvent).mock.calls[0]).toMatchObject([
      'doc-1',
      { type: 'widget.action', payload: { actionId: 'save' } },
    ]);
    expect(transport.sendUiAction).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'Title' });
    await user.click(input);
    await user.type(input, 'my draft');
    await act(async () => {
      const { events: _events, ...snapshot } = response();
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
  });

  it('uses an explicit fixture port without fetching the production document channel', async () => {
    const transport = createMockTransport();
    const submit = vi.fn().mockImplementation(async (event: PageEvent) => ({
      receipt: { id: event.id, status: 'recorded', docSeq: 1 },
      deliveries: [],
    }));
    const port: WidgetChannelPort = {
      documentId: 'fixture-doc',
      enabled: true,
      destinationLabel: 'Fixture',
      approvedEventTypes: ['widget.action'],
      submit,
      inspect: vi.fn(),
    };
    render(
      <TransportProvider transport={transport}>
        <CanvasRenderer
          documentId="fixture-doc"
          content={content}
          widgetChannel={port}
          onContentChange={vi.fn()}
        />
      </TransportProvider>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save' }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(transport.getCanvasChannel).not.toHaveBeenCalled();
    expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    expect(transport.sendUiAction).not.toHaveBeenCalled();
  });
});

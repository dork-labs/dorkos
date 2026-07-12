/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';

// The canvas resolves the active session id from the router; stub only that hook
// so the unit test doesn't need a RouterProvider. Keep the rest of the module
// real — WidgetRenderer's agent-action path uses the live session stream store.
vi.mock('@/layers/entities/session', async (importActual) => ({
  ...(await importActual<typeof import('@/layers/entities/session')>()),
  useSessionId: () => ['sess-canvas', vi.fn()],
}));

import { CanvasWidgetContent } from '../ui/CanvasWidgetContent';

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

afterEach(cleanup);

describe('CanvasWidgetContent', () => {
  it('renders the widget definition in the canvas', () => {
    const content: Extract<UiCanvasContent, { type: 'widget' }> = {
      type: 'widget',
      title: 'Metrics',
      definition: {
        version: 1,
        title: 'Metrics',
        root: { type: 'stat', label: 'Uptime', value: '99.9%' },
      },
    };
    render(<CanvasWidgetContent content={content} />, { wrapper: Wrapper });
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    expect(screen.getByText('99.9%')).toBeInTheDocument();
  });

  it('renders the D5 error card for a malformed definition instead of throwing', () => {
    // The wire schema's `definition` is a predicate-free z.custom, so anything
    // can arrive; the render boundary must degrade, never throw into the
    // panel error boundary.
    const content = {
      type: 'widget',
      definition: { version: 1, root: { type: 'blink', text: 'nope' } },
    } as unknown as Extract<UiCanvasContent, { type: 'widget' }>;

    expect(() => render(<CanvasWidgetContent content={content} />)).not.toThrow();
    expect(screen.getByText("This widget couldn't be rendered")).toBeInTheDocument();
  });

  it('survives an undefined definition', () => {
    const content = { type: 'widget' } as unknown as Extract<UiCanvasContent, { type: 'widget' }>;

    expect(() => render(<CanvasWidgetContent content={content} />)).not.toThrow();
    expect(screen.getByText("This widget couldn't be rendered")).toBeInTheDocument();
  });
});

/** A one-cell interactive board, titled so distinct definitions produce distinct keys. */
function boardContent(title: string): Extract<UiCanvasContent, { type: 'widget' }> {
  return {
    type: 'widget',
    title,
    definition: {
      version: 1,
      title,
      root: {
        type: 'board',
        rows: [[{ action: { kind: 'agent', id: 'm-0-0', payload: { glyph: 'X' } } }]],
      },
    },
  };
}

describe('CanvasWidgetContent action latch across definition changes', () => {
  it('remounts a fresh action provider when the definition changes, so a re-emitted board accepts a move', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-canvas' });
    const { rerender } = render(<CanvasWidgetContent content={boardContent('Board A')} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByLabelText('Row 1, column 1: empty — play here'));
    // The click latches this provider instance — the cell shows its optimistic mark.
    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();

    // An update_canvas swap to a DIFFERENT definition is a new turn: the key
    // changes, the subtree remounts, and the fresh board is playable again.
    rerender(<CanvasWidgetContent content={boardContent('Board B')} />);
    expect(screen.getByLabelText('Row 1, column 1: empty — play here')).toBeInTheDocument();
  });

  it('keeps the latch when the definition is unchanged (no spurious remount)', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-canvas' });
    const { rerender } = render(<CanvasWidgetContent content={boardContent('Board A')} />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByLabelText('Row 1, column 1: empty — play here'));
    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();

    // Re-rendering the same definition yields the same key, so the provider is
    // NOT remounted and the latch (optimistic mark) survives.
    rerender(<CanvasWidgetContent content={boardContent('Board A')} />);
    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();
  });
});

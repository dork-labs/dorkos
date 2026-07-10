/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { WidgetRenderer } from '../ui/WidgetRenderer';

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

function renderBoard(root: WidgetDocument['root'], opts?: { isLatestMessage?: boolean }) {
  return render(
    <WidgetRenderer
      document={{ version: 1, title: 'Tic-Tac-Toe', root }}
      sessionId="sess-1"
      isLatestMessage={opts?.isLatestMessage}
    />,
    { wrapper: Wrapper }
  );
}

describe('BoardNode accessibility', () => {
  it('gives filled and playable cells descriptive accessible names', () => {
    renderBoard({
      type: 'board',
      rows: [[{ glyph: 'X' }, { action: { kind: 'agent', id: 'm-0-1', payload: { glyph: 'O' } } }]],
    });
    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();
    expect(screen.getByLabelText('Row 1, column 2: empty — play here')).toBeInTheDocument();
  });
});

describe('BoardNode interaction latch', () => {
  it('places the mark optimistically and latches the whole board on click', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 'sess-1' });
    renderBoard({
      type: 'board',
      rows: [
        [
          { action: { kind: 'agent', id: 'm-0-0', payload: { glyph: 'X' } } },
          { action: { kind: 'agent', id: 'm-0-1', payload: { glyph: 'X' } } },
        ],
      ],
    });

    const firstCell = screen.getByLabelText('Row 1, column 1: empty — play here');
    await user.click(firstCell);

    // The payload's glyph lands on the clicked cell immediately.
    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();
    // The other agent cell is now inert (widget latched) and explains why on focus.
    const secondCell = screen.getByLabelText('Row 1, column 2: empty');
    await waitFor(() => expect(secondCell).toHaveAttribute('aria-disabled', 'true'));
    secondCell.focus();
    expect(
      (await screen.findAllByText("Move sent — waiting for the agent's reply")).length
    ).toBeGreaterThan(0);
    // The move posts back with its payload.
    expect(mockTransport.sendUiAction).toHaveBeenCalledWith('sess-1', {
      actionId: 'm-0-0',
      payload: { glyph: 'X' },
      widgetTitle: 'Tic-Tac-Toe',
    });
  });

  it('reverts the optimistic mark and un-latches when the POST fails', async () => {
    const user = userEvent.setup();
    const { toast } = await import('sonner');
    mockTransport.sendUiAction = vi.fn().mockRejectedValue(new Error('busy'));
    renderBoard({
      type: 'board',
      rows: [[{ action: { kind: 'agent', id: 'm-0-0', payload: { glyph: 'X' } } }]],
    });

    await user.click(screen.getByLabelText('Row 1, column 1: empty — play here'));
    // After the failure settles, the cell is playable again and a toast fired.
    await waitFor(() =>
      expect(screen.getByLabelText('Row 1, column 1: empty — play here')).toBeInTheDocument()
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't send the move", expect.anything());
  });
});

describe('BoardNode superseded state', () => {
  it('renders agent cells inert with an explanatory tooltip when not the latest message', async () => {
    renderBoard(
      {
        type: 'board',
        rows: [[{ action: { kind: 'agent', id: 'm-0-0', payload: { glyph: 'X' } } }]],
      },
      { isLatestMessage: false }
    );
    const cell = screen.getByLabelText('Row 1, column 1: empty');
    expect(cell).toHaveAttribute('aria-disabled', 'true');
    // aria-disabled (not `disabled`) keeps the cell focusable, so the Radix
    // tooltip explanation is keyboard-reachable.
    cell.focus();
    expect(
      (await screen.findAllByText('Superseded — use the latest widget')).length
    ).toBeGreaterThan(0);
  });
});

describe('BoardNode sizing', () => {
  it('sizes small boards up and keeps large boards compact', () => {
    const { rerender } = renderBoard({
      type: 'board',
      rows: [[{ glyph: 'X' }, { glyph: 'O' }]],
    });
    expect(screen.getByRole('grid')).toHaveStyle({
      gridTemplateColumns: 'repeat(2, minmax(0, 3.25rem))',
    });

    rerender(
      <WidgetRenderer
        document={{
          version: 1,
          title: 'Wide',
          root: { type: 'board', rows: [Array.from({ length: 5 }, () => ({ glyph: 'X' }))] },
        }}
        sessionId="sess-1"
      />
    );
    expect(screen.getByRole('grid')).toHaveStyle({
      gridTemplateColumns: 'repeat(5, minmax(0, 2.5rem))',
    });
  });
});

describe('BoardNode win line', () => {
  it('draws a victory stroke when a line completes', () => {
    const { container } = renderBoard({
      type: 'board',
      rows: [
        [{ glyph: 'X' }, { glyph: 'X' }, { glyph: 'X' }],
        [{ glyph: 'O' }, { glyph: 'O' }, {}],
        [{}, {}, {}],
      ],
    });
    expect(container.querySelector('svg line')).not.toBeNull();
  });

  it('draws no victory stroke for an unfinished board', () => {
    const { container } = renderBoard({
      type: 'board',
      rows: [
        [{ glyph: 'X' }, { glyph: 'O' }, { glyph: 'X' }],
        [{ glyph: 'O' }, {}, {}],
        [{}, {}, {}],
      ],
    });
    expect(container.querySelector('svg line')).toBeNull();
  });
});

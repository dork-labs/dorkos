/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { TransportProvider, useAppStore, useIsMobile } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { WidgetFence } from '../ui/WidgetFence';

// Keep the real store (so openPip actually runs) but let each test control the
// mobile flag directly — same pattern as PipHost.test.tsx / McpAppBlock.test.tsx.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: vi.fn(() => false) };
});

afterEach(cleanup);

const mockTransport = createMockTransport();
function Wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
}

const WEATHER = JSON.stringify({
  version: 1,
  root: { type: 'stat', label: 'Temp', value: '64°F' },
});

const BOARD_WITH_ACTION = JSON.stringify({
  version: 1,
  title: 'Tic-Tac-Toe',
  root: {
    type: 'board',
    rows: [[{ action: { kind: 'agent', id: 'm-0-0', payload: { glyph: 'X' } } }]],
  },
});

const POP_OUT_LABEL = /pop out into a floating window/i;

describe('WidgetFence streaming stability', () => {
  it('shows a skeleton while the fence is incomplete', () => {
    render(<WidgetFence code="{ partial" isIncomplete />);
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();
  });

  it('renders the widget once the fence completes', () => {
    render(<WidgetFence code={WEATHER} isIncomplete={false} />, { wrapper: Wrapper });
    expect(screen.getByText('Temp')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading widget')).not.toBeInTheDocument();
  });

  it('does not flicker back to a skeleton when isIncomplete flips true after a good render', () => {
    const { rerender } = render(<WidgetFence code={WEATHER} isIncomplete={false} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('Temp')).toBeInTheDocument();

    // Streamdown re-parses and momentarily reports the fence as incomplete again.
    rerender(<WidgetFence code="{ truncated" isIncomplete />);
    expect(screen.getByText('Temp')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading widget')).not.toBeInTheDocument();
  });

  it('shows the error card when a completed fence never parsed', () => {
    render(<WidgetFence code="{ not valid json" isIncomplete={false} />);
    expect(screen.queryByText('Temp')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Loading widget')).not.toBeInTheDocument();
  });

  it('holds the skeleton (never the error card) for truncated JSON while the message streams', () => {
    // A chunk boundary can close the fence (`isIncomplete: false`) with the
    // JSON still truncated — mid-stream that must read as "still loading".
    render(<WidgetFence code='{"version": 1, "root": {"type"' isIncomplete={false} isStreaming />);
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();
    expect(screen.queryByText("This widget couldn't be rendered")).not.toBeInTheDocument();
  });

  it('settles a still-invalid fence into the error card once streaming ends', () => {
    const truncated = '{"version": 1, "root": {"type"';
    const { rerender } = render(<WidgetFence code={truncated} isIncomplete={false} isStreaming />);
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();

    // The turn settles and the JSON never completed — now it is a real error.
    rerender(<WidgetFence code={truncated} isIncomplete={false} isStreaming={false} />);
    expect(screen.getByText("This widget couldn't be rendered")).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading widget')).not.toBeInTheDocument();
  });

  it('renders the widget when the streaming fence completes into valid JSON', () => {
    const { rerender } = render(
      <WidgetFence code='{"version": 1, "root"' isIncomplete={false} isStreaming />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();

    rerender(<WidgetFence code={WEATHER} isIncomplete={false} isStreaming />);
    expect(screen.getByText('Temp')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading widget')).not.toBeInTheDocument();
  });
});

describe('WidgetFence pop-out (PIP) affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useIsMobile).mockReturnValue(false);
    useAppStore.setState({ pipContent: null });
  });

  it('shows the pop-out button on a parsed document when a sessionId is given', () => {
    render(<WidgetFence code={WEATHER} isIncomplete={false} sessionId="s1" />, {
      wrapper: Wrapper,
    });
    expect(screen.getByRole('button', { name: POP_OUT_LABEL })).toBeInTheDocument();
  });

  it('hides the pop-out button when sessionId is omitted, even with a parsed document', () => {
    render(<WidgetFence code={WEATHER} isIncomplete={false} />, { wrapper: Wrapper });
    expect(screen.getByText('Temp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: POP_OUT_LABEL })).not.toBeInTheDocument();
  });

  it('hides the pop-out button on mobile, where the PIP host renders nothing', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    render(<WidgetFence code={WEATHER} isIncomplete={false} sessionId="s1" />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('Temp')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: POP_OUT_LABEL })).not.toBeInTheDocument();
  });

  it('hides the pop-out button before a successful parse (skeleton, no latched document yet)', () => {
    render(<WidgetFence code="{ partial" isIncomplete sessionId="s1" />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: POP_OUT_LABEL })).not.toBeInTheDocument();
  });

  it('calls openPip with the exact widget descriptor when clicked, falling back to "Widget" with no document title', async () => {
    const user = userEvent.setup();
    const openPipSpy = vi.spyOn(useAppStore.getState(), 'openPip');
    render(<WidgetFence code={WEATHER} isIncomplete={false} sessionId="s1" />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: POP_OUT_LABEL }));

    expect(openPipSpy).toHaveBeenCalledWith({ kind: 'widget', sessionId: 's1', title: 'Widget' });
    expect(useAppStore.getState().pipContent).toEqual({
      kind: 'widget',
      sessionId: 's1',
      title: 'Widget',
    });
  });

  it('calls openPip with the document title when one is set', async () => {
    const user = userEvent.setup();
    const openPipSpy = vi.spyOn(useAppStore.getState(), 'openPip');
    render(<WidgetFence code={BOARD_WITH_ACTION} isIncomplete={false} sessionId="s1" />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: POP_OUT_LABEL }));

    expect(openPipSpy).toHaveBeenCalledWith({
      kind: 'widget',
      sessionId: 's1',
      title: 'Tic-Tac-Toe',
    });
  });

  it('does not dispatch a widget action when the pop-out button is clicked, proving it sits outside the interactive subtree', async () => {
    const user = userEvent.setup();
    mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: 's1' });
    render(<WidgetFence code={BOARD_WITH_ACTION} isIncomplete={false} sessionId="s1" />, {
      wrapper: Wrapper,
    });

    await user.click(screen.getByRole('button', { name: POP_OUT_LABEL }));

    expect(mockTransport.sendUiAction).not.toHaveBeenCalled();
    // The board cell underneath is untouched — still playable.
    expect(screen.getByLabelText('Row 1, column 1: empty — play here')).toBeInTheDocument();
  });

  it('keeps the widget tree node identity stable when the affordance appears alongside it', () => {
    const { rerender } = render(<WidgetFence code={WEATHER} isIncomplete={false} />, {
      wrapper: Wrapper,
    });
    const before = screen.getByText('Temp');
    expect(screen.queryByRole('button', { name: POP_OUT_LABEL })).not.toBeInTheDocument();

    // Same fence, now with a sessionId — the pop-out affordance appears, but the
    // widget subtree itself must not remount (no fresh DOM node, no lost state).
    rerender(<WidgetFence code={WEATHER} isIncomplete={false} sessionId="s1" />);

    expect(screen.getByRole('button', { name: POP_OUT_LABEL })).toBeInTheDocument();
    expect(screen.getByText('Temp')).toBe(before);
  });

  it('places the pop-out button as a DOM sibling of the widget tree, not a descendant', () => {
    const { container } = render(
      <WidgetFence code={WEATHER} isIncomplete={false} sessionId="s1" />,
      { wrapper: Wrapper }
    );
    const wrapper = container.firstElementChild;
    expect(wrapper).not.toBeNull();
    const button = screen.getByRole('button', { name: POP_OUT_LABEL });
    // The button is a direct child of the fence wrapper, not nested inside the
    // <section> the widget renderer produces.
    expect(button.parentElement).toBe(wrapper);
    expect(
      within(wrapper as HTMLElement)
        .getByText('Temp')
        .closest('button')
    ).toBeNull();
  });
});

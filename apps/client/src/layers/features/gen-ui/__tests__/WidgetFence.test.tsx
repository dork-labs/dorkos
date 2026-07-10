/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { WidgetFence } from '../ui/WidgetFence';

afterEach(cleanup);

const mockTransport = createMockTransport();
function Wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
}

const WEATHER = JSON.stringify({
  version: 1,
  root: { type: 'stat', label: 'Temp', value: '64°F' },
});

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
    render(<WidgetFence code='{"version": 1, "root": {"type"' isIncomplete={false} streaming />);
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();
    expect(screen.queryByText("This widget couldn't be rendered")).not.toBeInTheDocument();
  });

  it('settles a still-invalid fence into the error card once streaming ends', () => {
    const truncated = '{"version": 1, "root": {"type"';
    const { rerender } = render(<WidgetFence code={truncated} isIncomplete={false} streaming />);
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();

    // The turn settles and the JSON never completed — now it is a real error.
    rerender(<WidgetFence code={truncated} isIncomplete={false} streaming={false} />);
    expect(screen.getByText("This widget couldn't be rendered")).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading widget')).not.toBeInTheDocument();
  });

  it('renders the widget when the streaming fence completes into valid JSON', () => {
    const { rerender } = render(
      <WidgetFence code='{"version": 1, "root"' isIncomplete={false} streaming />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText('Loading widget')).toBeInTheDocument();

    rerender(<WidgetFence code={WEATHER} isIncomplete={false} streaming />);
    expect(screen.getByText('Temp')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading widget')).not.toBeInTheDocument();
  });
});

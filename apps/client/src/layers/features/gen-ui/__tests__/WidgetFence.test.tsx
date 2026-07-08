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
    const { rerender } = render(<WidgetFence code={WEATHER} isIncomplete={false} />, { wrapper: Wrapper });
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
});

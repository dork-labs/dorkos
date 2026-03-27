// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TunnelConnected } from '../ui/TunnelConnected';

// Mock QRCode to avoid canvas/SVG rendering issues in jsdom
vi.mock('react-qr-code', () => ({
  default: ({ value }: { value: string }) => <div data-testid="qr-code">{value}</div>,
}));

// Mock motion/react so AnimatePresence renders immediately
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        return ({ children, ...rest }: Record<string, unknown>) => {
          const htmlProps: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rest)) {
            if (
              ![
                'variants',
                'initial',
                'animate',
                'exit',
                'transition',
                'onAnimationComplete',
              ].includes(k)
            ) {
              htmlProps[k] = v;
            }
          }
          const Tag = prop as keyof React.JSX.IntrinsicElements;
          // @ts-expect-error — dynamic tag rendering for test mock
          return <Tag {...htmlProps}>{children}</Tag>;
        };
      },
    }
  ),
}));

const mockClipboardWriteText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mockClipboardWriteText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockClipboardWriteText.mockClear();
  cleanup();
});

const defaultProps = {
  url: 'https://abc123.ngrok.io',
  activeSessionId: null,
  latencyMs: null,
};

describe('TunnelConnected', () => {
  it('renders the connected container', () => {
    render(<TunnelConnected {...defaultProps} />);
    expect(screen.getByTestId('tunnel-connected')).toBeInTheDocument();
  });

  it('displays the tunnel hostname in the URL card', () => {
    render(<TunnelConnected {...defaultProps} />);
    expect(screen.getByText('abc123.ngrok.io')).toBeInTheDocument();
  });

  it('renders Copy URL button', () => {
    render(<TunnelConnected {...defaultProps} />);
    expect(screen.getByText('Copy URL')).toBeInTheDocument();
  });

  it('copies the tunnel URL when Copy URL is clicked', () => {
    render(<TunnelConnected {...defaultProps} />);
    fireEvent.click(screen.getByText('Copy URL'));
    expect(mockClipboardWriteText).toHaveBeenCalledWith('https://abc123.ngrok.io');
  });

  it('shows QR code when QR button is toggled', () => {
    render(<TunnelConnected {...defaultProps} />);
    expect(screen.queryByTestId('qr-code')).toBeNull();
    fireEvent.click(screen.getByLabelText('Toggle QR code'));
    expect(screen.getByTestId('qr-code')).toBeInTheDocument();
  });

  it('does not render session link button when activeSessionId is null', () => {
    render(<TunnelConnected {...defaultProps} />);
    expect(screen.queryByText('Session link')).toBeNull();
  });

  it('renders session link button when activeSessionId is provided', () => {
    render(<TunnelConnected {...defaultProps} activeSessionId="sess-abc123" />);
    expect(screen.getByText('Session link')).toBeInTheDocument();
  });

  it('copies the session URL when session link button is clicked', () => {
    render(<TunnelConnected {...defaultProps} activeSessionId="sess-abc123" />);
    fireEvent.click(screen.getByText('Session link'));
    expect(mockClipboardWriteText).toHaveBeenCalledWith(
      'https://abc123.ngrok.io?session=sess-abc123'
    );
  });

  it('renders latency badge when latencyMs is provided', () => {
    render(<TunnelConnected {...defaultProps} latencyMs={42} />);
    expect(screen.getByText('42ms')).toBeInTheDocument();
  });

  it('does not render latency badge when latencyMs is null', () => {
    render(<TunnelConnected {...defaultProps} />);
    expect(screen.queryByText(/\d+ms/)).toBeNull();
  });

  it('renders latency dot with aria-label', () => {
    render(<TunnelConnected {...defaultProps} latencyMs={150} />);
    expect(screen.getByLabelText('150ms latency')).toBeInTheDocument();
  });

  it('renders latency dot with unknown label when null', () => {
    render(<TunnelConnected {...defaultProps} latencyMs={null} />);
    expect(screen.getByLabelText('Latency unknown')).toBeInTheDocument();
  });
});

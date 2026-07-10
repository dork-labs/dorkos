/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { StreamingText } from '../StreamingText';

const mockTransport = createMockTransport();

/** Fenced widgets need a Transport in context (agent actions POST through it). */
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

const widgetFence = [
  'Here is the weather:',
  '',
  '```dorkos-ui',
  JSON.stringify({
    version: 1,
    root: { type: 'stat', label: 'San Francisco', value: '64°F' },
  }),
  '```',
  '',
  'Anything else?',
].join('\n');

describe('StreamingText dorkos-ui fence', () => {
  it('renders a dorkos-ui fence as a native widget, not a code block', async () => {
    render(<StreamingText content={widgetFence} />, { wrapper: Wrapper });
    // The widget renders from the fence…
    expect(await screen.findByText('San Francisco')).toBeInTheDocument();
    expect(screen.getByText('64°F')).toBeInTheDocument();
    // …and the surrounding prose still renders.
    expect(screen.getByText('Here is the weather:')).toBeInTheDocument();
  });

  it('shows the loading skeleton for an unclosed fence mid-stream (D3)', async () => {
    const unclosed = [
      'Fetching the weather…',
      '',
      '```dorkos-ui',
      '{ "version": 1, "root": { "type": "stat", "label": "San Fra',
    ].join('\n');
    render(<StreamingText content={unclosed} isStreaming />);
    expect(await screen.findByLabelText('Loading widget')).toBeInTheDocument();
    // The partial JSON never renders as widget content or an error card.
    expect(screen.queryByText("This widget couldn't be rendered")).not.toBeInTheDocument();
  });

  it('holds the skeleton for a closed-but-truncated fence while the message streams', async () => {
    // The mid-stream flicker scenario: a chunk boundary closes the fence
    // (Streamdown reports it complete) while the JSON is still truncated.
    // Through the real pipeline, isStreaming must reach the fence and hold
    // the skeleton — never flash the error card.
    const truncatedClosed = [
      'Your move:',
      '',
      '```dorkos-ui',
      '{ "version": 1, "root": { "type": "board", "rows": [["X", "O"',
      '```',
    ].join('\n');
    render(<StreamingText content={truncatedClosed} isStreaming />, { wrapper: Wrapper });
    expect(await screen.findByLabelText('Loading widget')).toBeInTheDocument();
    expect(screen.queryByText("This widget couldn't be rendered")).not.toBeInTheDocument();
  });

  it('settles a closed-but-truncated fence into the error card once streaming ends', async () => {
    const truncatedClosed = ['```dorkos-ui', '{ "version": 1, "root": { "type"', '```'].join('\n');
    const { rerender } = render(<StreamingText content={truncatedClosed} isStreaming />, {
      wrapper: Wrapper,
    });
    expect(await screen.findByLabelText('Loading widget')).toBeInTheDocument();

    // The turn ends; the JSON never completed — now it is genuinely broken.
    rerender(<StreamingText content={truncatedClosed} isStreaming={false} />);
    expect(await screen.findByText("This widget couldn't be rendered")).toBeInTheDocument();
  });

  it('renders multiple dorkos-ui fences in one message independently', async () => {
    const twoFences = [
      'First:',
      '',
      '```dorkos-ui',
      JSON.stringify({ version: 1, root: { type: 'stat', label: 'CPU', value: '42%' } }),
      '```',
      '',
      'Second:',
      '',
      '```dorkos-ui',
      JSON.stringify({ version: 1, root: { type: 'badge', text: 'healthy', tone: 'success' } }),
      '```',
    ].join('\n');
    render(<StreamingText content={twoFences} />, { wrapper: Wrapper });
    expect(await screen.findByText('CPU')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });
});

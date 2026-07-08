/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StreamingText } from '../StreamingText';

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
    render(<StreamingText content={widgetFence} />);
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
    render(<StreamingText content={twoFences} />);
    expect(await screen.findByText('CPU')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });
});

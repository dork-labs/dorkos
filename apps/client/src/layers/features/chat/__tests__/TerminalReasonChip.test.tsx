/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TerminalReasonChip } from '../ui/status/TerminalReasonChip';

afterEach(cleanup);

describe('TerminalReasonChip', () => {
  // Purpose: when no reason is set, the chip must render nothing — no empty
  // Badge, no placeholder. Verifies the default no-op path.
  it('renders nothing when terminalReason is undefined', () => {
    const { container } = render(<TerminalReasonChip terminalReason={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Purpose: `'completed'` is the success case and must never show a chip.
  // Guards against accidentally labelling clean completions as terminations.
  it('renders nothing when terminalReason is "completed"', () => {
    const { container } = render(<TerminalReasonChip terminalReason="completed" />);
    expect(container).toBeEmptyDOMElement();
  });

  // Purpose: each curated label from the copy table must render exactly
  // as specified. Driven table-style so new SDK reasons can be added without
  // adding a new test block.
  it.each([
    ['aborted_tools', 'Tool aborted'],
    ['aborted_streaming', 'Stream aborted'],
    ['max_turns', 'Max turns reached'],
    ['blocking_limit', 'Blocking limit'],
    ['rapid_refill_breaker', 'Rate limit'],
    ['prompt_too_long', 'Prompt too long'],
    ['image_error', 'Image error'],
    ['model_error', 'Model error'],
    ['stop_hook_prevented', 'Stopped by hook'],
    ['hook_stopped', 'Hook stopped'],
    ['tool_deferred', 'Tool deferred'],
  ] as const)('renders label "%s" → "%s"', (reason, expected) => {
    render(<TerminalReasonChip terminalReason={reason} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  // Purpose: forward-compat — when the SDK adds a future reason the
  // TerminalReasonSchema's string fallback accepts it; the component must
  // humanise it rather than crash or render the raw snake_case.
  it('humanises unknown raw string reasons (forward-compat)', () => {
    render(<TerminalReasonChip terminalReason="some_future_reason" />);
    expect(screen.getByText('Some future reason')).toBeInTheDocument();
  });

  // Purpose: the chip surfaces a screen-reader context prefix so assistive
  // tech announces "Session ended: …" rather than just the bare label.
  it('exposes an aria-label with "Session ended:" prefix', () => {
    render(<TerminalReasonChip terminalReason="max_turns" />);
    expect(screen.getByLabelText('Session ended: Max turns reached')).toBeInTheDocument();
  });

  // Purpose: stable test id is part of the component's test contract —
  // higher-level integration tests can key off it without relying on text.
  it('exposes data-testid="terminal-reason-chip" when visible', () => {
    render(<TerminalReasonChip terminalReason="model_error" />);
    expect(screen.getByTestId('terminal-reason-chip')).toBeInTheDocument();
  });
});

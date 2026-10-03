/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineKillButton } from '../InlineKillButton';

afterEach(cleanup);

describe('InlineKillButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onConfirm immediately for bash tasks', () => {
    const onConfirm = vi.fn();
    render(<InlineKillButton taskType="bash" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not show Stop? confirmation for bash tasks', () => {
    render(<InlineKillButton taskType="bash" onConfirm={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText('Stop?')).not.toBeInTheDocument();
  });

  it('shows Stop? confirmation on first click for agent tasks', () => {
    const onConfirm = vi.fn();
    render(<InlineKillButton taskType="agent" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText('Stop?')).toBeInTheDocument();
  });

  it('calls onConfirm on second click for agent tasks', () => {
    const onConfirm = vi.fn();
    render(<InlineKillButton taskType="agent" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Stop?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Stop?'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('auto-dismisses confirmation after 3 seconds', () => {
    const onConfirm = vi.fn();
    render(<InlineKillButton taskType="agent" onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Stop?')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText('Stop?')).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('has aria-label "Stop task" in idle state', () => {
    render(<InlineKillButton taskType="agent" onConfirm={vi.fn()} />);
    expect(screen.getByLabelText('Stop task')).toBeInTheDocument();
  });

  it('has aria-label "Press again to stop task" in confirming state', () => {
    render(<InlineKillButton taskType="agent" onConfirm={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByLabelText('Press again to stop task')).toBeInTheDocument();
  });

  it('is keyboard accessible with Enter key', () => {
    const onConfirm = vi.fn();
    render(<InlineKillButton taskType="bash" onConfirm={onConfirm} />);

    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('is keyboard accessible with Space key', () => {
    const onConfirm = vi.fn();
    render(<InlineKillButton taskType="bash" onConfirm={onConfirm} />);

    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: ' ' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

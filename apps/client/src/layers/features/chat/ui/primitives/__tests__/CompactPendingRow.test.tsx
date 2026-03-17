// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { CompactPendingRow } from '../CompactPendingRow';

afterEach(() => {
  cleanup();
});

describe('CompactPendingRow', () => {
  it('renders "Waiting for approval..." for approval type', () => {
    render(<CompactPendingRow type="approval" />);
    expect(screen.getByText('Waiting for approval...')).toBeDefined();
  });

  it('renders "Answering questions..." for question type', () => {
    render(<CompactPendingRow type="question" />);
    expect(screen.getByText('Answering questions...')).toBeDefined();
  });

  it('renders a spinning loader icon', () => {
    const { container } = render(<CompactPendingRow type="approval" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeDefined();
    expect(svg?.classList.contains('animate-spin')).toBe(true);
  });

  it('passes data-testid through', () => {
    render(<CompactPendingRow type="approval" data-testid="pending-row" />);
    expect(screen.getByTestId('pending-row')).toBeDefined();
  });

  it('uses compact styling matching CompactResultRow footprint', () => {
    const { container } = render(<CompactPendingRow type="approval" />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('bg-muted/50');
    expect(wrapper.className).toContain('rounded-msg-tool');
    expect(wrapper.className).toContain('border');
  });
});

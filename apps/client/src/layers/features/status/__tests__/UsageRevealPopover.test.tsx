// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { UsageRevealPopover } from '../ui/UsageRevealPopover';

beforeAll(() => {
  // Radix Popover positioning touches these in jsdom.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

describe('UsageRevealPopover (DOR-109 /context)', () => {
  it('shows the honest empty state when the session has no usage yet', () => {
    // A cold session (e.g. Codex before any turn) has no usage — never a blank popover.
    render(<UsageRevealPopover usage={null} open onOpenChange={vi.fn()} />);
    expect(screen.getByText('No usage data for this session yet.')).toBeInTheDocument();
  });

  it('shows the honest empty state when usage carries no renderable metric', () => {
    render(<UsageRevealPopover usage={{ kind: 'pay-as-you-go' }} open onOpenChange={vi.fn()} />);
    expect(screen.getByText('No usage data for this session yet.')).toBeInTheDocument();
  });

  it('reveals the usage & cost detail when the session has usage', () => {
    render(
      <UsageRevealPopover
        usage={{ kind: 'subscription', utilization: 0.5, costUsd: 0.42 }}
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText('Subscription Usage')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('$0.42')).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    render(<UsageRevealPopover usage={null} open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByText('No usage data for this session yet.')).not.toBeInTheDocument();
  });
});

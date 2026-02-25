/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AdapterCard } from '../ui/AdapterCard';
import type { AdapterListItem } from '@dorkos/shared/transport';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const connectedItem: AdapterListItem = {
  config: {
    id: 'tg-main',
    type: 'telegram',
    enabled: true,
    config: { token: 'xxx', mode: 'polling' },
  },
  status: {
    id: 'tg-main',
    type: 'telegram',
    displayName: 'Main Telegram',
    state: 'connected',
    messageCount: { inbound: 42, outbound: 18 },
    errorCount: 0,
  },
};

const errorItem: AdapterListItem = {
  config: {
    id: 'wh-alerts',
    type: 'webhook',
    enabled: true,
    config: {
      inbound: { subject: 'relay.alerts', secret: 'abcdefghijklmnop' },
      outbound: { url: 'https://example.com/hook', secret: 'abcdefghijklmnop' },
    },
  },
  status: {
    id: 'wh-alerts',
    type: 'webhook',
    displayName: 'Alerts Webhook',
    state: 'error',
    messageCount: { inbound: 5, outbound: 0 },
    errorCount: 3,
    lastError: 'Connection timed out',
  },
};

const disabledItem: AdapterListItem = {
  config: { ...connectedItem.config, enabled: false },
  status: { ...connectedItem.status, state: 'disconnected' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the adapter display name', () => {
    render(<AdapterCard item={connectedItem} onToggle={vi.fn()} />);

    expect(screen.getByText('Main Telegram')).toBeTruthy();
  });

  it('renders the adapter type badge', () => {
    render(<AdapterCard item={connectedItem} onToggle={vi.fn()} />);

    expect(screen.getByText('telegram')).toBeTruthy();
  });

  it('shows a green dot for connected state', () => {
    const { container } = render(<AdapterCard item={connectedItem} onToggle={vi.fn()} />);

    const dot = container.querySelector('.bg-green-500');
    expect(dot).toBeTruthy();
  });

  it('shows a red dot for error state', () => {
    const { container } = render(<AdapterCard item={errorItem} onToggle={vi.fn()} />);

    const dot = container.querySelector('.bg-red-500');
    expect(dot).toBeTruthy();
  });

  it('shows a gray dot for disconnected state', () => {
    const { container } = render(<AdapterCard item={disabledItem} onToggle={vi.fn()} />);

    const dot = container.querySelector('.bg-gray-400');
    expect(dot).toBeTruthy();
  });

  it('displays inbound and outbound message counts', () => {
    render(<AdapterCard item={connectedItem} onToggle={vi.fn()} />);

    expect(screen.getByText(/In: 42/)).toBeTruthy();
    expect(screen.getByText(/Out: 18/)).toBeTruthy();
  });

  it('does not show error count when errorCount is 0', () => {
    render(<AdapterCard item={connectedItem} onToggle={vi.fn()} />);

    expect(screen.queryByText(/Errors:/)).toBeNull();
  });

  it('shows error count when errorCount is greater than 0', () => {
    render(<AdapterCard item={errorItem} onToggle={vi.fn()} />);

    expect(screen.getByText(/Errors: 3/)).toBeTruthy();
  });

  it('shows lastError message when present', () => {
    render(<AdapterCard item={errorItem} onToggle={vi.fn()} />);

    expect(screen.getByText('Connection timed out')).toBeTruthy();
  });

  it('does not show lastError section when lastError is absent', () => {
    render(<AdapterCard item={connectedItem} onToggle={vi.fn()} />);

    expect(screen.queryByText('Connection timed out')).toBeNull();
  });

  it('renders switch in checked state when adapter is enabled', () => {
    render(<AdapterCard item={connectedItem} onToggle={vi.fn()} />);

    const switchEl = screen.getByRole('switch');
    expect(switchEl.getAttribute('data-state')).toBe('checked');
  });

  it('renders switch in unchecked state when adapter is disabled', () => {
    render(<AdapterCard item={disabledItem} onToggle={vi.fn()} />);

    const switchEl = screen.getByRole('switch');
    expect(switchEl.getAttribute('data-state')).toBe('unchecked');
  });

  it('calls onToggle with true when switch is clicked while disabled', () => {
    const onToggle = vi.fn();

    render(<AdapterCard item={disabledItem} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('calls onToggle with false when switch is clicked while enabled', () => {
    const onToggle = vi.fn();

    render(<AdapterCard item={connectedItem} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('switch'));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('falls back to config.id when displayName is empty', () => {
    const itemWithNoDisplayName: AdapterListItem = {
      ...connectedItem,
      status: { ...connectedItem.status, displayName: '' },
    };

    render(<AdapterCard item={itemWithNoDisplayName} onToggle={vi.fn()} />);

    expect(screen.getByText('tg-main')).toBeTruthy();
  });
});

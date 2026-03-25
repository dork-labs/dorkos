/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CatalogCard } from '../CatalogCard';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

// Mock adapter logos — renders a simple span with the component name for testability
vi.mock('@dorkos/icons/adapter-logos', () => ({
  ADAPTER_LOGO_MAP: {
    slack: ({ className }: { size?: number; className?: string }) => (
      <span data-testid="adapter-logo" data-icon="slack" className={className}>
        SlackIcon
      </span>
    ),
  },
}));

const baseManifest: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Connect to Slack for messaging',
  category: 'messaging',
  builtin: true,
  configFields: [],
  multiInstance: false,
};

describe('CatalogCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders adapter display name and description', () => {
    render(<CatalogCard manifest={baseManifest} onAdd={vi.fn()} />);

    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('Connect to Slack for messaging')).toBeInTheDocument();
  });

  it('renders category badge', () => {
    render(<CatalogCard manifest={baseManifest} onAdd={vi.fn()} />);

    expect(screen.getByText('messaging')).toBeInTheDocument();
  });

  it('renders adapter icon when iconId is provided', () => {
    const manifest: AdapterManifest = { ...baseManifest, iconId: 'slack' };
    render(<CatalogCard manifest={manifest} onAdd={vi.fn()} />);

    expect(screen.getByTestId('adapter-logo')).toBeInTheDocument();
  });

  it('renders fallback icon when adapter type is unknown', () => {
    const manifest: AdapterManifest = { ...baseManifest, type: 'unknown-adapter' };
    render(<CatalogCard manifest={manifest} onAdd={vi.fn()} />);

    // Falls back to Bot icon (no adapter-logo testid for unknown types)
    expect(screen.queryByTestId('adapter-logo')).not.toBeInTheDocument();
  });

  it('calls onAdd when the Add button is clicked', () => {
    const onAdd = vi.fn();
    render(<CatalogCard manifest={baseManifest} onAdd={onAdd} />);

    fireEvent.click(screen.getByRole('button', { name: /add/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('applies messaging category color classes', () => {
    render(<CatalogCard manifest={baseManifest} onAdd={vi.fn()} />);

    // Badge is a <div> — select the element that directly contains the text
    const badge = screen.getByText('messaging', { selector: 'div' });
    expect(badge).toHaveClass('bg-blue-100');
    expect(badge).toHaveClass('text-blue-800');
  });

  it('applies automation category color classes', () => {
    const manifest: AdapterManifest = { ...baseManifest, category: 'automation' };
    render(<CatalogCard manifest={manifest} onAdd={vi.fn()} />);

    const badge = screen.getByText('automation', { selector: 'div' });
    expect(badge).toHaveClass('bg-purple-100');
    expect(badge).toHaveClass('text-purple-800');
  });

  it('applies internal category color classes', () => {
    const manifest: AdapterManifest = { ...baseManifest, category: 'internal' };
    render(<CatalogCard manifest={manifest} onAdd={vi.fn()} />);

    const badge = screen.getByText('internal', { selector: 'div' });
    expect(badge).toHaveClass('bg-gray-100');
    expect(badge).toHaveClass('text-gray-800');
  });

  it('applies custom category color classes', () => {
    const manifest: AdapterManifest = { ...baseManifest, category: 'custom' };
    render(<CatalogCard manifest={manifest} onAdd={vi.fn()} />);

    const badge = screen.getByText('custom', { selector: 'div' });
    expect(badge).toHaveClass('bg-green-100');
    expect(badge).toHaveClass('text-green-800');
  });
});

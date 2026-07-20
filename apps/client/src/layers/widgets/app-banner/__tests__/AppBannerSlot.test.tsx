/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AppBannerSlot } from '../ui/AppBannerSlot';
import { BANNER_PRIORITY, type BannerDescriptor } from '../model/banner-descriptor';

// motion reads matchMedia (reduced-motion) which jsdom does not implement.
beforeAll(() => {
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

/** A minimal descriptor whose rendered banner is identifiable by text. */
function fakeDescriptor(id: string, variant: BannerDescriptor['variant']): BannerDescriptor {
  return {
    id,
    variant,
    priority: BANNER_PRIORITY[variant],
    render: () => <div>{id} banner</div>,
  };
}

describe('AppBannerSlot', () => {
  it('renders nothing when no descriptors are eligible', () => {
    const { container } = render(<AppBannerSlot descriptors={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the sole eligible banner', () => {
    render(<AppBannerSlot descriptors={[fakeDescriptor('telemetry', 'neutral')]} />);
    expect(screen.getByText('telemetry banner')).toBeInTheDocument();
  });

  it('shows the highest-priority banner and hides the rest (warning beats neutral)', () => {
    render(
      <AppBannerSlot
        descriptors={[
          fakeDescriptor('telemetry', 'neutral'),
          fakeDescriptor('permission', 'warning'),
        ]}
      />
    );
    expect(screen.getByText('permission banner')).toBeInTheDocument();
    expect(screen.queryByText('telemetry banner')).not.toBeInTheDocument();
  });

  it('swaps to the higher-priority banner when one becomes eligible, and back when it resolves', async () => {
    const neutral = fakeDescriptor('telemetry', 'neutral');
    const warning = fakeDescriptor('permission', 'warning');

    const { rerender } = render(<AppBannerSlot descriptors={[neutral]} />);
    expect(screen.getByText('telemetry banner')).toBeInTheDocument();

    // A warning appears — it outranks the neutral banner. The swap is
    // exit-before-enter (mode="wait"), so wait for the new banner to mount.
    rerender(<AppBannerSlot descriptors={[neutral, warning]} />);
    expect(await screen.findByText('permission banner')).toBeInTheDocument();
    expect(screen.queryByText('telemetry banner')).not.toBeInTheDocument();

    // The warning resolves — the neutral banner returns.
    rerender(<AppBannerSlot descriptors={[neutral]} />);
    await waitFor(() => expect(screen.getByText('telemetry banner')).toBeInTheDocument());
    expect(screen.queryByText('permission banner')).not.toBeInTheDocument();
  });
});

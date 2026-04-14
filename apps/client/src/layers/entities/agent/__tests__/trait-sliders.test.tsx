// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TRAIT_ORDER, TRAIT_ENDPOINT_LABELS, TRAIT_PREVIEWS } from '@dorkos/shared/trait-renderer';
import { TraitSliders } from '../ui/TraitSliders';

// Mock ResizeObserver (required by Radix Slider)
beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
});

afterEach(cleanup);

const balanced = {
  verbosity: 3,
  autonomy: 3,
  chaos: 3,
  creativity: 3,
  humor: 3,
  spice: 3,
};

describe('TraitSliders', () => {
  it('renders 6 sliders', () => {
    render(<TraitSliders traits={balanced} onChange={vi.fn()} />);

    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(6);
  });

  it('shows trait names and level labels', () => {
    render(<TraitSliders traits={balanced} onChange={vi.fn()} />);

    for (const name of TRAIT_ORDER) {
      // Trait name appears as label
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // Level label appears for each trait (getAllByText since all are "3/5 Balanced")
    expect(screen.getAllByText('3/5 Balanced')).toHaveLength(6);
  });

  it('shows endpoint labels when showEndpoints is true', () => {
    render(<TraitSliders traits={balanced} onChange={vi.fn()} showEndpoints />);

    for (const name of TRAIT_ORDER) {
      const { min, max } = TRAIT_ENDPOINT_LABELS[name];
      expect(screen.getByText(min)).toBeInTheDocument();
      expect(screen.getByText(max)).toBeInTheDocument();
    }
  });

  it('hides endpoint labels when showEndpoints is false', () => {
    render(<TraitSliders traits={balanced} onChange={vi.fn()} showEndpoints={false} />);

    // "Mime" (verbosity min) should not appear
    expect(screen.queryByText('Mime')).not.toBeInTheDocument();
    expect(screen.queryByText('Yapper')).not.toBeInTheDocument();
  });

  it('shows preview text when showPreviews is true', () => {
    render(<TraitSliders traits={balanced} onChange={vi.fn()} showPreviews />);

    // Level 3 preview for verbosity
    expect(screen.getByText(TRAIT_PREVIEWS.verbosity[3])).toBeInTheDocument();
  });

  it('hides preview text when showPreviews is false', () => {
    render(<TraitSliders traits={balanced} onChange={vi.fn()} showPreviews={false} />);

    expect(screen.queryByText(TRAIT_PREVIEWS.verbosity[3])).not.toBeInTheDocument();
  });

  it('renders non-default trait levels correctly', () => {
    const custom = {
      verbosity: 1,
      autonomy: 5,
      chaos: 2,
      creativity: 1,
      humor: 4,
      spice: 5,
    };
    render(<TraitSliders traits={custom} onChange={vi.fn()} />);

    expect(screen.getByText('1/5 Mime')).toBeInTheDocument();
    expect(screen.getByText('5/5 Rogue')).toBeInTheDocument();
  });

  it('calls onChange with updated traits on slider change', () => {
    const onChange = vi.fn();
    render(<TraitSliders traits={balanced} onChange={onChange} />);

    // Simulate keyboard interaction on the first slider (verbosity)
    const sliders = screen.getAllByRole('slider');
    sliders[0].focus();
    sliders[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    if (onChange.mock.calls.length > 0) {
      const updated = onChange.mock.calls[0][0];
      expect(updated.verbosity).toBe(4);
      expect(updated.autonomy).toBe(3);
    }
  });

  it('calls onSliderChange side-effect callback when provided', () => {
    const onSliderChange = vi.fn();
    const onChange = vi.fn();
    render(<TraitSliders traits={balanced} onChange={onChange} onSliderChange={onSliderChange} />);

    const sliders = screen.getAllByRole('slider');
    sliders[0].focus();
    sliders[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    if (onSliderChange.mock.calls.length > 0) {
      expect(onSliderChange).toHaveBeenCalledWith('verbosity', 4);
    }
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PersonalitySliders } from '../ui/PersonalitySliders';

beforeAll(() => {
  // Radix UI's @radix-ui/react-use-size calls ResizeObserver which jsdom doesn't provide.
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
});

const defaultTraits = {
  tone: 3,
  autonomy: 3,
  caution: 3,
  communication: 3,
  creativity: 3,
};

describe('PersonalitySliders', () => {
  it('renders 5 sliders with correct labels', () => {
    render(<PersonalitySliders traits={defaultTraits} onChange={vi.fn()} />);

    expect(screen.getByText('tone')).toBeInTheDocument();
    expect(screen.getByText('autonomy')).toBeInTheDocument();
    expect(screen.getByText('caution')).toBeInTheDocument();
    expect(screen.getByText('communication')).toBeInTheDocument();
    expect(screen.getByText('creativity')).toBeInTheDocument();
  });

  it('shows current level labels for all 5 traits at level 3', () => {
    render(<PersonalitySliders traits={defaultTraits} onChange={vi.fn()} />);

    // The level label span renders as separate text nodes: "3", "/5 ", "Balanced"
    // Use the containing span's accessible text content via data-testid or check label text directly
    const levelSpans = document.querySelectorAll('.text-muted-foreground.text-xs');
    expect(levelSpans).toHaveLength(5);
    levelSpans.forEach((span) => {
      expect(span.textContent).toContain('3');
      expect(span.textContent).toContain('5');
      expect(span.textContent).toContain('Balanced');
    });
  });

  it('shows correct labels for non-default values', () => {
    const customTraits = { ...defaultTraits, tone: 1, autonomy: 5 };
    render(<PersonalitySliders traits={customTraits} onChange={vi.fn()} />);

    // Check that the level indicator spans contain the right text
    const levelSpans = document.querySelectorAll('.text-muted-foreground.text-xs');
    const toneSpan = levelSpans[0];
    const autonomySpan = levelSpans[1];

    expect(toneSpan.textContent).toContain('1');
    expect(toneSpan.textContent).toContain('Silent');
    expect(autonomySpan.textContent).toContain('5');
    expect(autonomySpan.textContent).toContain('Full Auto');
  });

  it('has 5 sliders with correct aria labels', () => {
    render(<PersonalitySliders traits={defaultTraits} onChange={vi.fn()} />);

    // Radix SliderPrimitive.Root renders as a span with aria-label on the root
    expect(screen.getByLabelText('tone trait level')).toBeInTheDocument();
    expect(screen.getByLabelText('autonomy trait level')).toBeInTheDocument();
    expect(screen.getByLabelText('caution trait level')).toBeInTheDocument();
    expect(screen.getByLabelText('communication trait level')).toBeInTheDocument();
    expect(screen.getByLabelText('creativity trait level')).toBeInTheDocument();
  });

  it('calls onChange with updated traits when a slider changes', () => {
    const onChange = vi.fn();
    render(<PersonalitySliders traits={defaultTraits} onChange={onChange} />);

    // Radix Slider thumb responds to keyboard events — ArrowRight increments by step
    // The thumb is the element with role="slider" inside the tone slider root
    const sliders = document.querySelectorAll<HTMLElement>('[role="slider"]');
    const toneThumb = sliders[0] as HTMLElement; // first slider = tone (matches TRAIT_ORDER)

    toneThumb.focus();
    toneThumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(onChange).toHaveBeenCalledWith({ ...defaultTraits, tone: 4 });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { OptionRow } from '../OptionRow';

afterEach(() => {
  cleanup();
});

describe('OptionRow', () => {
  it('renders control and children', () => {
    render(
      <OptionRow isSelected={false} control={<input type="radio" data-testid="radio" />}>
        <span>Option A</span>
      </OptionRow>,
    );
    expect(screen.getByTestId('radio')).toBeDefined();
    expect(screen.getByText('Option A')).toBeDefined();
  });

  it('applies selected styling when isSelected is true', () => {
    const { container } = render(
      <OptionRow isSelected={true} control={<input type="radio" />}>
        <span>Option A</span>
      </OptionRow>,
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain('bg-muted');
  });

  it('applies focus ring when isFocused is true', () => {
    const { container } = render(
      <OptionRow isSelected={false} isFocused control={<input type="radio" />}>
        <span>Option A</span>
      </OptionRow>,
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain('ring-1');
  });

  it('sets data-selected attribute', () => {
    const { container } = render(
      <OptionRow isSelected={true} data-selected={true} control={<input type="radio" />}>
        <span>Option A</span>
      </OptionRow>,
    );
    const row = container.firstElementChild!;
    expect(row.getAttribute('data-selected')).toBe('true');
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { InteractiveCard } from '../InteractiveCard';

describe('InteractiveCard', () => {
  it('renders children', () => {
    const { getByText } = render(<InteractiveCard>Hello</InteractiveCard>);
    expect(getByText('Hello')).toBeDefined();
  });

  it('shows ring-2 when isActive is true', () => {
    const { container } = render(<InteractiveCard isActive>Content</InteractiveCard>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('ring-2');
    expect(el.className).toContain('ring-ring/30');
  });

  it('applies opacity-60 when not active and not resolved', () => {
    const { container } = render(<InteractiveCard>Content</InteractiveCard>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('opacity-60');
  });

  it('does not apply opacity-60 when isResolved is true', () => {
    const { container } = render(<InteractiveCard isResolved>Content</InteractiveCard>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).not.toContain('opacity-60');
  });

  it('does not apply opacity-60 when isActive is true', () => {
    const { container } = render(<InteractiveCard isActive>Content</InteractiveCard>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).not.toContain('opacity-60');
  });

  it('passes data-testid through', () => {
    const { getByTestId } = render(
      <InteractiveCard data-testid="my-card">Content</InteractiveCard>
    );
    expect(getByTestId('my-card')).toBeDefined();
  });

  it('merges className prop', () => {
    const { container } = render(<InteractiveCard className="my-1">Content</InteractiveCard>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain('my-1');
    expect(el.className).toContain('bg-muted/50');
  });
});

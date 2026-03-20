/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FieldCard, FieldCardContent, CollapsibleFieldCard } from '../field-card';

afterEach(cleanup);

describe('FieldCard', () => {
  it('renders children inside a rounded bordered container', () => {
    render(
      <FieldCard>
        <p>Card content</p>
      </FieldCard>
    );
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <FieldCard className="border-destructive/50">
        <p>Danger</p>
      </FieldCard>
    );
    expect(container.firstChild).toHaveClass('border-destructive/50');
  });

  it('has the field-card data-slot', () => {
    const { container } = render(
      <FieldCard>
        <p>Content</p>
      </FieldCard>
    );
    expect(container.firstChild).toHaveAttribute('data-slot', 'field-card');
  });
});

describe('FieldCardContent', () => {
  it('renders children with divide-y separator classes', () => {
    const { container } = render(
      <FieldCardContent>
        <div>Item 1</div>
        <div>Item 2</div>
      </FieldCardContent>
    );
    expect(screen.getByText('Item 1')).toBeInTheDocument();
    expect(screen.getByText('Item 2')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('divide-y');
  });

  it('has the field-card-content data-slot', () => {
    const { container } = render(
      <FieldCardContent>
        <div>Item</div>
      </FieldCardContent>
    );
    expect(container.firstChild).toHaveAttribute('data-slot', 'field-card-content');
  });
});

describe('CollapsibleFieldCard', () => {
  it('renders trigger text', () => {
    render(
      <CollapsibleFieldCard open={false} onOpenChange={vi.fn()} trigger="Chat Filter">
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    expect(screen.getByText('Chat Filter')).toBeInTheDocument();
  });

  it('renders badge when provided', () => {
    render(
      <CollapsibleFieldCard
        open={false}
        onOpenChange={vi.fn()}
        trigger="Advanced"
        badge={<span data-testid="badge">Modified</span>}
      >
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    expect(screen.getByTestId('badge')).toBeInTheDocument();
  });

  it('hides content when collapsed', () => {
    render(
      <CollapsibleFieldCard open={false} onOpenChange={vi.fn()} trigger="Section">
        <div>Hidden content</div>
      </CollapsibleFieldCard>
    );
    // Radix collapsible removes content from the DOM when closed
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
  });

  it('shows content when expanded', () => {
    render(
      <CollapsibleFieldCard open={true} onOpenChange={vi.fn()} trigger="Section">
        <div>Visible content</div>
      </CollapsibleFieldCard>
    );
    expect(screen.getByText('Visible content')).toBeVisible();
  });

  it('calls onOpenChange when trigger is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <CollapsibleFieldCard open={false} onOpenChange={onOpenChange} trigger="Section">
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    fireEvent.click(screen.getByText('Section'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('applies custom className to the outer card', () => {
    const { container } = render(
      <CollapsibleFieldCard
        open={false}
        onOpenChange={vi.fn()}
        trigger="Section"
        className="border-destructive"
      >
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    const card = container.querySelector('[data-slot="collapsible-field-card"]');
    expect(card).toHaveClass('border-destructive');
  });
});

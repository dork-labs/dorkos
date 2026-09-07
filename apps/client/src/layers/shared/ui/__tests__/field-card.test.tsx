/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('renders a header action outside the trigger, so clicking it does not toggle the section', () => {
    // A button inside the trigger button would be invalid HTML and would open
    // the section on every click of the action.
    const onOpenChange = vi.fn();
    const onAction = vi.fn();
    render(
      <CollapsibleFieldCard
        open={false}
        onOpenChange={onOpenChange}
        trigger="Diagnostics"
        action={<button onClick={onAction}>Copy all</button>}
      >
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    const action = screen.getByRole('button', { name: 'Copy all' });
    expect(action.closest('[data-slot="collapsible-trigger"]')).toBeNull();
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('toggles the section when the chevron beside the trigger is clicked', () => {
    // The chevron sits OUTSIDE the label trigger so every card draws it at the
    // same distance from the card's right edge whether or not an `action` is
    // present. Moving it out cost it its click, and a chevron that does not
    // answer one is the affordance lying (DOR-1815).
    const onOpenChange = vi.fn();
    render(
      <CollapsibleFieldCard open={false} onOpenChange={onOpenChange} trigger="Section">
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    fireEvent.click(screen.getByTestId('collapsible-field-card-chevron'));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('offers the chevron to the pointer only — one toggle for the keyboard and the reader', () => {
    // Two triggers is what makes the chevron clickable; two ANNOUNCED toggles
    // would be the regression. The chevron is hidden from the accessibility
    // tree and taken out of the tab order, so `getAllByRole` still sees one.
    render(
      <CollapsibleFieldCard open={false} onOpenChange={vi.fn()} trigger="Section">
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    const chevron = screen.getByTestId('collapsible-field-card-chevron');
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(chevron).toHaveAttribute('tabindex', '-1');
  });

  it('does not park focus on the chevron, which is not in the accessibility tree', () => {
    // A pointer press focuses its target on mousedown, so without refusing
    // that default the click would leave focus sitting on an `aria-hidden`
    // node — nowhere, as far as a screen reader is concerned. `userEvent`
    // drives the real mousedown/mouseup/click sequence, which is what makes
    // this observable; `fireEvent.click` never moves focus at all.
    const user = userEvent.setup();
    render(
      <CollapsibleFieldCard open={false} onOpenChange={vi.fn()} trigger="Section">
        <div>Content</div>
      </CollapsibleFieldCard>
    );
    const before = document.activeElement;
    return user.click(screen.getByTestId('collapsible-field-card-chevron')).then(() => {
      expect(document.activeElement).toBe(before);
      expect(document.activeElement).not.toBe(screen.getByTestId('collapsible-field-card-chevron'));
    });
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

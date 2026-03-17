// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CollapsibleCard } from '../CollapsibleCard';

afterEach(() => {
  cleanup();
});

describe('CollapsibleCard', () => {
  it('renders header content', () => {
    render(
      <CollapsibleCard expanded={false} onToggle={vi.fn()} header={<span>Header</span>}>
        Body
      </CollapsibleCard>,
    );
    expect(screen.getByText('Header')).toBeDefined();
  });

  it('calls onToggle when header button is clicked', () => {
    const onToggle = vi.fn();
    render(
      <CollapsibleCard expanded={false} onToggle={onToggle} header={<span>Header</span>}>
        Body
      </CollapsibleCard>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('does not call onToggle when disabled', () => {
    const onToggle = vi.fn();
    render(
      <CollapsibleCard expanded={false} onToggle={onToggle} disabled header={<span>Header</span>}>
        Body
      </CollapsibleCard>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('renders body content when expanded', () => {
    render(
      <CollapsibleCard expanded={true} onToggle={vi.fn()} header={<span>Header</span>}>
        Body content
      </CollapsibleCard>,
    );
    expect(screen.getByText('Body content')).toBeDefined();
  });

  it('does not render body when collapsed', () => {
    render(
      <CollapsibleCard expanded={false} onToggle={vi.fn()} header={<span>Header</span>}>
        Body content
      </CollapsibleCard>,
    );
    expect(screen.queryByText('Body content')).toBeNull();
  });

  it('sets aria-expanded on the button', () => {
    render(
      <CollapsibleCard expanded={true} onToggle={vi.fn()} header={<span>Header</span>}>
        Body
      </CollapsibleCard>,
    );
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('omits aria-expanded when hideChevron is true', () => {
    render(
      <CollapsibleCard expanded={false} onToggle={vi.fn()} hideChevron header={<span>Header</span>}>
        Body
      </CollapsibleCard>,
    );
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBeNull();
  });

  it('passes ariaLabel to the button', () => {
    render(
      <CollapsibleCard expanded={false} onToggle={vi.fn()} ariaLabel="My card" header={<span>Header</span>}>
        Body
      </CollapsibleCard>,
    );
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('My card');
  });

  it('renders extraContent between header and body', () => {
    render(
      <CollapsibleCard
        expanded={true}
        onToggle={vi.fn()}
        header={<span>Header</span>}
        extraContent={<div>Extra</div>}
      >
        Body
      </CollapsibleCard>,
    );
    expect(screen.getByText('Extra')).toBeDefined();
  });

  it('passes data attributes through', () => {
    render(
      <CollapsibleCard
        expanded={false}
        onToggle={vi.fn()}
        header={<span>Header</span>}
        data-testid="my-card"
        data-status="running"
      >
        Body
      </CollapsibleCard>,
    );
    const card = screen.getByTestId('my-card');
    expect(card.getAttribute('data-status')).toBe('running');
  });

  it('applies thinking variant classes', () => {
    render(
      <CollapsibleCard
        expanded={false}
        onToggle={vi.fn()}
        variant="thinking"
        header={<span>Header</span>}
        data-testid="thinking-card"
      >
        Body
      </CollapsibleCard>,
    );
    const card = screen.getByTestId('thinking-card');
    expect(card.className).toContain('border-l-2');
  });
});

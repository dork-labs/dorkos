// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MentionPill } from '../mention-pill';

afterEach(cleanup);

describe('MentionPill', () => {
  it('renders plain, pointer-free text when unresolved, regardless of kind', () => {
    const { container } = render(<MentionPill kind="agent" label="ghost-agent" resolved={false} />);
    const pill = container.querySelector('[data-slot="mention-pill"]') as HTMLElement;

    expect(pill).toHaveTextContent('@ghost-agent');
    expect(pill).toHaveAttribute('data-resolved', 'false');
    expect(pill.className).not.toMatch(/cursor-pointer/);
    // No background classes at all — an unresolved mention is not a pill.
    expect(pill.className).not.toMatch(/bg-/);
  });

  it('draws an agent as an identity-colour pill with a Bot glyph instead of "@"', () => {
    render(<MentionPill kind="agent" label="Warden" color="#6d5ae0" resolved />);
    const pill = screen.getByText('Warden').closest('[data-slot="mention-pill"]') as HTMLElement;

    expect(pill).toHaveAttribute('data-kind', 'agent');
    expect(pill.textContent).toBe('Warden');
    expect(pill.querySelector('svg')).not.toBeNull();
    expect(pill.style.backgroundColor).toContain('color-mix');
  });

  it('draws a local person as a neutral @name pill with no glyph', () => {
    render(<MentionPill kind="human" label="dorian" resolved />);
    const pill = screen.getByText('@dorian').closest('[data-slot="mention-pill"]') as HTMLElement;

    expect(pill).toHaveAttribute('data-kind', 'human');
    expect(pill).toHaveClass('bg-secondary');
    expect(pill.querySelector('svg')).toBeNull();
  });

  it('adds a platform glyph after the name for an external person', () => {
    render(<MentionPill kind="human" label="priya" origin={{ platform: 'telegram' }} resolved />);
    const pill = screen.getByText('@priya').closest('[data-slot="mention-pill"]') as HTMLElement;

    expect(pill.querySelector('svg')).not.toBeNull();
  });

  it('drops the "@" for a system mention', () => {
    render(<MentionPill kind="system" label="Room" resolved />);

    expect(screen.getByText('Room')).toBeInTheDocument();
    expect(screen.queryByText('@Room')).not.toBeInTheDocument();
  });

  it('never truncates: it wraps and clones its background across the wrap', () => {
    const { container } = render(
      <MentionPill
        kind="agent"
        label="codebase-migration-orchestrator-v2"
        color="#6d5ae0"
        resolved
      />
    );
    const pill = container.querySelector('[data-slot="mention-pill"]') as HTMLElement;

    expect(pill).not.toHaveClass('truncate');
    expect(pill.className).toMatch(/overflow-wrap:anywhere/);
    expect(pill.className).toMatch(/box-decoration-break:clone/);
  });

  it('only carries hover/click affordance when interactive is set', () => {
    const { container: passive } = render(<MentionPill kind="human" label="dorian" resolved />);
    const { container: active } = render(
      <MentionPill kind="human" label="dorian" resolved interactive />
    );

    expect(passive.querySelector('[data-slot="mention-pill"]')?.className).not.toMatch(
      /cursor-pointer/
    );
    expect(active.querySelector('[data-slot="mention-pill"]')?.className).toMatch(/cursor-pointer/);
  });
});

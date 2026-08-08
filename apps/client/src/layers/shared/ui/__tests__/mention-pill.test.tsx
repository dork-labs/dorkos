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
    // The colour is PUBLISHED, not painted: the background is a class that
    // reads this property, which is the only reason a `:hover` rule can step
    // it. An inline `background-color` outranks every stylesheet.
    expect(pill.style.getPropertyValue('--identity-color')).toBe('#6d5ae0');
    expect(pill.className).toContain(
      'bg-[color-mix(in_oklch,var(--identity-color)_14%,transparent)]'
    );
    expect(pill.style.color).toContain('color-mix');
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

  describe('the Chip tier: one tint step, and never a filter', () => {
    it('answers an agent hover by raising its own colour, not by dimming it', () => {
      const { container } = render(
        <MentionPill kind="agent" label="Warden" color="#6d5ae0" resolved interactive />
      );
      const pill = container.querySelector('[data-slot="mention-pill"]') as HTMLElement;

      // `brightness()` multiplies a considered identity colour toward grey —
      // the opposite of the identity answering, and banned on any surface
      // already carrying one.
      expect(pill.className).not.toMatch(/brightness/);
      // 14% at rest, 20% under the pointer. One step, no ring, no lift: a pill
      // mid-paragraph that glowed would pull the eye out of the sentence.
      expect(pill.className).toContain(
        'hover:bg-[color-mix(in_oklch,var(--identity-color)_20%,transparent)]'
      );
    });

    it('steps a neutral pill too, since it has no identity colour to raise', () => {
      const { container } = render(
        <MentionPill kind="human" label="dorian" resolved interactive />
      );
      const pill = container.querySelector('[data-slot="mention-pill"]') as HTMLElement;

      expect(pill.className).not.toMatch(/brightness/);
      expect(pill.className).toContain('hover:bg-[color-mix(in_oklch,hsl(var(--secondary))');
    });

    it('leaves a non-interactive pill with no hover response at all', () => {
      // An affordance is only honest where a click exists. `interactive` is
      // what the caller turns on alongside the click itself.
      const { container } = render(
        <MentionPill kind="agent" label="Warden" color="#6d5ae0" resolved />
      );
      const pill = container.querySelector('[data-slot="mention-pill"]') as HTMLElement;

      expect(pill.className).not.toMatch(/hover:/);
      expect(pill.className).not.toMatch(/focus-visible:/);
    });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { IdentityAvatar } from '../identity-avatar';

/** The glyph element — whichever face the disc chose to draw. */
function glyphOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="identity-avatar"] > span') as HTMLElement;
}

afterEach(cleanup);

describe('IdentityAvatar', () => {
  it('draws the emoji when there is one, and the fallback when there is not', () => {
    const { container: withEmoji } = render(
      <IdentityAvatar color="#7c3aed" emoji="🐙" fallback="A" />
    );
    const { container: without } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);

    expect(glyphOf(withEmoji).textContent).toBe('🐙');
    expect(glyphOf(without).textContent).toBe('A');
  });

  it('mixes the tint at 18% of the colour it was handed', () => {
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'color-mix(in oklch, #7c3aed 18%, transparent)';

    const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);

    const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;
    expect(disc.style.backgroundColor).toBe(probe.style.backgroundColor);
  });

  it('draws each size at its own exact diameter', () => {
    // Pinned as literal class names, because these ARE the contract: three
    // components size themselves off this table, and a silent change to any
    // row moves marks that are meant to line up in the same row.
    const diameters = { xs: 'size-5', sm: 'size-7', md: 'size-9', lg: 'size-12' } as const;

    for (const [size, diameter] of Object.entries(diameters)) {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" fallback="A" size={size as keyof typeof diameters} />
      );
      expect(container.querySelector('[data-slot="identity-avatar"]')).toHaveClass(diameter);
      cleanup();
    }
  });

  it('defaults to the size the agent list and the message gutter both assume', () => {
    const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);

    expect(container.querySelector('[data-slot="identity-avatar"]')).toHaveClass('size-7');
  });

  it('sets a letter a step below the circle, so one rule covers every size', () => {
    // jsdom does no layout, so what can be pinned is the rule itself: the
    // fallback glyph is sized relative to the disc's own font size. An emoji
    // fills the circle, a letter does not.
    const { container: letter } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);
    const { container: emoji } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

    expect(glyphOf(letter)).toHaveClass('text-[0.8em]');
    expect(glyphOf(emoji)).not.toHaveClass('text-[0.8em]');
  });

  it('keeps the disc as the positioning context for anything laid over it', () => {
    // An agent's status dot is an absolutely-placed child, so the disc has to
    // be what it anchors to.
    const { container } = render(
      <IdentityAvatar color="#7c3aed" emoji="🐙">
        <span data-testid="status-dot" className="absolute -top-px -right-px size-2" />
      </IdentityAvatar>
    );

    expect(container.querySelector('[data-slot="identity-avatar"]')).toHaveClass('relative');
    expect(screen.getByTestId('status-dot')).toBeInTheDocument();
  });

  it('contributes nothing to the accessibility tree on its own', () => {
    // An emoji has a spoken name nobody asked to hear; a caller that stands the
    // mark alone adds an sr-only label of its own.
    const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

    expect(glyphOf(container)).toHaveAttribute('aria-hidden', 'true');
  });
});

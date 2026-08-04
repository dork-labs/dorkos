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

  describe('shape and variant', () => {
    it('defaults to circle and tint, so every existing call site is unaffected', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;

      const probe = document.createElement('span');
      probe.style.backgroundColor = 'color-mix(in oklch, #7c3aed 18%, transparent)';

      expect(disc).toHaveClass('rounded-full');
      expect(disc).not.toHaveClass('rounded-xl');
      expect(disc.style.backgroundColor).toBe(probe.style.backgroundColor);
    });

    it('draws square as the agent shape', () => {
      // Default size is `sm`, whose radius is `rounded-lg` — see the
      // per-size stepping tested below.
      const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" shape="square" />);
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;

      expect(disc).toHaveClass('rounded-lg');
      expect(disc).not.toHaveClass('rounded-full');
    });

    it('keeps the square radius well short of a circle at xs, where most of these render', () => {
      // A fixed radius that reads fine on a 48px `lg` disc clamps to a full
      // circle on a 20px `xs` one (12px of rounding on a 20px box IS a
      // circle) — which would erase the colourblind-safe shape distinction
      // exactly where the design calls it dominant: the picker, the sidebar.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" fallback="A" shape="square" size="xs" />
      );
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;

      expect(disc).toHaveClass('rounded-md');
      expect(disc).not.toHaveClass('rounded-full');
    });

    it('steps the square radius up with the diameter at sm/md/lg', () => {
      const bySize = { sm: 'rounded-lg', md: 'rounded-xl', lg: 'rounded-2xl' } as const;

      for (const [size, radius] of Object.entries(bySize)) {
        const { container } = render(
          <IdentityAvatar
            color="#7c3aed"
            fallback="A"
            shape="square"
            size={size as keyof typeof bySize}
          />
        );
        expect(container.querySelector('[data-slot="identity-avatar"]')).toHaveClass(radius);
        cleanup();
      }
    });

    it('fills with the solid identity colour rather than a tint', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" variant="fill" />);
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;
      const probe = document.createElement('span');
      probe.style.backgroundColor = '#7c3aed';

      expect(disc.style.backgroundColor).toBe(probe.style.backgroundColor);
    });

    it("picks the fallback letter's colour from the fill, not a fixed white", () => {
      // A light fill needs dark text — the exact case "don't assume white" is
      // guarding against.
      const { container } = render(<IdentityAvatar color="#fef3c7" fallback="A" variant="fill" />);
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;

      expect(disc.style.color).toBe('oklch(0.2 0 0)');
    });

    it('leaves text colour alone for tint, where the ambient foreground already reads', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;

      expect(disc.style.color).toBe('');
    });
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

  describe('the badge slot', () => {
    /** The corner mark, when the disc drew one. */
    function badgeOf(container: HTMLElement): HTMLElement | null {
      return container.querySelector('[data-slot="identity-avatar"] > span:nth-of-type(2)');
    }

    it('marks an agent and leaves a person unmarked', () => {
      // The whole convention in one assertion: absence is the signal. A badge
      // that appeared on every identity would be a column of identical marks,
      // and one reading "person" would put the burden of proof on the humans.
      const { container: agent } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" badge={<span>⌁</span>} />
      );
      const { container: person } = render(<IdentityAvatar color="#7c3aed" fallback="P" />);

      expect(badgeOf(agent)).toHaveTextContent('⌁');
      expect(badgeOf(person)).toBeNull();
    });

    it('is decoration: no pointer events, and nothing in the accessibility tree', () => {
      // A 10px target inside a 20px disc is a mis-tap on a touch screen, and
      // the badge is not a control — the row's own text names the member.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" badge={<span>⌁</span>} />
      );

      expect(badgeOf(container)).toHaveClass('pointer-events-none');
      expect(badgeOf(container)).toHaveAttribute('aria-hidden', 'true');
    });

    it('scales off the disc rather than a fixed size, so 20px still reads', () => {
      // jsdom reports every element as 0x0, so what can be pinned is the rule:
      // both the plate and its glyph are `em` of the circle's own font size,
      // the same way the fallback letter is. A fixed size here would be a
      // smudge at `xs` — which is a 20px disc, and most of where this lands.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" size="xs" badge={<span>⌁</span>} />
      );

      expect(badgeOf(container)).toHaveClass('size-[1.35em]', 'text-[0.62em]');
    });

    it('draws its plate in the page background, so it reads over any disc tint', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" badge={<span>⌁</span>} />
      );

      expect(badgeOf(container)).toHaveClass('bg-background');
    });
  });

  it('contributes nothing to the accessibility tree on its own', () => {
    // An emoji has a spoken name nobody asked to hear; a caller that stands the
    // mark alone adds an sr-only label of its own.
    const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

    expect(glyphOf(container)).toHaveAttribute('aria-hidden', 'true');
  });
});

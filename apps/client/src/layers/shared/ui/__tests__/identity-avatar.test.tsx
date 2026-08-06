// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { IdentityAvatar } from '../identity-avatar';

/** The glyph element — whichever face the disc chose to draw. */
function glyphOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="identity-avatar"] > span') as HTMLElement;
}

/** The disc itself. */
function discOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;
}

/**
 * The corner mark, when the disc drew one. It is always the second span —
 * the face is the first, and the working dot (when there is one) comes after.
 */
function badgeOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="identity-avatar"] > span:nth-of-type(2)');
}

/** What `backgroundColor` jsdom reports for a disc tinted from `color`. */
function tint(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = `color-mix(in oklch, ${color} 18%, transparent)`;
  return probe.style.backgroundColor;
}

/** What `backgroundColor` jsdom reports for a disc filled with `color`. */
function fill(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = color;
  return probe.style.backgroundColor;
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

  describe('kind — what the identity IS, and the three props it decides', () => {
    it('draws an agent as a filled square wearing the Bot mark', () => {
      // The whole point of the prop: three decisions a caller used to make by
      // hand — and got wrong in 18 of the 20 places that draw an agent — now
      // arrive together or not at all.
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" />);

      expect(discOf(container)).toHaveClass('rounded-lg');
      expect(discOf(container)).not.toHaveClass('rounded-full');
      expect(discOf(container).style.backgroundColor).toBe(fill('#7c3aed'));
      expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
    });

    it('draws a person on this machine as a tinted circle with nothing added', () => {
      // Absence is the signal. A badge reading "person" would put the burden
      // of proof on the humans.
      for (const origin of ['local', undefined] as const) {
        const { container } = render(
          <IdentityAvatar color="#7c3aed" fallback="P" kind="human" origin={origin} />
        );

        expect(discOf(container)).toHaveClass('rounded-full');
        expect(discOf(container).style.backgroundColor).toBe(tint('#7c3aed'));
        expect(badgeOf(container)).toBeNull();
        cleanup();
      }
    });

    it("badges a bridged person with their platform's own brand mark", () => {
      // "Someone on this machine wrote this" and "a stranger on the internet
      // wrote this" have to be legible at a glance, and the mark is the same
      // one the connection surfaces draw for that platform.
      const { container } = render(
        <IdentityAvatar
          color="#7c3aed"
          fallback="P"
          kind="human"
          origin={{ platform: 'telegram' }}
        />
      );

      expect(discOf(container)).toHaveClass('rounded-full');
      expect(discOf(container).style.backgroundColor).toBe(tint('#7c3aed'));
      expect(badgeOf(container)?.querySelector('svg')).not.toBeNull();
      // Not the generic stand-in: this build knows Telegram by name.
      expect(badgeOf(container)?.querySelector('.lucide-send')).toBeNull();
    });

    it('falls back to a generic external mark for a platform this build has no logo for', () => {
      // An origin we cannot name still has to read as "not from here" rather
      // than render nothing at all.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" fallback="P" kind="human" origin={{ platform: 'matrix' }} />
      );

      expect(badgeOf(container)?.querySelector('.lucide-send')).not.toBeNull();
    });

    it("draws the room's own voice as a plain circle — it is nobody's identity to badge", () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" fallback="G" kind="system" />);

      expect(discOf(container)).toHaveClass('rounded-full');
      expect(discOf(container).style.backgroundColor).toBe(tint('#7c3aed'));
      expect(badgeOf(container)).toBeNull();
    });

    it('reproduces the pre-kind defaults exactly when kind is omitted', () => {
      // This is what makes the prop additive: every call site that predates it
      // keeps drawing precisely what it drew before.
      const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);

      expect(discOf(container)).toHaveClass('rounded-full');
      expect(discOf(container).style.backgroundColor).toBe(tint('#7c3aed'));
      expect(badgeOf(container)).toBeNull();
    });

    it('ignores origin for an agent — it says where a person is posting from, nothing else', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" origin={{ platform: 'telegram' }} />
      );

      expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
    });
  });

  describe('explicit props beat the derivation, one axis at a time', () => {
    it('lets a caller round an agent off without giving up its fill or its badge', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" shape="circle" />
      );

      expect(discOf(container)).toHaveClass('rounded-full');
      expect(discOf(container).style.backgroundColor).toBe(fill('#7c3aed'));
      expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
    });

    it('lets a caller tint an agent without giving up its square or its badge', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" variant="tint" />
      );

      expect(discOf(container)).toHaveClass('rounded-lg');
      expect(discOf(container).style.backgroundColor).toBe(tint('#7c3aed'));
      expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
    });

    it('reads badge={null} as "no badge here", and still draws the square fill', () => {
      // What an agent-only list wants: keep the shape, drop a column of
      // identical glyphs that says nothing. Deliberate, and now visible in the
      // call site rather than achieved by forgetting a prop.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" badge={null} />
      );

      expect(badgeOf(container)).toBeNull();
      expect(discOf(container)).toHaveClass('rounded-lg');
      expect(discOf(container).style.backgroundColor).toBe(fill('#7c3aed'));
    });

    it('lets an explicit badge stand in for the derived one', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" badge={<span>⌁</span>} />
      );

      expect(badgeOf(container)).toHaveTextContent('⌁');
      expect(badgeOf(container)?.querySelector('.lucide-bot')).toBeNull();
    });
  });

  describe('the working dot', () => {
    /** The pulsing mark, when the disc drew one. */
    function dotOf(container: HTMLElement): HTMLElement | null {
      return container.querySelector('[data-slot="identity-avatar"] > span.bg-status-success');
    }

    it('marks an identity that is working right now, in the theme green', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" working />);

      expect(dotOf(container)).not.toBeNull();
      expect(dotOf(container)).toHaveClass('bg-status-success', 'ring-background');
      expect(dotOf(container)).toHaveAttribute('aria-hidden', 'true');
    });

    it('draws no dot when nothing is happening', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

      expect(dotOf(container)).toBeNull();
    });

    it('keeps the fact and drops the motion when motion is reduced', () => {
      // The ping is what says "right now"; a still dot says the same thing
      // about a state that ended an hour ago. Under `motion-reduce` the dot
      // survives and only the animation goes.
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" working />);
      const ping = dotOf(container)?.querySelector('.animate-ping');

      expect(ping).not.toBeNull();
      expect(ping).toHaveClass('motion-reduce:hidden');
      expect(dotOf(container)).not.toHaveClass('motion-reduce:hidden');
    });

    it('is kind-agnostic — a person in a roster can be working too', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" fallback="P" kind="human" working />
      );

      expect(dotOf(container)).not.toBeNull();
      expect(discOf(container)).toHaveClass('rounded-full');
    });

    it('sits opposite the badge, so an agent can wear both', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" working />
      );

      expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
      expect(dotOf(container)).toHaveClass('-top-px', '-right-px');
      expect(badgeOf(container)).toHaveClass('-bottom-px', '-right-px');
    });
  });

  it('contributes nothing to the accessibility tree on its own', () => {
    // An emoji has a spoken name nobody asked to hear; a caller that stands the
    // mark alone adds an sr-only label of its own.
    const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

    expect(glyphOf(container)).toHaveAttribute('aria-hidden', 'true');
  });
});

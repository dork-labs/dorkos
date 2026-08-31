// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { IdentityAvatar, identityMarkRing, IDENTITY_BADGE_WAKE } from '../identity-avatar';

/**
 * A 1x1 transparent GIF. Inline so nothing here reaches the network — jsdom
 * never loads it either way, which is exactly why the error path below is
 * driven by firing the event rather than by waiting for a real failure.
 */
const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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
    const diameters = { xs: 'size-[18px]', sm: 'size-7', md: 'size-9', lg: 'size-12' } as const;

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

  describe('declining fill on a colour it cannot read a foreground for (DOR-998)', () => {
    // `fill` sets both the disc's background and the fallback letter's colour
    // from the same string. A colour `readableForeground` cannot parse makes
    // it guess, and the guess can land on the same value the background
    // itself resolves to — painting an invisible letter. The primitive steps
    // back to `tint` instead of guessing, on every caller that asked for
    // `fill`, whether by kind or by explicit prop.
    it.each([
      ['#7c3aed', true],
      ['rgb(124, 58, 237)', true],
      ['hsl(262 83% 58%)', true],
      ['currentColor', false],
      ['var(--color-orange-500)', false],
      ['hsl(var(--muted-foreground))', false],
    ] as const)('keeps fill for %s: %s', (color, keepsFill) => {
      const { container } = render(<IdentityAvatar color={color} fallback="A" variant="fill" />);
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;

      expect(disc.style.backgroundColor).toBe(keepsFill ? fill(color) : tint(color));
      // The fallback letter's colour is only ever set for a fill that held —
      // a declined fill leaves it alone, the same as an ordinary tint.
      expect(disc.style.color).toBe(keepsFill ? disc.style.color : '');
      if (keepsFill) expect(disc.style.color).toMatch(/^oklch\(/);
    });

    it('never leaves the fallback letter set for a declined fill', () => {
      // Spelled out on its own rather than folded into the loop above: this is
      // the exact defect (an invisible letter), not a byproduct of the table.
      const { container } = render(
        <IdentityAvatar color="currentColor" fallback="A" variant="fill" />
      );
      expect(
        (container.querySelector('[data-slot="identity-avatar"]') as HTMLElement).style.color
      ).toBe('');
    });

    it('declines fill from kind="agent"’s own default, not only from an explicit variant prop', () => {
      // `AgentChipPicker`'s unresolved-agent row hits exactly this path:
      // `kind="agent"` defaults to fill, no `variant` prop in sight.
      const { container } = render(
        <IdentityAvatar color="currentColor" fallback="A" kind="agent" />
      );
      const disc = container.querySelector('[data-slot="identity-avatar"]') as HTMLElement;
      expect(disc.style.backgroundColor).toBe(tint('currentColor'));
      // Still the agent's square shape — only the fill/tint choice changes.
      expect(disc).toHaveClass('rounded-lg');
    });

    it('keeps the agent shape and badge when fill is declined', () => {
      const { container } = render(
        <IdentityAvatar color="currentColor" fallback="A" kind="agent" />
      );
      expect(badgeOf(container)).not.toBeNull();
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

  describe('the status dot', () => {
    /** The corner mark, when the disc drew one. */
    function dotOf(container: HTMLElement): HTMLElement | null {
      return container.querySelector('[data-slot="identity-status-dot"]');
    }

    it('marks an identity that is working right now, in the theme green', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" status="working" />);

      expect(dotOf(container)).not.toBeNull();
      expect(dotOf(container)).toHaveClass('bg-status-success', 'ring-background');
    });

    it('says in words what it says in colour (R2)', () => {
      // Colour is never the sole indicator. This dot is a non-text graphic
      // whose entire content is a hue — the one shape of signal a reader who
      // cannot see it loses completely — so it carries its meaning as text
      // too. It is the one mark on the disc that is NOT `aria-hidden`, unlike
      // the identity badge beside it, which only repeats what the surface
      // around it already says.
      for (const [status, words] of [
        ['working', 'working'],
        ['needs-you', 'needs you'],
        ['error', 'error'],
      ] as const) {
        const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" status={status} />);
        expect(dotOf(container)).not.toHaveAttribute('aria-hidden');
        expect(dotOf(container)?.textContent, status).toBe(words);
        cleanup();
      }
    });

    it('keeps the words out of the halo, so the pulse is not announced twice', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" status="working" />);
      const halo = dotOf(container)?.querySelector('.animate-ping');
      expect(halo).not.toBeNull();
      expect(halo).toHaveAttribute('aria-hidden', 'true');
    });

    it('draws no dot when nothing is happening', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

      expect(dotOf(container)).toBeNull();
      expect(
        render(<IdentityAvatar color="#7c3aed" emoji="🐙" status="idle" />).container.querySelector(
          '[data-slot="identity-status-dot"]'
        )
      ).toBeNull();
    });

    it('says needs-you in amber and error in red, from the one token map', () => {
      const { container: amber } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" status="needs-you" />
      );
      // The DOT token, not the general-purpose `bg-status-warning`. A dot
      // carries its meaning by colour, so it owes 3:1 against the surface
      // (WCAG 1.4.11) and the fill-tuned amber is 2.15:1 on a light one.
      expect(dotOf(amber)).toHaveClass('bg-status-warning-dot');
      expect(dotOf(amber)).not.toHaveClass('bg-status-warning');

      const { container: red } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" status="error" />
      );
      expect(dotOf(red)).toHaveClass('bg-status-error');
    });

    it('moves for working and for nothing else', () => {
      // Motion is what the word "now" is made of. A state that pulsed — an
      // approval waiting on you, a turn that already failed — would claim to
      // still be running.
      for (const status of ['needs-you', 'error'] as const) {
        const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" status={status} />);
        expect(dotOf(container)?.querySelector('.animate-ping')).toBeNull();
      }

      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" status="working" />);
      expect(dotOf(container)?.querySelector('.animate-ping')).not.toBeNull();
    });

    it('keeps the fact and drops the motion when motion is reduced', () => {
      // The ping is what says "right now"; a still dot says the same thing
      // about a state that ended an hour ago. Under `motion-reduce` the dot
      // survives and only the animation goes.
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" status="working" />);
      const ping = dotOf(container)?.querySelector('.animate-ping');

      expect(ping).not.toBeNull();
      expect(ping).toHaveClass('motion-reduce:hidden');
      expect(dotOf(container)).not.toHaveClass('motion-reduce:hidden');
    });

    it('is kind-agnostic — a person in a roster can be working too', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" fallback="P" kind="human" status="working" />
      );

      expect(dotOf(container)).not.toBeNull();
      expect(discOf(container)).toHaveClass('rounded-full');
    });

    it('sits opposite the badge, so an agent can wear both', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" status="working" />
      );

      expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
      expect(dotOf(container)).toHaveClass('-top-px', '-right-px');
      expect(badgeOf(container)).toHaveClass('-bottom-px', '-right-px');
    });
  });

  describe('the three faces, in order: photo, emoji, letter', () => {
    /** The photo, when the disc drew one. */
    function photoOf(container: HTMLElement): HTMLImageElement | null {
      return container.querySelector('[data-slot="identity-avatar"] img');
    }

    it('draws the photo, and does not draw the emoji behind it', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" fallback="A" imageUrl={PHOTO} />
      );

      expect(photoOf(container)).toHaveAttribute('src', PHOTO);
      expect(discOf(container)).not.toHaveTextContent('🐙');
      expect(discOf(container)).not.toHaveTextContent('A');
    });

    it('draws the emoji when there is no photo, and the letter when there is neither', () => {
      const { container: withEmoji } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" fallback="A" />
      );
      const { container: letterOnly } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);

      expect(glyphOf(withEmoji).textContent).toBe('🐙');
      expect(glyphOf(letterOnly).textContent).toBe('A');
    });

    it('renders NO img element at all when there is no photo', () => {
      // Structural, not cosmetic. An `<img>` with an empty or absent `src`
      // paints the browser's own broken-image icon, and no amount of CSS
      // un-paints it — so absence has to mean the element was never rendered.
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

      expect(photoOf(container)).toBeNull();
    });

    it('falls back to the emoji when the photo fails to load', () => {
      // A URL whose bytes have gone — a deleted file, an expired CDN object.
      // The disc has a face already; showing a broken-image icon instead of it
      // would be worse than never having had the photo.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" fallback="A" imageUrl={PHOTO} />
      );
      fireEvent.error(photoOf(container)!);

      expect(photoOf(container)).toBeNull();
      expect(glyphOf(container).textContent).toBe('🐙');
    });

    it('falls back to the letter when the photo fails and there is no emoji', () => {
      const { container } = render(
        <IdentityAvatar color="#7c3aed" fallback="A" imageUrl={PHOTO} />
      );
      fireEvent.error(photoOf(container)!);

      expect(photoOf(container)).toBeNull();
      expect(glyphOf(container).textContent).toBe('A');
    });

    it('tries again when the photo is replaced, so a new upload is not stuck behind an old failure', () => {
      const { container, rerender } = render(
        <IdentityAvatar color="#7c3aed" fallback="A" imageUrl={PHOTO} />
      );
      fireEvent.error(photoOf(container)!);
      expect(photoOf(container)).toBeNull();

      const replaced = `${PHOTO}#v2`;
      rerender(<IdentityAvatar color="#7c3aed" fallback="A" imageUrl={replaced} />);

      expect(photoOf(container)).toHaveAttribute('src', replaced);
    });

    it('fills the disc, keeps its shape, and names nobody', () => {
      // `alt=""` because the disc is decoration — the row's own text names the
      // identity, and "photo of Dorian" spoken before every message would be
      // noise. The radius is inherited rather than restated, so an agent's
      // square photo cannot round itself back into a person's circle.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" kind="agent" fallback="A" imageUrl={PHOTO} />
      );

      expect(photoOf(container)).toHaveAttribute('alt', '');
      expect(photoOf(container)).toHaveClass('size-full', 'object-cover', 'rounded-[inherit]');
      expect(discOf(container)).toHaveClass('rounded-lg');
    });

    it('keeps the badge and the working dot on top of a photo', () => {
      // The photo is the face, not the whole disc: an agent still wears its
      // mark and a working identity still pulses.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" kind="agent" imageUrl={PHOTO} status="working" />
      );

      expect(container.querySelector('.lucide-bot')).not.toBeNull();
      expect(container.querySelector('[data-slot="identity-status-dot"]')).not.toBeNull();
    });
  });

  describe('publishing the identity colour to CSS', () => {
    it('carries the colour as --identity-color, not only as a background', () => {
      // The keystone of the interaction grammar. An inline `background-color`
      // outranks every stylesheet rule, so while the colour lived only there
      // no `:hover` could tint it, ring it, or lend it to an ancestor. A
      // custom property inherits and IS reachable from a class string.
      const { container } = render(<IdentityAvatar color="#7c3aed" fallback="A" />);

      expect(discOf(container).style.getPropertyValue('--identity-color')).toBe('#7c3aed');
    });

    it('publishes the fill colour too, not just the tint', () => {
      // `fill` and `tint` compute different backgrounds from the same colour;
      // the property is the colour itself either way, so a Mark-tier ring on
      // an agent's square and on a person's circle are the same shade.
      const { container } = render(<IdentityAvatar color="#7c3aed" kind="agent" fallback="A" />);

      expect(discOf(container).style.getPropertyValue('--identity-color')).toBe('#7c3aed');
    });

    it('still lets a caller override the whole style object', () => {
      // Purely additive: `style` is spread last, exactly as it was before.
      const { container } = render(
        <IdentityAvatar color="#7c3aed" fallback="A" style={{ opacity: 0.5 }} />
      );
      const disc = discOf(container);

      expect(disc.style.opacity).toBe('0.5');
      expect(disc.style.getPropertyValue('--identity-color')).toBe('#7c3aed');
    });
  });

  describe('the badge wake', () => {
    const badgeOf = (container: HTMLElement) =>
      container.querySelector('[data-slot="identity-badge"]')!;

    it('tilts and grows the badge when the disc a pointer is on has opted in', () => {
      const { container } = render(<IdentityAvatar color="#7c3aed" kind="agent" fallback="A" />);
      const badge = badgeOf(container);

      expect(badge.className).toContain('group-hover/avatar:-rotate-6');
      expect(badge.className).toContain('group-hover/avatar:scale-110');
      // It pivots about the corner it is pinned to, so a rotating plate stays
      // inside the disc instead of swinging past its edge.
      expect(badge.className).toContain('origin-bottom-right');
    });

    it('is NAMED, for the reason the Mark group is', () => {
      // A bare `group-hover:` compiles to `:where(.group):hover &` and matches
      // ANY `.group` ancestor rather than the nearest — which is how the
      // sidebar's pane-wide unnamed group left every face permanently ringed in
      // slice 1. jsdom cannot see the consequence, but it can see the name.
      const { container } = render(<IdentityAvatar color="#7c3aed" kind="agent" fallback="A" />);
      const classes = badgeOf(container).className;

      expect(classes).not.toMatch(/(^|\s)group-hover:/);
    });

    it('stands completely still under reduced motion, end state included', () => {
      // A deliberate departure from the design spec's §2.6 table, which would
      // have kept the tilt and dropped only the travel. The rule that table
      // serves is "keep the fact, drop the motion" — and a 6° tilt carries no
      // fact, so there is nothing to keep. `motion-safe:` gates the whole
      // gesture rather than only its transition, which no CSS reset could do.
      const { container } = render(<IdentityAvatar color="#7c3aed" kind="agent" fallback="A" />);
      const classes = badgeOf(container).className;

      expect(classes).toContain('motion-safe:group-hover/avatar:-rotate-6');
      expect(classes).toContain('motion-safe:group-hover/avatar:scale-110');
      // No ungated twin: one would re-apply the end state under the preference.
      expect(classes).not.toMatch(/(^|\s)group-hover\/avatar:-rotate-6/);
      expect(classes).not.toMatch(/(^|\s)group-hover\/avatar:scale-110/);
    });

    it('carries the opt-in on every Mark-tier disc, since those are targets', () => {
      // A disc wearing the Mark tier is a target by definition, so the wake
      // rides along rather than being remembered at each call site.
      expect(identityMarkRing.self).toContain(IDENTITY_BADGE_WAKE);
      expect(identityMarkRing.group).toContain(IDENTITY_BADGE_WAKE);
    });

    it('does nothing on a disc nobody opted in', () => {
      // The wake is dormant by default: `group-hover/avatar:` matches only
      // under an ancestor carrying the name, and the disc does not add it
      // itself. This is what keeps twenty sidebar rows still.
      const { container } = render(<IdentityAvatar color="#7c3aed" kind="agent" fallback="A" />);

      expect(discOf(container).className).not.toContain(IDENTITY_BADGE_WAKE);
    });
  });

  it('contributes nothing to the accessibility tree on its own', () => {
    // An emoji has a spoken name nobody asked to hear; a caller that stands the
    // mark alone adds an sr-only label of its own.
    const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" />);

    expect(glyphOf(container)).toHaveAttribute('aria-hidden', 'true');
  });
});

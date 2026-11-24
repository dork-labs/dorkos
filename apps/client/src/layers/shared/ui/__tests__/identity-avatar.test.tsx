// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { IdentityAvatar } from '../identity-avatar';

/** A 1x1 transparent GIF. */
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

  describe('declining fill on a colour it cannot read a foreground for (DOR-998)', () => {
    // `fill` sets both the disc's background and the fallback letter's colour from the same
    // string.
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
  });

  describe('the badge slot', () => {
    it('marks an agent and leaves a person unmarked', () => {
      // The whole convention in one assertion: absence is the signal.
      const { container: agent } = render(
        <IdentityAvatar color="#7c3aed" emoji="🐙" badge={<span>⌁</span>} />
      );
      const { container: person } = render(<IdentityAvatar color="#7c3aed" fallback="P" />);

      expect(badgeOf(agent)).toHaveTextContent('⌁');
      expect(badgeOf(person)).toBeNull();
    });
  });

  describe('kind — what the identity IS, and the three props it decides', () => {
    it('draws an agent as a filled square wearing the Bot mark', () => {
      // The whole point of the prop: three decisions a caller used to make by hand — and got
      // wrong in 18 of the 20 places that draw an agent — now arrive together or not at all.
      const { container } = render(<IdentityAvatar color="#7c3aed" emoji="🐙" kind="agent" />);

      expect(discOf(container)).toHaveClass('rounded-lg');
      expect(discOf(container)).not.toHaveClass('rounded-full');
      expect(discOf(container).style.backgroundColor).toBe(fill('#7c3aed'));
      expect(badgeOf(container)?.querySelector('.lucide-bot')).not.toBeNull();
    });

    it('badges a bridged person with their platform’s own brand mark', () => {
      // "Someone on this machine wrote this" and "a stranger on the internet wrote this" have to
      // be legible at a glance, and the mark is the same one the connection surfaces draw for
      // that platform.
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
      // Colour is never the sole indicator.
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

    it('falls back to the emoji when the photo fails to load', () => {
      // A URL whose bytes have gone — a deleted file, an expired CDN object.
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
  });
});

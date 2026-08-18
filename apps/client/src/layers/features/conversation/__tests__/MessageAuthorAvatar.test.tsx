// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { MessageAuthor } from '@/layers/shared/model';
import { MessageAuthorAvatar } from '../ui/message/MessageAuthorAvatar';

afterEach(cleanup);

/**
 * The disc `MessageAuthorAvatar` draws. Its own `data-slot` overrides
 * `IdentityAvatar`'s default (the caller's prop spreads last), which is why
 * every query here is keyed on `message-author-avatar` rather than
 * `identity-avatar`.
 */
function discOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="message-author-avatar"]') as HTMLElement;
}

/** The corner badge, when the disc drew one — see `identity-avatar.test.tsx`'s own helper. */
function badgeOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-slot="message-author-avatar"] > span:nth-of-type(2)');
}

const AGENT: MessageAuthor = { kind: 'agent', id: 'ana', displayName: 'Ana' };
const HUMAN: MessageAuthor = { kind: 'human', id: 'human', displayName: 'You' };
const SYSTEM: MessageAuthor = { kind: 'system', id: 'system', displayName: 'System' };
const EXTERNAL_HUMAN: MessageAuthor = {
  kind: 'human',
  id: 'bo',
  displayName: 'Bo',
  isExternal: true,
};

describe('MessageAuthorAvatar', () => {
  describe('shape, fill and badge — mirrors IdentityHoverCard kind-by-kind', () => {
    it('draws an agent as a filled square with a Bot badge', () => {
      const { container } = render(<MessageAuthorAvatar author={AGENT} />);
      const disc = discOf(container);

      // Default IdentityAvatar size is `sm`, whose square radius is `rounded-lg`.
      expect(disc).toHaveClass('rounded-lg');
      expect(disc).not.toHaveClass('rounded-full');

      const badge = badgeOf(container);
      expect(badge).not.toBeNull();
      expect(badge!.querySelector('.lucide-bot')).not.toBeNull();
    });

    it('draws a local person as a tinted circle with no badge', () => {
      const { container } = render(<MessageAuthorAvatar author={HUMAN} />);

      expect(discOf(container)).toHaveClass('rounded-full');
      expect(badgeOf(container)).toBeNull();
    });

    it('draws the system voice the same undecorated circle as a local person', () => {
      const { container } = render(<MessageAuthorAvatar author={SYSTEM} />);

      expect(discOf(container)).toHaveClass('rounded-full');
      expect(badgeOf(container)).toBeNull();
    });

    it('marks a person bridged in from another platform with a Send badge, still a circle', () => {
      const { container } = render(<MessageAuthorAvatar author={EXTERNAL_HUMAN} />);

      expect(discOf(container)).toHaveClass('rounded-full');

      const badge = badgeOf(container);
      expect(badge).not.toBeNull();
      expect(badge!.querySelector('.lucide-send')).not.toBeNull();
    });
  });

  describe('colour — the filled agent disc has to stay legible with no stored colour', () => {
    it('fills the agent disc with a solid colour rather than a tint', () => {
      const { container } = render(<MessageAuthorAvatar author={{ ...AGENT, color: '#7c3aed' }} />);
      const probe = document.createElement('span');
      probe.style.backgroundColor = '#7c3aed';

      expect(discOf(container).style.backgroundColor).toBe(probe.style.backgroundColor);
    });

    it('keeps a person tinted rather than filled, even with a stored colour', () => {
      const { container } = render(<MessageAuthorAvatar author={{ ...HUMAN, color: '#7c3aed' }} />);
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'color-mix(in oklch, #7c3aed 18%, transparent)';

      expect(discOf(container).style.backgroundColor).toBe(probe.style.backgroundColor);
    });

    it('falls back to tint for a runtime-brand agent — readableForeground cannot parse a var() token', () => {
      // The session-chat runtime-fallback case (`resolveMessageAuthor`'s
      // `runtime` branch: no agent, no stored color) resolves `color` to the
      // runtime's accent, a theme token like `var(--color-orange-500)`.
      // `readableForeground` only parses hex/rgb()/hsl(), so a `fill` disc
      // here would always compute a near-white foreground no matter how light
      // that token actually renders — `tint` sidesteps the problem entirely.
      const { container } = render(
        <MessageAuthorAvatar author={{ ...AGENT, runtime: 'claude-code' }} />
      );
      const disc = discOf(container);
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'color-mix(in oklch, var(--color-orange-500) 18%, transparent)';

      expect(disc.style.backgroundColor).toBe(probe.style.backgroundColor);
      // Tint sets no explicit foreground — the near-white bug this guards
      // against would have shown up here as a computed `oklch(0.97 0 0)`.
      expect(disc.style.color).toBe('');
      // Still the agent shape — only the fill/tint choice changes.
      expect(disc).toHaveClass('rounded-lg');
    });

    it('falls back to a hashed fill for the common case: an agent with no stored colour', () => {
      // Verified live: ~5% of agents have a stored color, ~16% an icon — most
      // fill discs land on the hash, so the fallback glyph has to read on
      // whatever hue that lands on, not just on a hand-picked brand colour.
      const { container } = render(<MessageAuthorAvatar author={AGENT} />);
      const disc = discOf(container);

      expect(disc.style.backgroundColor).not.toBe('');
      // `IdentityAvatar`'s own `readableForeground` pass, not duplicated here —
      // a filled disc always sets a legible foreground for its fallback glyph.
      expect(disc.style.color).toMatch(/^oklch\(/);
    });
  });

  describe('face — emoji, runtime brand, letter, in that order', () => {
    it('draws the emoji when the author has one, ahead of the runtime brand', () => {
      const { container } = render(
        <MessageAuthorAvatar author={{ ...AGENT, emoji: '🎨', runtime: 'claude-code' }} />
      );

      expect(discOf(container)).toHaveTextContent('🎨');
    });

    it('falls back to the runtime brand mark when there is no emoji', () => {
      const { container } = render(
        <MessageAuthorAvatar author={{ ...AGENT, runtime: 'claude-code' }} />
      );

      expect(discOf(container).querySelector('svg')).not.toBeNull();
    });

    it('falls back to a letter when there is neither an emoji nor a runtime', () => {
      const { container } = render(<MessageAuthorAvatar author={AGENT} />);

      expect(discOf(container)).toHaveTextContent('A');
    });
  });

  it('is decorative: the display name sits beside it, so the mark is hidden from assistive tech', () => {
    const { container } = render(<MessageAuthorAvatar author={AGENT} />);

    expect(discOf(container)).toHaveAttribute('aria-hidden', 'true');
  });
});

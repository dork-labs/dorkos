import { describe, it, expect } from 'vitest';
import {
  resolveAgentIdentity,
  resolveNamedAgentIdentity,
  AGENT_DISPLAY_NAME_MAX,
} from '../normalize-agent-identity.js';

/** Unwrap a result the test expects to have succeeded. */
function ok(
  result: ReturnType<typeof resolveAgentIdentity> | ReturnType<typeof resolveNamedAgentIdentity>
) {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.error}`);
  return result.identity;
}

describe('resolveAgentIdentity', () => {
  describe('the name', () => {
    it('leaves a slug alone and invents no display name for it', () => {
      expect(ok(resolveAgentIdentity({ name: 'dorkos-cloud' }))).toEqual({
        name: 'dorkos-cloud',
      });
    });

    it('slugifies a display-style name and keeps the original', () => {
      expect(ok(resolveAgentIdentity({ name: 'DorkOS Cloud' }))).toEqual({
        name: 'dorkos-cloud',
        displayName: 'DorkOS Cloud',
      });
    });

    // The four addresses `packages/shared/src/handle.ts` measured against a real
    // fleet, plus the shapes `author-registry.ts` calls ordinary. Every one of
    // them registered fine before this module existed and must still, because
    // `mintHandle` derives an agent's `@handle` from `name` FIRST: changing one
    // moves an address somebody already types.
    it.each(['144mono', '144x.co', 'doriancollier.com', 'next_starter', '日本語', 'проект', '___'])(
      'leaves %s exactly as it came',
      (name) => {
        expect(ok(resolveAgentIdentity({ name }))).toEqual({ name });
      }
    );

    it('leaves a name that is not kebab-case but has no whitespace alone', () => {
      // Capitals are not what makes a label: the handle derives identically
      // either way, so rewriting the slug would move the address for nothing.
      expect(ok(resolveAgentIdentity({ name: 'Tangerines123' }))).toEqual({
        name: 'Tangerines123',
      });
    });

    it('leaves a label with nothing Latin in it alone rather than calling it "agent"', () => {
      expect(ok(resolveAgentIdentity({ name: '日本 語' }))).toEqual({ name: '日本 語' });
    });

    it('names nothing when the caller named nothing', () => {
      expect(ok(resolveAgentIdentity({}))).toEqual({});
    });

    it('refuses a blank name, the one name that cannot be stored', () => {
      for (const name of ['', '   ']) {
        const result = resolveAgentIdentity({ name });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe('INVALID_NAME');
      }
    });
  });

  describe('the fallback name', () => {
    it('takes the directory name untouched when the caller named nothing', () => {
      expect(ok(resolveNamedAgentIdentity({}, '144x.co'))).toEqual({ name: '144x.co' });
    });

    it('treats a directory name the same as an explicit one, because the app sends it as one', () => {
      // `buildRegistrationOverrides` puts `candidate.hints.suggestedName` — the
      // basename — into `overrides.name`, so there is no honest difference
      // between the two doors to make a rule out of.
      expect(ok(resolveNamedAgentIdentity({}, 'My Project'))).toEqual({
        name: 'my-project',
        displayName: 'My Project',
      });
      expect(ok(resolveNamedAgentIdentity({ name: 'My Project' }, 'ignored'))).toEqual({
        name: 'my-project',
        displayName: 'My Project',
      });
    });

    it('prefers the name the caller sent over the directory', () => {
      expect(ok(resolveNamedAgentIdentity({ name: 'chosen' }, 'ignored')).name).toBe('chosen');
    });
  });

  describe('the display name', () => {
    it('refuses one longer than the manifest holds, instead of failing in the writer', () => {
      const result = resolveAgentIdentity({
        name: 'bot',
        displayName: 'x'.repeat(AGENT_DISPLAY_NAME_MAX + 1),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_DISPLAY_NAME');
        expect(result.error).toContain(String(AGENT_DISPLAY_NAME_MAX));
      }
    });

    it('refuses a blank one', () => {
      const result = resolveAgentIdentity({ name: 'bot', displayName: '   ' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_DISPLAY_NAME');
    });

    it('cuts a DERIVED one between characters, never through one', () => {
      // 98 characters, then one more, then an emoji sitting exactly ON the cut.
      // `slice(AGENT_DISPLAY_NAME_MAX)` counts code UNITS, so it would keep the
      // emoji's high surrogate and drop its low one — half a character, which
      // no renderer can draw and no equality check can match.
      const straddling = `${'a '.repeat(49)}b\u{1F995} and then some more tail`;
      const identity = ok(resolveAgentIdentity({ name: straddling }));

      expect(identity.displayName!.endsWith('\u{1F995}')).toBe(true);
      // No unpaired surrogate anywhere: a high one with no low after it, or a
      // low one with no high before it.
      expect(identity.displayName).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
      expect(Array.from(identity.displayName!).length).toBe(AGENT_DISPLAY_NAME_MAX);
    });

    it('truncates a DERIVED one rather than failing the call', () => {
      // Nobody typed this as a display name — it is a long folder name, and
      // refusing would fail a registration over it.
      const long = `${'Very Long Name '.repeat(20)}end`;
      const identity = ok(resolveAgentIdentity({ name: long }));
      // At most the cap, and a trailing space left by the cut is trimmed off.
      expect(identity.displayName!.length).toBeLessThanOrEqual(AGENT_DISPLAY_NAME_MAX);
      expect(identity.displayName!.length).toBeGreaterThan(AGENT_DISPLAY_NAME_MAX - 5);
      expect(long.startsWith(identity.displayName!)).toBe(true);
    });

    it('trims an explicit one', () => {
      expect(ok(resolveAgentIdentity({ name: 'bot', displayName: '  Bot  ' })).displayName).toBe(
        'Bot'
      );
    });

    it('prefers an explicit one over the derived one', () => {
      expect(ok(resolveAgentIdentity({ name: 'DorkOS Cloud', displayName: 'The Cloud' }))).toEqual({
        name: 'dorkos-cloud',
        displayName: 'The Cloud',
      });
    });
  });

  describe('the face', () => {
    it('stores a colour in the one spelling the picker matches against', () => {
      expect(ok(resolveAgentIdentity({ color: '  #ABC  ' })).color).toBe('#aabbcc');
      expect(ok(resolveAgentIdentity({ color: '#EC4899' })).color).toBe('#ec4899');
    });

    it('stores an emoji trimmed', () => {
      expect(ok(resolveAgentIdentity({ icon: ' 🔮 ' })).icon).toBe('🔮');
    });

    it('refuses an icon that is not exactly one emoji', () => {
      const result = resolveAgentIdentity({ icon: 'sparkles' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ICON');
        expect(result.error).toContain('exactly one emoji');
      }
    });

    it('refuses a colour that is not hex', () => {
      const result = resolveAgentIdentity({ color: 'pinkish' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_COLOR');
        expect(result.error).toContain('#ec4899');
      }
    });
  });
});

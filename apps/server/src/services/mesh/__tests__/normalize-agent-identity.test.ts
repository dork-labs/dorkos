import { describe, it, expect } from 'vitest';
import { resolveAgentIdentity, AGENT_DISPLAY_NAME_MAX } from '../normalize-agent-identity.js';

/** Unwrap a result the test expects to have succeeded. */
function ok(result: ReturnType<typeof resolveAgentIdentity>) {
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

    it('falls back to the name the caller gave it, slugified the same way', () => {
      expect(ok(resolveAgentIdentity({}, 'My Project'))).toEqual({
        name: 'my-project',
        displayName: 'My Project',
      });
    });

    it('names nothing when the caller named nothing and there is no fallback', () => {
      expect(ok(resolveAgentIdentity({}))).toEqual({});
    });

    it('refuses a name with nothing to make a slug of', () => {
      // `slugifyAgentName` answers 'agent' for these, which is a silent rename
      // to a name nobody chose.
      for (const name of ['', '   ', '!!!']) {
        const result = resolveAgentIdentity({ name });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe('INVALID_NAME');
      }
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

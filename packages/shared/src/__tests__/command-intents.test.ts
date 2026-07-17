import { describe, it, expect } from 'vitest';
import {
  COMMAND_INTENTS,
  resolveCommandIntent,
  commandIntentTokens,
  type CommandIntentId,
} from '../command-intents.js';

describe('command-intents registry', () => {
  it('has exactly the three canonical intents', () => {
    // Purpose: the operator decision locks exactly three intents — a fourth is a
    // separate issue, so guard against accidental additions/removals.
    expect(COMMAND_INTENTS.map((intent) => intent.id)).toEqual(['compact', 'clear', 'context']);
  });

  describe('resolveCommandIntent', () => {
    it('maps every canonical token to its own intent', () => {
      // Purpose: the canonical slash token always resolves to its descriptor.
      for (const intent of COMMAND_INTENTS) {
        expect(resolveCommandIntent(intent.canonical)?.id).toBe(intent.id);
      }
    });

    it('maps every alias to its parent intent', () => {
      // Purpose: cross-agent muscle memory (e.g. /compress, /usage) folds into
      // the right canonical intent so switching runtimes keeps fingers working.
      for (const intent of COMMAND_INTENTS) {
        for (const alias of intent.aliases) {
          expect(resolveCommandIntent(alias)?.id).toBe(intent.id);
        }
      }
    });

    it('resolves case-insensitively and with or without a leading slash', () => {
      // Purpose: normalization (trim → prepend '/' → lowercase) means typed
      // casing and a missing slash never break recognition.
      expect(resolveCommandIntent('/COMPACT')?.id).toBe('compact');
      expect(resolveCommandIntent('compact')?.id).toBe('compact');
      expect(resolveCommandIntent('  /Compress  ')?.id).toBe('compact');
      expect(resolveCommandIntent('SUMMARIZE')?.id).toBe('compact');
      expect(resolveCommandIntent('New-Chat')?.id).toBe('clear');
      expect(resolveCommandIntent('/StAtUs')?.id).toBe('context');
    });

    it('returns null for unknown tokens', () => {
      // Purpose: an unrelated command falls through to the runtime/composer.
      expect(resolveCommandIntent('/model')).toBeNull();
      expect(resolveCommandIntent('/frobnicate')).toBeNull();
      expect(resolveCommandIntent('')).toBeNull();
      expect(resolveCommandIntent('/')).toBeNull();
    });

    it('returns null for near-misses (prefix collisions do not match)', () => {
      // Purpose: only an exact token match resolves — a superstring like
      // /summarizefoo must NOT be swallowed by the /summarize alias.
      expect(resolveCommandIntent('/summarizefoo')).toBeNull();
      expect(resolveCommandIntent('/compactor')).toBeNull();
      expect(resolveCommandIntent('/newish')).toBeNull();
    });
  });

  describe('commandIntentTokens', () => {
    it('contains every canonical + alias token and nothing else', () => {
      // Purpose: the palette dedupe pass relies on this set being exactly the
      // union of canonical + alias tokens (lowercased, '/'-prefixed).
      const expected = new Set<string>();
      for (const intent of COMMAND_INTENTS) {
        expected.add(intent.canonical);
        for (const alias of intent.aliases) expected.add(alias);
      }
      const tokens = commandIntentTokens();
      expect(tokens).toEqual(expected);
      // Every token resolves back to an intent — nothing extraneous leaked in.
      for (const token of tokens) {
        expect(resolveCommandIntent(token)).not.toBeNull();
      }
    });
  });

  describe('fulfillment seams', () => {
    it('splits runtime-fulfilled compact from client-native clear/context', () => {
      // Purpose: the two-seam design — only compact is runtime-fulfilled (gated
      // by RuntimeCapabilities); clear/context are DorkOS-native client actions.
      const fulfillment = Object.fromEntries(
        COMMAND_INTENTS.map((intent) => [intent.id, intent.fulfillment])
      ) as Record<CommandIntentId, string>;
      expect(fulfillment.compact).toBe('runtime');
      expect(fulfillment.clear).toBe('client-native');
      expect(fulfillment.context).toBe('client-native');
    });
  });
});

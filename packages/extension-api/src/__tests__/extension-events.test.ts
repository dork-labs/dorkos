import { describe, it, expect } from 'vitest';
import {
  EXTENSION_EVENT_KINDS,
  EXTENSION_EVENT_CATEGORIES,
  EXTENSION_EVENT_DECLARATIONS,
  extensionEventCategory,
  isExtensionEventDeclared,
} from '../extension-events.js';

describe('extensionEventCategory', () => {
  it('derives the category from a kind', () => {
    expect(extensionEventCategory('turn.completed')).toBe('turn');
    expect(extensionEventCategory('tool.activity')).toBe('tool');
    expect(extensionEventCategory('session.switched')).toBe('session');
    expect(extensionEventCategory('relay.message')).toBe('relay');
  });

  it('every kind maps to a known category', () => {
    for (const kind of EXTENSION_EVENT_KINDS) {
      expect(EXTENSION_EVENT_CATEGORIES).toContain(extensionEventCategory(kind));
    }
  });
});

describe('isExtensionEventDeclared', () => {
  it('authorizes a kind named directly', () => {
    expect(isExtensionEventDeclared('turn.completed', ['turn.completed'])).toBe(true);
  });

  it('authorizes a kind via its category', () => {
    expect(isExtensionEventDeclared('turn.completed', ['turn'])).toBe(true);
    expect(isExtensionEventDeclared('session.started', ['session'])).toBe(true);
  });

  it('rejects a kind neither named nor covered by a category', () => {
    expect(isExtensionEventDeclared('tool.activity', ['session', 'turn'])).toBe(false);
  });

  it('rejects against an empty declaration list', () => {
    expect(isExtensionEventDeclared('relay.message', [])).toBe(false);
  });

  it('does not let one category leak into a sibling category', () => {
    // Declaring the `turn` category must not authorize `tool.*` kinds.
    expect(isExtensionEventDeclared('tool.activity', ['turn'])).toBe(false);
  });
});

describe('EXTENSION_EVENT_DECLARATIONS', () => {
  it('is the union of kinds and categories', () => {
    expect(EXTENSION_EVENT_DECLARATIONS).toEqual([
      ...EXTENSION_EVENT_KINDS,
      ...EXTENSION_EVENT_CATEGORIES,
    ]);
  });
});

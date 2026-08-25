import { describe, expect, it } from 'vitest';

import { renderProvenanceSuffix } from '../provenance.js';

describe('renderProvenanceSuffix', () => {
  it('names the room a note was learned in', () => {
    expect(renderProvenanceSuffix({ room: '#general', date: '2026-08-24' })).toBe(
      '(noted in #general, 2026-08-24)'
    );
  });

  it('says "a direct chat" when there was no room', () => {
    // The two shapes are the whole vocabulary. A third — an empty room name, a
    // bare "(noted 2026-08-24)" — would leave the operator unable to tell where
    // a belief came from, which is the point of the suffix.
    expect(renderProvenanceSuffix({ room: null, date: '2026-08-24' })).toBe(
      '(noted in a direct chat, 2026-08-24)'
    );
  });

  it('renders a bridged room label exactly as it was given', () => {
    // Not every room is a #channel. Decorating the label would put a hash in
    // front of names that are not channels.
    expect(renderProvenanceSuffix({ room: 'the Telegram group', date: '2026-01-01' })).toBe(
      '(noted in the Telegram group, 2026-01-01)'
    );
  });
});

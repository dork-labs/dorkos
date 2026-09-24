import { describe, expect, it } from 'vitest';
import { parseTakedownCommand } from '../takedown/commands.js';

describe('parseTakedownCommand', () => {
  // Purpose: the offline takedown commands act on one takedown by id; a malformed call must do
  // nothing rather than guess.
  it('parses the two commands with one takedown id', () => {
    const id = 'A0000000-0000-4000-8000-000000000000';
    expect(parseTakedownCommand(['evidence-retry', id])).toEqual({
      kind: 'evidence-retry',
      takedownId: id.toLowerCase(),
    });
    expect(parseTakedownCommand(['release-held', id])).toEqual({
      kind: 'release-held',
      takedownId: id.toLowerCase(),
    });
  });

  it('refuses anything else', () => {
    for (const argv of [
      [],
      ['release-held'],
      ['release-held', 'not-an-id'],
      ['release-held', 'a0000000-0000-4000-8000-000000000000', 'extra'],
      ['delete', 'a0000000-0000-4000-8000-000000000000'],
    ])
      expect(() => parseTakedownCommand(argv), argv.join(' ')).toThrow();
  });
});

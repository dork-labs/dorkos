// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createEditor, type LexicalEditor } from 'lexical';
import { COMPOSER_NODES } from '../lexical-nodes';
import { $parseComposerMarkdown, $serializeWithOffsets } from '../markdown-offsets';
import { ROUND_TRIP_CORPUS } from './round-trip-corpus';

/** A headless editor with the composer's node set. No React, no field. */
function makeEditor(): LexicalEditor {
  return createEditor({
    namespace: 'composer-test',
    nodes: COMPOSER_NODES,
    onError: (error) => {
      throw error;
    },
  });
}

/** Parse `md`, then write the document back out. */
function roundTrip(md: string, editor: LexicalEditor = makeEditor()): string {
  let out = '';
  editor.update(
    () => {
      $parseComposerMarkdown(md);
    },
    { discrete: true }
  );
  editor.read(() => {
    out = $serializeWithOffsets().markdown;
  });
  return out;
}

describe('the markdown round trip', () => {
  it.each(
    ROUND_TRIP_CORPUS.filter((entry) => entry.normalizesTo === undefined).map((entry) => [
      JSON.stringify(entry.md),
      entry.md,
    ])
  )('%s survives byte for byte', (_label, md) => {
    expect(roundTrip(md)).toBe(md);
  });

  it.each(
    ROUND_TRIP_CORPUS.filter((entry) => entry.normalizesTo !== undefined).map((entry) => [
      JSON.stringify(entry.md),
      entry,
    ])
  )('%s normalizes to exactly one known spelling', (_label, entry) => {
    expect(entry.normalizesTo).toBeDefined();
    // A normalization without a stated reason is a bug someone accepted.
    expect(entry.why, `${entry.md} normalizes but says no why`).toBeTruthy();
    expect(roundTrip(entry.md)).toBe(entry.normalizesTo);
  });

  // THE property the controlled loop depends on. One pass may normalize; a
  // second pass may not move at all. If it does, the host writes V, the editor
  // emits V', the host writes V', the editor emits V'' — and the caret is
  // destroyed on every keystroke.
  it.each(ROUND_TRIP_CORPUS.map((entry) => [JSON.stringify(entry.md), entry.md]))(
    '%s reaches a fixed point in one pass',
    (_label, md) => {
      const once = roundTrip(md);
      expect(roundTrip(once)).toBe(once);
    }
  );

  it('states a reason for every normalization it accepts', () => {
    const unexplained = ROUND_TRIP_CORPUS.filter(
      (entry) => entry.normalizesTo !== undefined && !entry.why
    );
    expect(unexplained).toEqual([]);
  });
});

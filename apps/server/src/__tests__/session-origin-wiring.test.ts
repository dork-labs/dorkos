/**
 * The global session-list stream is wired to the origin lookups, in the
 * composition root, before it starts (DOR-1141).
 *
 * ## Why this is a source scan and not a behavioural test
 *
 * `SessionListBroadcaster` is unit-tested to stamp origin onto every
 * `session_upserted` once `setOriginResolvers` has been called, and to keep
 * those resolvers across the stop/start a live account switch performs. All of
 * that is true of an instance nobody ever hands the resolvers to — the
 * broadcaster defaults to an empty set and degrades silently to the
 * pre-DOR-1141 behaviour, which is a room turn reading as the operator's own
 * conversation on every consumer of the human-origin liveness rule
 * (design-decisions §18).
 *
 * The one line that closes that gap lives in `index.ts`, in a function that
 * boots the entire server. Deleting it breaks nothing that any suite can see:
 * no type changes, no test reds, and the failure surfaces only as a subtly
 * wrong reading in a running cockpit. Reviewing this branch, that deletion was
 * performed and every suite stayed green — which is what makes the scan worth
 * having rather than a formality.
 *
 * ## And why the ORDER is asserted too
 *
 * Resolvers set after `start()` would leave a window — short, but real, and
 * indistinguishable from correct on any test that does not measure it — in
 * which the first upserts a freshly booted server fans out carry no origin.
 * Asserting the position is what makes the guard about the wiring being
 * EFFECTIVE rather than merely present.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The composition root, resolved from this file rather than from the cwd. */
const INDEX_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts');

/** `index.ts` as source text. A read failure throws rather than passing empty. */
function compositionRoot(): string {
  return readFileSync(INDEX_TS, 'utf-8');
}

/**
 * The lines of `index.ts` that are CODE, with comment lines blanked out.
 *
 * Not cosmetic: `index.ts` twice explains itself with the phrase
 * "`sessionListBroadcaster.start()` below", and a plain search for the call
 * finds those sentences hundreds of lines above the real one — so the ordering
 * assertion below would compare a comment against a call and fail on a
 * correctly wired file. Blanking rather than dropping keeps line indices
 * meaningful for anyone debugging this.
 *
 * Line-level and deliberately simple: every mention this guard cares about sits
 * on its own line, in a file with no trailing `/* … *\/` after code.
 */
function codeLines(): string[] {
  return compositionRoot()
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
        ? ''
        : line;
    });
}

/** The index of the first code line containing `needle`, or -1. */
function lineOf(needle: string): number {
  return codeLines().findIndex((line) => line.includes(needle));
}

const WIRING = 'sessionListBroadcaster.setOriginResolvers(';
const START = 'sessionListBroadcaster.start(';

describe('the composition root wires the session-list stream to the origin lookups', () => {
  it('calls setOriginResolvers at all', () => {
    expect(
      lineOf(WIRING) > -1,
      'index.ts no longer hands the room/Pulse origin lookups to the session-list ' +
        'broadcaster. Without them every session_upserted goes out with no origin, and ' +
        'the palette Continue list and the sidebar rollups read a room turn as your own ' +
        'conversation (DOR-1141). Restore `sessionListBroadcaster.setOriginResolvers(' +
        'sessionOriginResolvers(app.locals))` before the broadcaster is started.'
    ).toBe(true);
  });

  it('wires them BEFORE starting the broadcaster', () => {
    const wiring = lineOf(WIRING);
    const start = lineOf(START);
    expect(start, `${START} is not called in index.ts at all`).toBeGreaterThan(-1);
    expect(
      wiring,
      'The origin lookups are wired after the session-list broadcaster starts, so the ' +
        'first upserts a freshly booted server fans out carry no origin (DOR-1141).'
    ).toBeLessThan(start);
  });

  it('is really reading index.ts, and would notice a call that vanished', () => {
    // A scan that found nothing satisfies "not present" for free, so an empty or
    // wrong file would make the two assertions above meaningless in one
    // direction. Prove the source is here, and that a name NOT in it reports
    // absent — the same search, with a known answer.
    expect(codeLines().length).toBeGreaterThan(100);
    expect(lineOf('sessionListBroadcaster')).toBeGreaterThan(-1);
    expect(lineOf('sessionListBroadcaster.setOriginResolversNOPE(')).toBe(-1);
  });
});

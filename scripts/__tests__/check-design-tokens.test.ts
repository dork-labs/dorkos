import { describe, expect, it } from 'vitest';
import { RULES, compare, countIn, lowered, raisedAgainst } from '../check-design-tokens.ts';

const UI = 'packages/ui/src/thing.tsx';
const CLIENT = 'apps/client/src/thing.tsx';

describe('countIn', () => {
  it('finds each pattern', () => {
    expect(countIn(CLIENT, `'bg-black/80 text-white focus-visible:ring-2 bg-red-500'`)).toEqual({
      'black-scrim': 1,
      'raw-palette': 1,
      'pure-white-black': 1,
      'stray-focus-ring': 1,
    });
  });

  it('counts a literal z-index only in the package', () => {
    expect(countIn(UI, `'z-50 z-[60]'`)).toEqual({ 'literal-z-index': 2 });
    expect(countIn(CLIENT, `'z-50'`)).toEqual({});
  });

  it('leaves the tokens and look-alikes alone', () => {
    const clean = `'bg-scrim z-(--z-overlay) text-white-ish md:z-5 bg-brand/15 #fffae0'`;
    expect(countIn(UI, clean)).toEqual({});
  });

  it('counts the pure hexes in both lengths', () => {
    expect(countIn(CLIENT, `'#fff #000000 #FFF'`)).toEqual({ 'pure-white-black': 3 });
  });
});

describe('the count and badge rules (Phase 2 Badge A)', () => {
  const PILL = 'apps/client/src/layers/shared/ui/count-pill.tsx';
  const THREAD = 'apps/client/src/layers/features/conversation/ui/rows/ThreadReplyRow.tsx';

  it('refuses a local cap, except where the caps are spelled', () => {
    expect(countIn(CLIENT, `const DISPLAY_CAP = 9; const MAX_COUNT = 99;`)).toEqual({
      'local-count-cap': 2,
    });
    expect(countIn(PILL, `export const COUNT_PILL_CAP = 99;`)).toEqual({});
    expect(countIn(CLIENT, `import { COUNT_PILL_CAP } from '@/layers/shared/ui';`)).toEqual({});
  });

  it('refuses a hand-rolled count on one line, in either order', () => {
    const text = `'rounded-full px-1.5 tabular-nums'\n'tabular-nums text-xs rounded-full'\n'tabular-nums'`;
    expect(countIn(CLIENT, text)).toEqual({ 'hand-rolled-count': 2 });
    expect(countIn(PILL, text)).toEqual({});
  });

  it('keeps the count flip to the thread reply row', () => {
    expect(countIn(CLIENT, `'motion-safe:animate-count-flip'`)).toEqual({ 'count-flip': 1 });
    expect(countIn(THREAD, `'motion-safe:animate-count-flip'`)).toEqual({});
  });
});

describe('compare', () => {
  it('fails a hard rule even when the baseline names it', () => {
    const counts = { 'black-scrim': { [CLIENT]: 1 } };
    expect(compare(counts, counts).map((f) => f.kind)).toEqual(['hard']);
  });

  it('holds a ratchet level, fails a rise, and asks for an update on a fall', () => {
    const baseline = { 'raw-palette': { [CLIENT]: 2 } };
    expect(compare({ 'raw-palette': { [CLIENT]: 2 } }, baseline)).toEqual([]);
    expect(compare({ 'raw-palette': { [CLIENT]: 3 } }, baseline)[0]?.kind).toBe('grew');
    expect(compare({ 'raw-palette': { [CLIENT]: 1 } }, baseline)[0]?.kind).toBe('stale');
    expect(compare({}, baseline)[0]?.kind).toBe('stale');
  });

  it('starts a new file at zero', () => {
    expect(compare({ 'raw-palette': { [UI]: 1 } }, {})[0]).toMatchObject({
      kind: 'grew',
      baseline: 0,
    });
  });
});

describe('the baseline only goes down', () => {
  it('refuses a raised or added entry', () => {
    const base = { 'raw-palette': { [CLIENT]: 2 } };
    expect(raisedAgainst({ 'raw-palette': { [CLIENT]: 2 } }, base)).toEqual([]);
    expect(raisedAgainst({ 'raw-palette': { [CLIENT]: 3 } }, base)[0]?.kind).toBe('raised');
    expect(raisedAgainst({ 'raw-palette': { [UI]: 1 } }, base)[0]?.kind).toBe('raised');
  });

  it('update lowers and removes, and never raises or adds', () => {
    const baseline = { 'raw-palette': { [CLIENT]: 2, [UI]: 4 } };
    expect(lowered({ 'raw-palette': { [CLIENT]: 9 } }, baseline)).toEqual({
      'raw-palette': { [CLIENT]: 2 },
    });
    expect(lowered({ 'stray-focus-ring': { [CLIENT]: 1 } }, baseline)).toEqual({});
  });
});

describe('RULES', () => {
  it('every pattern is global, or countIn would stop at the first match', () => {
    expect(RULES.filter((r) => !r.pattern.global)).toEqual([]);
  });
});

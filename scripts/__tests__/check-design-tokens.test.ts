import { describe, expect, it } from 'vitest';
import { compare, lowered, raisedAgainst, ROWS } from '../check-design-tokens';

const row = (id: string) => ROWS.find((r) => r.id === id)!;

describe('the motion rows', () => {
  it('counts a spring literal', () => {
    const text = "{ type: 'spring', stiffness: 400 } // { stiffness: 1 }";
    expect(row('spring-literal').count(text)).toBe(2);
  });

  it('never applies the spring row to the motion module', () => {
    expect(row('spring-literal').skip?.test('apps/client/src/layers/shared/lib/motion.ts')).toBe(
      true
    );
  });

  it.each([
    ['a y above 1', 'animation: x 1s cubic-bezier(0.2, 1.4, 0.4, 1);', 1],
    ['a y below 0', 'animation: x 1s cubic-bezier(0.2, -0.4, 0.4, 1);', 1],
    ['a curve that stays in range', 'animation: x 1s cubic-bezier(0.4, 0, 0.2, 1);', 0],
    ['the reaction pop', 'animation: reaction-pop 1s cubic-bezier(0.2, 1.8, 0.35, 1);', 0],
    ['a comment', '/* cubic-bezier(0.2, 1.4, 0.4, 1) */', 0],
  ])('overshoot row on %s', (_name, text, expected) => {
    expect(row('overshoot-bezier').count(text)).toBe(expected);
  });
});

describe('compare', () => {
  it('fails a banned match', () => {
    const findings = compare({ 'overshoot-bezier': { 'a.css': 1 } }, {});
    expect(findings.map((f) => f.kind)).toEqual(['banned']);
  });

  it('fails a count that rose, and a file that is new', () => {
    const findings = compare(
      { 'spring-literal': { 'a.ts': 3, 'new.ts': 1 } },
      { 'spring-literal': { 'a.ts': 2 } }
    );
    expect(findings.map((f) => [f.kind, f.file])).toEqual([
      ['grew', 'a.ts'],
      ['grew', 'new.ts'],
    ]);
  });

  it('asks for an update when a count fell or a file went clean', () => {
    const findings = compare(
      { 'spring-literal': { 'a.ts': 1 } },
      { 'spring-literal': { 'a.ts': 2, 'b.ts': 1 } }
    );
    expect(findings.map((f) => [f.kind, f.file])).toEqual([
      ['stale', 'a.ts'],
      ['stale', 'b.ts'],
    ]);
  });

  it('passes when the counts match', () => {
    const counts = { 'spring-literal': { 'a.ts': 2 } };
    expect(compare(counts, counts)).toEqual([]);
  });
});

describe('the baseline only goes down', () => {
  it('refuses a raised entry and an added one', () => {
    const findings = raisedAgainst(
      { 'spring-literal': { 'a.ts': 3, 'b.ts': 1 } },
      { 'spring-literal': { 'a.ts': 2 } }
    );
    expect(findings.map((f) => f.file)).toEqual(['a.ts', 'b.ts']);
  });

  it('lets a new row arrive with its own baseline', () => {
    expect(raisedAgainst({ 'spring-literal': { 'a.ts': 3 } }, {})).toEqual([]);
  });

  it('lowers and removes on update, and never raises or adds', () => {
    expect(
      lowered(
        { 'spring-literal': { 'a.ts': 1, 'c.ts': 9, 'd.ts': 9 } },
        { 'spring-literal': { 'a.ts': 2, 'b.ts': 1, 'c.ts': 4 } }
      )
    ).toEqual({ 'spring-literal': { 'a.ts': 1, 'c.ts': 4 } });
  });
});

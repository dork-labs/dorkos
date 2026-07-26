import { describe, it, expect } from 'vitest';
import { buildCanaryReport, parseCanary } from '../canary.js';

describe('parseCanary', () => {
  it('parses well-formed lines and ignores the trailing newline', () => {
    const { lines, malformed } = parseCanary('cats 0 2026-07-25T00:00:00.000Z\ndogs 1 x\n');
    expect(lines).toEqual([
      { vocab: 'cats', seq: 0 },
      { vocab: 'dogs', seq: 1 },
    ]);
    expect(malformed).toBe(0);
  });

  it('counts torn lines instead of dropping them silently', () => {
    // A concurrent whole-file rewrite can leave a half-written line behind.
    const { lines, malformed } = parseCanary('cats 0 ok\ncats 1 ok\ncats 2 ok\ncats 3');
    expect(lines).toHaveLength(3);
    expect(malformed).toBe(1);
  });
});

describe('buildCanaryReport', () => {
  it('reports zero missing when every reported line survived', () => {
    const text = 'cats 0 t\ncats 1 t\ndogs 0 t\n';
    const report = buildCanaryReport('/tmp/c.log', text, { cats: 2, dogs: 1 });
    expect(report.totalLines).toBe(3);
    expect(report.reportedTotal).toBe(3);
    expect(report.missingTotal).toBe(0);
    expect(report.byVocab.cats).toEqual({
      survived: 2,
      reported: 2,
      missing: 0,
      maxSeq: 1,
      duplicates: 0,
    });
  });

  it('counts lost updates per vocabulary and in total', () => {
    // dogs wrote 5 lines; a concurrent rewrite clobbered 3 of them.
    const text = 'cats 0 t\ncats 1 t\ndogs 3 t\ndogs 4 t\n';
    const report = buildCanaryReport('/tmp/c.log', text, { cats: 2, dogs: 5 });
    expect(report.missingTotal).toBe(3);
    expect(report.byVocab.dogs?.missing).toBe(3);
    expect(report.byVocab.dogs?.survived).toBe(2);
    // maxSeq well above the survivor count is the signature of a lost prefix.
    expect(report.byVocab.dogs?.maxSeq).toBe(4);
    expect(report.byVocab.cats?.missing).toBe(0);
  });

  it('reports a vocabulary that was wiped out entirely', () => {
    const report = buildCanaryReport('/tmp/c.log', 'cats 0 t\n', { cats: 1, birds: 9 });
    expect(report.byVocab.birds).toEqual({
      survived: 0,
      reported: 9,
      missing: 9,
      maxSeq: -1,
      duplicates: 0,
    });
    expect(report.missingTotal).toBe(9);
  });

  it('counts duplicated sequence numbers without inflating survivors', () => {
    const report = buildCanaryReport('/tmp/c.log', 'cats 0 t\ncats 0 t\ncats 1 t\n', { cats: 2 });
    expect(report.totalLines).toBe(3);
    expect(report.survivedTotal).toBe(2);
    expect(report.byVocab.cats?.survived).toBe(2);
    expect(report.byVocab.cats?.duplicates).toBe(1);
    expect(report.byVocab.cats?.missing).toBe(0);
  });

  it('keeps missingTotal on the same basis as every per-vocab missing', () => {
    // A duplicate inflates totalLines but not survivors. Deriving missingTotal
    // from the raw line count would report -1 here while the breakdown reports
    // 0, which is the disagreement this asserts against.
    const report = buildCanaryReport('/tmp/c.log', 'cats 0 t\ncats 0 t\ncats 1 t\ndogs 0 t\n', {
      cats: 2,
      dogs: 3,
    });
    const sumOfParts = Object.values(report.byVocab).reduce((sum, v) => sum + v.missing, 0);
    expect(report.missingTotal).toBe(sumOfParts);
    expect(report.missingTotal).toBe(2);
    expect(report.totalLines).toBe(4);
    expect(report.survivedTotal).toBe(3);
  });

  it('carries the method and the interpretation caveat into every report', () => {
    // These strings are what stop a canary shortfall escaping into a doc as a
    // corruption rate for real agents; they must ride with the number.
    const report = buildCanaryReport('/tmp/c.log', '', { cats: 1 });
    expect(report.method).toMatch(/no lock, no atomic rename/);
    expect(report.caveat).toMatch(/NOT a corruption rate/);
    expect(report.caveat).toMatch(/preregistration/);
  });

  it('surfaces lines from a vocabulary that reported nothing', () => {
    const report = buildCanaryReport('/tmp/c.log', 'moths 7 t\n', {});
    expect(report.byVocab.moths?.survived).toBe(1);
    expect(report.byVocab.moths?.reported).toBe(0);
  });

  it('handles an empty canary', () => {
    const report = buildCanaryReport('/tmp/c.log', '', { cats: 4 });
    expect(report.totalLines).toBe(0);
    expect(report.malformedLines).toBe(0);
    expect(report.missingTotal).toBe(4);
  });
});

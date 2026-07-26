import { describe, it, expect } from 'vitest';
import { assertOverlap, computeOverlap } from '../overlap.js';

describe('computeOverlap', () => {
  it('finds the common window when every interval intersects', () => {
    const report = computeOverlap([
      { label: 'cats', startMs: 100, endMs: 900 },
      { label: 'dogs', startMs: 200, endMs: 800 },
      { label: 'birds', startMs: 150, endMs: 850 },
    ]);
    expect(report.allOverlap).toBe(true);
    expect(report.commonStartMs).toBe(200);
    expect(report.commonEndMs).toBe(800);
    expect(report.commonWidthMs).toBe(600);
    expect(report.disjointPairs).toEqual([]);
  });

  it('rejects politely-serialized turns and names the disjoint pair', () => {
    const report = computeOverlap([
      { label: 'cats', startMs: 0, endMs: 100 },
      { label: 'dogs', startMs: 300, endMs: 400 },
    ]);
    expect(report.allOverlap).toBe(false);
    expect(report.disjointPairs).toEqual([{ a: 'cats', b: 'dogs', gapMs: 200 }]);
  });

  it('treats touching intervals as not overlapping', () => {
    const report = computeOverlap([
      { label: 'cats', startMs: 0, endMs: 100 },
      { label: 'dogs', startMs: 100, endMs: 200 },
    ]);
    expect(report.allOverlap).toBe(false);
    expect(report.commonWidthMs).toBe(0);
    expect(report.disjointPairs).toHaveLength(1);
  });

  it('fails the whole set when one agent misses the window, even if pairs overlap', () => {
    // cats↔dogs and dogs↔birds overlap, but no single instant covers all three.
    const report = computeOverlap([
      { label: 'cats', startMs: 0, endMs: 200 },
      { label: 'dogs', startMs: 100, endMs: 400 },
      { label: 'birds', startMs: 300, endMs: 500 },
    ]);
    expect(report.allOverlap).toBe(false);
    expect(report.disjointPairs).toEqual([{ a: 'cats', b: 'birds', gapMs: 100 }]);
  });

  it('narrows the common window to the tightest nested interval', () => {
    const report = computeOverlap([
      { label: 'cats', startMs: 0, endMs: 1000 },
      { label: 'dogs', startMs: 400, endMs: 500 },
    ]);
    expect(report.commonWidthMs).toBe(100);
    expect(report.minPairwiseOverlapMs).toBe(100);
  });

  it('refuses a single interval — concurrency was never exercised', () => {
    expect(() => computeOverlap([{ label: 'cats', startMs: 0, endMs: 10 }])).toThrow(
      /at least 2 turn intervals/
    );
  });

  it('refuses an inverted or zero-width interval', () => {
    expect(() =>
      computeOverlap([
        { label: 'cats', startMs: 100, endMs: 100 },
        { label: 'dogs', startMs: 0, endMs: 200 },
      ])
    ).toThrow(/non-positive turn interval/);
  });
});

describe('assertOverlap', () => {
  it('passes a genuine overlap that clears the floor', () => {
    const report = computeOverlap([
      { label: 'cats', startMs: 0, endMs: 5000 },
      { label: 'dogs', startMs: 100, endMs: 5100 },
    ]);
    expect(() => assertOverlap(report, 2000)).not.toThrow();
  });

  it('throws loudly when the agents never ran concurrently', () => {
    const report = computeOverlap([
      { label: 'cats', startMs: 0, endMs: 100 },
      { label: 'dogs', startMs: 200, endMs: 300 },
    ]);
    expect(() => assertOverlap(report, 0)).toThrow(/OVERLAP PROOF FAILED/);
  });

  it('throws when the common window is too narrow to be meaningful', () => {
    const report = computeOverlap([
      { label: 'cats', startMs: 0, endMs: 1000 },
      { label: 'dogs', startMs: 900, endMs: 2000 },
    ]);
    expect(() => assertOverlap(report, 2000)).toThrow(/only 100ms/);
  });
});

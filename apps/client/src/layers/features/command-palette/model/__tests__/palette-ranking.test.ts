/**
 * The blended ranking, asserted against fixed corpora (design-decisions §15).
 *
 * Every claim here is about ORDER, and order is the one thing the palette used
 * to get wrong for a structural reason: it computed relevance and then drew rows
 * in a fixed group order, so a perfect room match sat below a weak agent match
 * forever. The tests below are written so that the old behaviour would fail
 * them.
 */
import { describe, it, expect } from 'vitest';
import {
  BEST_MATCH_MARGIN,
  NO_USAGE,
  frecencyScore,
  groupRankedRows,
  rankCandidates,
  scoreCandidate,
  selectBestMatch,
  type RankCandidate,
} from '../palette-ranking';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** One candidate, with everything neutral unless the test says otherwise. */
function candidate(
  overrides: Partial<RankCandidate<string>> & { key: string }
): RankCandidate<string> {
  return {
    item: overrides.key,
    distance: 0,
    usage: NO_USAGE,
    lastActivityAt: null,
    waiting: false,
    demoted: false,
    ...overrides,
  };
}

/** The ranked keys, in order — what a person reads down the list. */
function order(candidates: readonly RankCandidate<string>[], now = NOW): string[] {
  return rankCandidates(candidates, now).map((row) => row.key);
}

/**
 * A shuffle with a seed, so a failure can be reproduced.
 *
 * `Math.random()` here would make a determinism test that fails differently
 * every run, which is the one shape of flake a determinism test must not have.
 */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('P3 AC-2 — one ranked list', () => {
  /**
   * The corpus the acceptance criterion names, with the whole ordering asserted
   * rather than one pair spot-checked.
   *
   * `room-exact` is a near-perfect match. `agent-weak` matches badly. Under the
   * fixed group order this replaced, agents were a group drawn above rooms, so
   * `agent-weak` came first no matter what either row scored — which is exactly
   * the assertion below that would fail.
   */
  const corpus: RankCandidate<string>[] = [
    candidate({ key: 'room-exact', distance: 0.01 }),
    candidate({ key: 'agent-weak', distance: 0.28 }),
    candidate({ key: 'session-good', distance: 0.08 }),
    candidate({ key: 'command-mid', distance: 0.18 }),
    candidate({ key: 'action-worst', distance: 0.3 }),
  ];

  it('lets a high-relevance room outrank a low-relevance agent', () => {
    expect(order(corpus)).toEqual([
      'room-exact',
      'session-good',
      'command-mid',
      'agent-weak',
      'action-worst',
    ]);
  });

  it('orders what it is given and never admits anything else', () => {
    // Ranking is not a filter and not a source: the same rows come out, in a
    // different order. A ranker that dropped or invented a row would be
    // deciding what the palette CONTAINS, which the prefixes and the corpus own.
    const keys = rankCandidates(corpus, NOW).map((row) => row.key);
    expect([...keys].sort()).toEqual([...corpus.map((c) => c.key)].sort());
  });
});

describe('ties break deterministically', () => {
  it('produces byte-identical order from 50 shuffles of the same corpus', () => {
    // Ten rows that all score EXACTLY the same, so nothing but the tiebreak can
    // decide the order. Deliberately not "similar" scores: near-ties would be
    // separated by the score comparison and would prove nothing about the key.
    const tied = Array.from({ length: 10 }, (_, i) =>
      candidate({ key: `tie-${String(i).padStart(2, '0')}`, distance: 0.1 })
    );
    const expected = order(tied);
    expect(expected).toHaveLength(10);

    for (let seed = 1; seed <= 50; seed++) {
      expect(order(shuffled(tied, seed))).toEqual(expected);
    }
  });

  it('also holds when the corpus mixes scores, usage and demotion', () => {
    const mixed: RankCandidate<string>[] = [
      candidate({ key: 'a', distance: 0.1, waiting: true }),
      candidate({ key: 'b', distance: 0.1 }),
      candidate({ key: 'c', distance: 0.2, lastActivityAt: NOW - HOUR }),
      candidate({ key: 'd', distance: 0.2, demoted: true }),
      candidate({ key: 'e', distance: 0.05, usage: { lastUsedAt: NOW - DAY, useCount: 4 } }),
      candidate({ key: 'f', distance: 0.05 }),
    ];
    const expected = order(mixed);
    for (let seed = 1; seed <= 50; seed++) {
      expect(order(shuffled(mixed, seed))).toEqual(expected);
    }
  });
});

/**
 * The three cases below name their rows `zz-…` for the winner and `aa-…` for the
 * loser, and that is load-bearing rather than decorative.
 *
 * The deterministic tiebreak sorts equal scores by key ASCENDING. Named the
 * obvious way round, every one of these passed with the signal under test
 * deleted — the tiebreak alone produced the expected order, so the assertion was
 * measuring nothing. Naming the winner last alphabetically means only the signal
 * can put it first (caught by seeded-defect sweep, three of three).
 */
describe('frecency and recency each move rank', () => {
  it('puts what you opened this morning above what you opened last month', () => {
    // Same relevance, same open COUNT — only when they were opened differs.
    const rows = order([
      candidate({
        key: 'aa-stale',
        distance: 0.1,
        usage: { lastUsedAt: NOW - 30 * DAY, useCount: 5 },
      }),
      candidate({
        key: 'zz-fresh',
        distance: 0.1,
        usage: { lastUsedAt: NOW - 2 * HOUR, useCount: 5 },
      }),
    ]);
    expect(rows).toEqual(['zz-fresh', 'aa-stale']);
  });

  it('puts what you open every day above what you opened once, at the same moment', () => {
    // Same relevance, same lastUsedAt — only the count differs. This is the half
    // of frecency a pure recency ranking cannot express.
    const lastUsedAt = NOW - 6 * HOUR;
    const rows = order([
      candidate({ key: 'aa-rare', distance: 0.1, usage: { lastUsedAt, useCount: 1 } }),
      candidate({ key: 'zz-habit', distance: 0.1, usage: { lastUsedAt, useCount: 40 } }),
    ]);
    expect(rows).toEqual(['zz-habit', 'aa-rare']);
  });

  it("puts what MOVED recently above what has not, on the thing's own clock", () => {
    // Nothing has been opened by anyone here: this is the row's own freshness,
    // which is a different fact from the operator's history.
    const rows = order([
      candidate({ key: 'aa-quiet', distance: 0.1, lastActivityAt: NOW - 9 * DAY }),
      candidate({ key: 'zz-live', distance: 0.1, lastActivityAt: NOW - HOUR }),
    ]);
    expect(rows).toEqual(['zz-live', 'aa-quiet']);
  });

  it('lets relevance overrule both when the gap is real', () => {
    // The blend is not a popularity contest. A clearly better name match beats
    // a barely-matching row the operator uses constantly — otherwise typing
    // would stop deciding anything.
    const rows = order([
      candidate({
        key: 'beloved-but-wrong',
        distance: 0.3,
        waiting: true,
        lastActivityAt: NOW,
        usage: { lastUsedAt: NOW, useCount: 100 },
      }),
      candidate({ key: 'exact', distance: 0 }),
    ]);
    expect(rows).toEqual(['exact', 'beloved-but-wrong']);
  });

  it('scores a row nobody has ever opened at zero frecency, not at a default', () => {
    expect(frecencyScore(NO_USAGE, NOW)).toBe(0);
    // And a future stamp cannot buy rank: a clock skewed forwards is worth a
    // full 1 and no more.
    expect(frecencyScore({ lastUsedAt: NOW + DAY, useCount: 0 }, NOW)).toBe(0.5);
  });
});

describe('what is waiting, and what is only findable', () => {
  it('puts an unread room above a caught-up one that spoke more recently', () => {
    // The e2e claim, in miniature: recency alone inverts this, and the browser
    // asserts the painted order for the same reason (spec `rooms` §13.2).
    const rows = order([
      candidate({ key: 'read', distance: 0.02, lastActivityAt: NOW - 60_000 }),
      candidate({
        key: 'unread',
        distance: 0.02,
        lastActivityAt: NOW - 30 * 60_000,
        waiting: true,
      }),
    ]);
    expect(rows).toEqual(['unread', 'read']);
  });

  it('keeps an archived room below every live row, however loudly it ended', () => {
    const rows = order([
      candidate({ key: 'live-weak', distance: 0.29 }),
      candidate({
        key: 'archived-perfect',
        distance: 0,
        waiting: true,
        lastActivityAt: NOW,
        usage: { lastUsedAt: NOW, useCount: 50 },
        demoted: true,
      }),
    ]);
    expect(rows).toEqual(['live-weak', 'archived-perfect']);
  });

  it('never calls an archived row the best match, even when it leads the list', () => {
    const ranked = rankCandidates(
      [
        candidate({ key: 'archived-strong', distance: 0, demoted: true }),
        candidate({ key: 'archived-weak', distance: 0.29, demoted: true }),
      ],
      NOW
    );
    expect(ranked[0]!.key).toBe('archived-strong');
    expect(selectBestMatch(ranked).best).toBeNull();
  });
});

describe('the Best match section', () => {
  it('appears when the top row clears the margin', () => {
    const ranked = rankCandidates(
      [
        candidate({ key: 'clear-winner', distance: 0 }),
        candidate({ key: 'also-ran', distance: 0.2 }),
      ],
      NOW
    );
    const lead = (ranked[0]!.score - ranked[1]!.score) / ranked[0]!.score;
    expect(lead).toBeGreaterThanOrEqual(BEST_MATCH_MARGIN);

    const { best, rest } = selectBestMatch(ranked);
    expect(best?.key).toBe('clear-winner');
    // Promoted, not duplicated: a row drawn twice is two rows to a person.
    expect(rest.map((r) => r.key)).toEqual(['also-ran']);
  });

  it('is absent when the two top rows are the same answer twice', () => {
    const ranked = rankCandidates(
      [candidate({ key: 'twin-a', distance: 0.1 }), candidate({ key: 'twin-b', distance: 0.101 })],
      NOW
    );
    const lead = (ranked[0]!.score - ranked[1]!.score) / ranked[0]!.score;
    expect(lead).toBeLessThan(BEST_MATCH_MARGIN);
    expect(selectBestMatch(ranked).best).toBeNull();
  });

  it('leaves the list exactly as ranked when it is absent — no reshuffle to compensate', () => {
    const corpus = [
      candidate({ key: 'twin-a', distance: 0.1 }),
      candidate({ key: 'twin-b', distance: 0.101 }),
      candidate({ key: 'third', distance: 0.2 }),
    ];
    const ranked = rankCandidates(corpus, NOW);
    const { best, rest } = selectBestMatch(ranked);
    expect(best).toBeNull();
    expect(rest.map((r) => r.key)).toEqual(ranked.map((r) => r.key));
    expect(rest.map((r) => r.key)).toEqual(['twin-a', 'twin-b', 'third']);
  });

  it('does not head a one-row list with it', () => {
    const ranked = rankCandidates([candidate({ key: 'only', distance: 0 })], NOW);
    const { best, rest } = selectBestMatch(ranked);
    expect(best).toBeNull();
    expect(rest.map((r) => r.key)).toEqual(['only']);
  });

  it('can be earned by usage alone, not only by a better name match', () => {
    // Two identical matches; one is a room with something waiting in it. The
    // margin is deliberately reachable by any single signal — see its TSDoc.
    const ranked = rankCandidates(
      [
        candidate({ key: 'quiet', distance: 0.05 }),
        candidate({ key: 'waiting-on-you', distance: 0.05, waiting: true }),
      ],
      NOW
    );
    expect(selectBestMatch(ranked).best?.key).toBe('waiting-on-you');
  });
});

describe('scoreCandidate', () => {
  it('treats an empty query as a perfect match for every row', () => {
    expect(scoreCandidate(candidate({ key: 'x', distance: null }), NOW).signals.relevance).toBe(1);
  });

  it('keeps every score inside 0…1, so the margin reads as a percentage', () => {
    const extremes = [
      candidate({
        key: 'max',
        distance: 0,
        waiting: true,
        lastActivityAt: NOW,
        usage: { lastUsedAt: NOW, useCount: 1000 },
      }),
      candidate({ key: 'min', distance: 1 }),
    ];
    for (const c of extremes) {
      const { score } = scoreCandidate(c, NOW);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});

describe('groupRankedRows', () => {
  it('heads each run, and repeats a heading when the ranking interleaves types', () => {
    const kinds: Record<string, string> = {
      s1: 'Conversations',
      c1: 'Channels',
      s2: 'Conversations',
    };
    const ranked = rankCandidates(
      [
        candidate({ key: 's1', distance: 0 }),
        candidate({ key: 'c1', distance: 0.1 }),
        candidate({ key: 's2', distance: 0.2 }),
      ],
      NOW
    );
    const groups = groupRankedRows(ranked, (row) => kinds[row.key] as string);
    expect(groups.map((g) => g.label)).toEqual(['Conversations', 'Channels', 'Conversations']);
    expect(groups.map((g) => g.rows.map((r) => r.key))).toEqual([['s1'], ['c1'], ['s2']]);
  });

  it('never reorders the list it was handed', () => {
    const ranked = rankCandidates(
      [
        candidate({ key: 'a', distance: 0 }),
        candidate({ key: 'b', distance: 0.1 }),
        candidate({ key: 'c', distance: 0.2 }),
      ],
      NOW
    );
    const groups = groupRankedRows(ranked, () => 'One');
    expect(groups.flatMap((g) => g.rows.map((r) => r.key))).toEqual(ranked.map((r) => r.key));
  });
});

describe('performance at the power scale', () => {
  /**
   * A palette corpus of `scale` × the reference mix: agents, rooms (some
   * waiting, some archived), conversations and slash commands.
   *
   * At `scale: 1` it is exactly §15's "power" operator — 30 agents, 60 rooms, 40
   * conversations and a full command list, 250 rows in all.
   */
  function powerCorpus(scale: number): RankCandidate<string>[] {
    return [
      ...Array.from({ length: 30 * scale }, (_, i) =>
        candidate({
          key: `agent:${i}`,
          distance: (i % 30) / 100,
          lastActivityAt: NOW - i * HOUR,
          usage: { lastUsedAt: NOW - i * HOUR, useCount: i },
        })
      ),
      ...Array.from({ length: 60 * scale }, (_, i) =>
        candidate({
          key: `room:${i}`,
          distance: (i % 30) / 100,
          lastActivityAt: NOW - i * HOUR,
          waiting: i % 7 === 0,
          demoted: i % 11 === 0,
        })
      ),
      ...Array.from({ length: 40 * scale }, (_, i) =>
        candidate({
          key: `session:${i}`,
          distance: (i % 30) / 100,
          lastActivityAt: NOW - i * HOUR,
          usage: { lastUsedAt: NOW - i * DAY, useCount: i % 5 },
        })
      ),
      ...Array.from({ length: 120 * scale }, (_, i) =>
        candidate({ key: `command:${i}`, distance: (i % 30) / 100 })
      ),
    ];
  }

  /**
   * How long one ranking takes, as the MEDIAN of eleven runs after a warm-up.
   *
   * A single timing on a machine several worktrees deep in concurrent agents is
   * a coin toss, and a flaky performance test gets deleted rather than fixed.
   */
  function medianRankMs(corpus: RankCandidate<string>[]): number {
    rankCandidates(corpus, NOW);
    const samples: number[] = [];
    for (let run = 0; run < 11; run++) {
      const started = performance.now();
      const ranked = rankCandidates(corpus, NOW);
      samples.push(performance.now() - started);
      // Read the result, so nothing can be optimised away as dead work.
      expect(ranked).toHaveLength(corpus.length);
    }
    samples.sort((a, b) => a - b);
    return samples[5] as number;
  }

  it('ranks 30 agents, 60 rooms, 40 conversations and every command in under 10ms', () => {
    const corpus = powerCorpus(1);
    expect(corpus).toHaveLength(250);
    expect(medianRankMs(corpus)).toBeLessThan(10);
  });

  /**
   * The same budget, four times the corpus — and this is the half of the claim
   * that can actually go red.
   *
   * At 250 rows the budget has ~250× headroom, so even a comparator that rescans
   * the whole list per comparison squeaks under it (measured at 8.3ms, against
   * 0.04ms for the shipped one). That check could not fail, which makes it worse
   * than no check. At 1,000 rows the same defect costs ~88ms and this goes red,
   * while a ranking that stays near-linear finishes in well under a millisecond.
   *
   * A thousand rows is not a fantasy corpus either: it is a fleet with a few
   * hundred conversations in its window, which is the scale §15 is designed for.
   */
  it('holds the same budget at four times the corpus — near-linear, not quadratic', () => {
    const corpus = powerCorpus(4);
    expect(corpus).toHaveLength(1000);
    expect(medianRankMs(corpus)).toBeLessThan(10);
  });
});

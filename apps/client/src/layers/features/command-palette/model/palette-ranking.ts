/**
 * One ranked list, across every kind of thing ⌘K can find (design-decisions §15).
 *
 * The palette used to compute a relevance score and then throw it away: results
 * were drawn in a fixed group order, so a perfect room match was drawn below a
 * weak agent match every time, and nothing a person typed could change that.
 * This module is what replaces the fixed order — one blend of **relevance ×
 * frecency × recency**, sorted once, across types, plus a fourth term §15 does
 * not name: **waiting**, which carries `specs/rooms` §13.2's unread-first rule
 * into a list that no longer has a rooms group to keep it in (see
 * `WAITING_WEIGHT`).
 *
 * **Every weight in this file is a chosen free parameter.** The spec asks for a
 * blend and names no numbers; each constant below documents what it controls and
 * what moving it costs, because that is what the next person re-tuning this
 * needs and the spec cannot give them.
 *
 * **It ranks; it never admits.** The prefix filters and the corpus decide what
 * is in the list. Everything here does is decide the order of what it was
 * handed, so a row a filter excluded can never re-enter through a high score.
 *
 * **Pure and synchronous, with the clock injected.** No hooks, no `Date.now()`,
 * no store reads — the same discipline the sidebar model follows, and the reason
 * the ordering claims below can be asserted against a fixed corpus instead of
 * inferred from a rendered list.
 *
 * @module features/command-palette/model/palette-ranking
 */

/**
 * The raw Fuse score at which a match is worth half a perfect one.
 *
 * **This constant is a chosen free parameter, not a number derived from the
 * spec.** §15 says "blend relevance × frecency × recency" and stops there; every
 * digit below is a decision made here, and this doc exists so the next person
 * re-tunes it knowing exactly what it controls.
 *
 * **Why relevance is not `1 − score`.** Fuse's score is a product across the
 * matched keys, each raised to a field-length norm, so real scores are crushed
 * towards zero rather than spread over `0…1`. Measured on this palette's own
 * `FUSE_OPTIONS`, querying `shipping`: an exact `#shipping` scores ~5e-34, a
 * mid-word `#the-shipping-lane` 8.0e-5, a tail `#fast-shipping` 1.5e-4, and a
 * one-letter typo `Shopping List` 6.6e-3. Subtract those from 1 and the whole
 * field sits inside 0.7% — nothing a 2× usage boost would not swallow whole.
 *
 * So relevance is `2^(−score / RELEVANCE_HALF_SCORE)`, a smooth halving curve
 * over the range scores actually occupy. It is **monotone**: it re-spaces Fuse's
 * ordering and can never reverse it. If Fuse ranks a mid-word hit above a typo —
 * and on the corpus above it does, by 80× — no value of this constant changes
 * that, and it is not this constant's job to.
 *
 * **What it does control, exactly.** The usage boost is bounded at 2×
 * ({@link MAX_BOOST}), so usage can overturn relevance only where the relevance
 * ratio is under 2 — which for this curve means precisely:
 *
 * > **Frecency, recency and waiting can only reorder two rows whose raw Fuse
 * > scores differ by less than `RELEVANCE_HALF_SCORE`.**
 *
 * At `0.02` that window admits every shape of match measured above (they span
 * 6.6e-3) while excluding anything Fuse scores a fifth of the way to its
 * `threshold`. Raise it and the palette becomes a list of what you use; lower it
 * and typing decides everything, with the ranking collapsing back to Fuse alone.
 */
const RELEVANCE_HALF_SCORE = 0.02;

/**
 * How much "something is waiting on you here" is worth.
 *
 * **A fourth term, added here — §15 names three.** It is not in the spec's
 * "relevance × frecency × recency" and it is not an oversight: `specs/rooms`
 * §13.2 makes unread-first a rule for rooms in the palette, and one ranked list
 * has to carry that rule or lose it. Without this term the browser's own
 * `# lists the channels, unread first` claim inverts — verified by execution: at
 * `WAITING_WEIGHT = 0` the unread row physically drops below the read one.
 *
 * The largest of the four boosts, because it is the only one that is a **fact**
 * rather than a guess: an unread room has a message in it nobody has read, where
 * frecency and recency are both inferences about what you might want next.
 *
 * It is worth being exact about how it wins, since `0.5` is *equal* to
 * `FRECENCY_WEIGHT + RECENCY_WEIGHT`, not above them. It does not out-weigh the
 * other two; it beats them because neither ever reaches its own maximum in
 * practice — frecency saturates asymptotically in the open count and both decay
 * with time, so a real row's combined boost from them sits well under 0.5 while
 * waiting is all-or-nothing. Two comparable matches therefore resolve "the one
 * with unread messages" above "the one that spoke most recently", which is the
 * behaviour the rule asks for.
 */
const WAITING_WEIGHT = 0.5;

/** How much the operator's own use of a row is worth, at most. */
const FRECENCY_WEIGHT = 0.35;

/** How much a row's own freshness is worth, at most. */
const RECENCY_WEIGHT = 0.15;

/**
 * The most the three boosts can multiply a row's relevance by.
 *
 * Derived, never typed twice: scores are divided by it so every score lands in
 * `0…1` and the {@link BEST_MATCH_MARGIN} below can be read as a percentage.
 */
const MAX_BOOST = 1 + WAITING_WEIGHT + FRECENCY_WEIGHT + RECENCY_WEIGHT;

/**
 * How long it takes for "you opened this" to be worth half as much.
 *
 * Three days spans a working week's memory: something you opened on Monday still
 * counts for something on Wednesday and is nearly spent by the following Monday.
 */
const USE_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The open count at which the frequency half of frecency is worth half its
 * maximum.
 *
 * Three, because opening a thing three times is roughly where it stops being a
 * one-off and starts being a habit. The curve saturates rather than growing
 * without bound, so a script that opened one agent four hundred times cannot
 * bury everything else in the cockpit behind it.
 */
const USE_COUNT_MIDPOINT = 3;

/**
 * How long it takes for a row's own last activity to be worth half as much.
 *
 * A day, because this signal is about what is CURRENT — a conversation from
 * yesterday is genuinely half as likely to be the one you mean as one from an
 * hour ago. Anything older than a week is effectively zero here, which is
 * correct: at that age recall is what you typed, not when it last moved.
 */
const ACTIVITY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead the top row must be before it is called the **Best match**.
 *
 * Fifteen percent of the top score, and the reasoning has to be done in
 * **blended-score space** — the space this number actually lives in — because
 * {@link RELEVANCE_HALF_SCORE}'s curve makes raw-Fuse intuitions useless here.
 * Two bounds pin it:
 *
 * - **The floor it clears.** With usage equal on both rows, 15% corresponds to a
 *   raw Fuse gap of `RELEVANCE_HALF_SCORE × log2(1 / 0.85)` ≈ **0.0047** — about
 *   a quarter of the window usage is allowed to move rows within. So a promotion
 *   on relevance alone means Fuse separated the two rows by a meaningful
 *   fraction of that window, not by rounding.
 * - **The ceiling it stays under.** The most any single usage signal can buy is
 *   waiting's `1 − 1/1.5` ≈ **33%**, then frecency's ≈ 26% and recency's ≈ 13%.
 *   Fifteen percent sits below the first two, so a Best match can be earned by
 *   an unread room or by something you open constantly — not only by a better
 *   name match — while recency alone can never crown a row on its own.
 *
 * Promoting a row to its own section says "this is the one you meant". Saying it
 * wrongly is worse than not saying it, because a person who trusts the section
 * stops reading the list — which is why the bar sits above what one weak signal
 * can produce.
 */
export const BEST_MATCH_MARGIN = 0.15;

/** How much the operator has used one row, as the ranker needs it. */
export interface UsageRecord {
  /** When they last opened it, epoch ms. `null` when they never have. */
  lastUsedAt: number | null;
  /** How many times they have opened it, ever. Never negative. */
  useCount: number;
}

/** A row nobody has ever opened — the ranker's answer for an unknown key. */
export const NO_USAGE: UsageRecord = { lastUsedAt: null, useCount: 0 };

/** The three signals a row is ranked on, each normalised to `0…1`. */
export interface RankingSignals {
  /** How well it matches what was typed. `1` when nothing was typed. */
  relevance: number;
  /** How much the operator uses it — frequency and how recently, blended. */
  frecency: number;
  /** How fresh the thing itself is, from its own last activity. */
  recency: number;
}

/** One row offered to the ranker. */
export interface RankCandidate<T> {
  /**
   * Stable identity. It breaks ties, so it must not change between renders —
   * a session id, a room id, an agent's `projectPath`, an action's id.
   */
  key: string;
  /** The thing being ranked. Carried through untouched. */
  item: T;
  /**
   * Fuse's score for this row: `0` a perfect match, larger is worse. `null`
   * when nothing was typed, which every row reads as a perfect match — with no
   * query there is nothing for one row to match better than another.
   */
  distance: number | null;
  /** How much the operator uses it. */
  usage: UsageRecord;
  /** When the thing itself was last active, epoch ms. `null` when it has no such moment. */
  lastActivityAt: number | null;
  /** Something is waiting on a person here — an unread room, today. */
  waiting: boolean;
  /**
   * Findable, but not live. Ranked below everything live no matter what it
   * scores — an archived room is in the palette so a closed channel can be
   * FOUND, not so it can compete with a conversation still going
   * (`compareRoomsForPalette`, DOR-1051).
   */
  demoted: boolean;
}

/** One row, ranked. */
export interface RankedRow<T> {
  /** Stable identity, carried from the candidate. */
  key: string;
  /** The thing that was ranked. */
  item: T;
  /** Its blended score, `0…1`. */
  score: number;
  /** What that score was made of — for tests, and for anyone reading a surprise. */
  signals: RankingSignals;
  /** Whether it was pushed below everything live. */
  demoted: boolean;
}

/** Everything below `0` becomes `0`, everything above `1` becomes `1`. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * What an age is worth, halving every `halfLifeMs`.
 *
 * A timestamp in the future is worth a full `1` rather than more than one: a
 * clock skewed forwards must not be able to buy rank.
 *
 * @param ageMs - How long ago, in milliseconds.
 * @param halfLifeMs - How long a halving takes.
 */
function decay(ageMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return clamp01(Math.pow(2, -ageMs / halfLifeMs));
}

/**
 * How much the operator uses one row, as one number.
 *
 * Two halves, weighted the same, because they answer two different questions and
 * either one alone is a bad ranking: how RECENTLY you used it (a thing you
 * opened this morning), and how OFTEN (a thing you open every day and happened
 * not to today). Slack's bucket frecency makes the same trade with a step
 * function; a half-life is the same idea without the cliff between buckets.
 *
 * @param usage - The operator's record for this row.
 * @param now - The instant to measure against, epoch ms.
 */
export function frecencyScore(usage: UsageRecord, now: number): number {
  const useRecency =
    usage.lastUsedAt === null ? 0 : decay(now - usage.lastUsedAt, USE_HALF_LIFE_MS);
  const count = Math.max(0, usage.useCount);
  const useFrequency = count === 0 ? 0 : count / (count + USE_COUNT_MIDPOINT);
  return clamp01((useRecency + useFrequency) / 2);
}

/**
 * Score one row, and say what the score was made of.
 *
 * Relevance leads and the rest ride on top of it: the blend is
 * `relevance × (1 + waiting + frecency + recency)`, normalised so a score is a
 * number between 0 and 1. Multiplicative on purpose — a row that does not match
 * what was typed scores near zero however much you use it, which is what stops
 * "the thing I open most" from being the answer to every query.
 *
 * @param candidate - The row to score.
 * @param now - The instant to rank against, epoch ms.
 */
export function scoreCandidate<T>(
  candidate: RankCandidate<T>,
  now: number
): { score: number; signals: RankingSignals } {
  const relevance =
    candidate.distance === null
      ? 1
      : clamp01(Math.pow(2, -Math.max(0, candidate.distance) / RELEVANCE_HALF_SCORE));
  const frecency = frecencyScore(candidate.usage, now);
  const recency =
    candidate.lastActivityAt === null
      ? 0
      : decay(now - candidate.lastActivityAt, ACTIVITY_HALF_LIFE_MS);

  const boost =
    1 +
    (candidate.waiting ? WAITING_WEIGHT : 0) +
    FRECENCY_WEIGHT * frecency +
    RECENCY_WEIGHT * recency;

  return { score: (relevance * boost) / MAX_BOOST, signals: { relevance, frecency, recency } };
}

/**
 * One ranked list, across types.
 *
 * Ordered by three keys, in this order: everything live before anything
 * {@link RankCandidate.demoted}, then blended score descending, then the row's
 * own key ascending. The last key is what makes the whole thing deterministic —
 * two rows that score identically come out in the same order every render and
 * every run, so a list cannot reshuffle itself while nothing has changed.
 *
 * @param candidates - Every row the filters admitted, in any order.
 * @param now - The instant to rank against, epoch ms.
 */
export function rankCandidates<T>(
  candidates: readonly RankCandidate<T>[],
  now: number
): RankedRow<T>[] {
  return candidates
    .map((candidate) => {
      const { score, signals } = scoreCandidate(candidate, now);
      return {
        key: candidate.key,
        item: candidate.item,
        score,
        signals,
        demoted: candidate.demoted,
      };
    })
    .sort(
      (a, b) =>
        Number(a.demoted) - Number(b.demoted) || b.score - a.score || a.key.localeCompare(b.key)
    );
}

/** A ranked list, split into the row that stands out and everything else. */
export interface BestMatchSplit<T> {
  /** The row worth its own section, or `null` when no row has earned one. */
  best: RankedRow<T> | null;
  /** The rest of the list, in ranked order — never reordered to compensate. */
  rest: RankedRow<T>[];
}

/**
 * Pull out the **Best match**, when there is one.
 *
 * Four ways there is not, each for its own reason:
 *
 * - **Nothing was typed** (`queried: false`). "Best match" is a claim about what
 *   a person asked for, and with no query there is nothing for it to be the best
 *   match FOR. This is a live state, not a hypothetical: a bare prefix (`#`,
 *   `@`, `>` — the second is reachable straight from the chat header's agent
 *   chip) scopes the list without a term, every row scores a perfect relevance
 *   of 1, and the usage signals alone will clear the margin. Measured before the
 *   guard: `@` alone crowned an unread room at a 30% lead over a quiet one,
 *   under a heading claiming it matched something nobody typed.
 * - **Fewer than two rows.** A section headed "Best match" over the only result
 *   says nothing the result did not already say.
 * - **The top row is {@link RankCandidate.demoted}.** An archived room can be
 *   the best thing left in a list and is still not the thing you meant.
 * - **The lead is under {@link BEST_MATCH_MARGIN}.** Two rows that close
 *   together are the same answer twice; see that constant for why.
 *
 * When there is no best match the list is handed back **exactly as ranked**. It
 * is never reshuffled to make up for the missing section — the ranking is the
 * answer either way, and the section is only ever a label on top of it.
 *
 * @param ranked - The output of {@link rankCandidates}.
 * @param options - Whether a search term was actually typed.
 */
export function selectBestMatch<T>(
  ranked: readonly RankedRow<T>[],
  options: { queried: boolean }
): BestMatchSplit<T> {
  const rest = [...ranked];
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (!options.queried) return { best: null, rest };
  if (!top || !runnerUp) return { best: null, rest };
  if (top.demoted || top.score <= 0) return { best: null, rest };
  if ((top.score - runnerUp.score) / top.score < BEST_MATCH_MARGIN) return { best: null, rest };
  return { best: top, rest: rest.slice(1) };
}

/** A run of adjacent rows that share a heading. */
export interface RankedGroup<T> {
  /** The heading this run is drawn under. */
  label: string;
  /** Its rows, in ranked order. */
  rows: RankedRow<T>[];
}

/**
 * Cut a ranked list into headed runs, without reordering it.
 *
 * A heading appears wherever the label CHANGES going down the list, so the same
 * label can appear twice — and that is the point. The list is ranked across
 * types, so "Conversations, then Channels, then Conversations again" is a true
 * account of what the ranking did; collapsing it into one Conversations group
 * would put the channel back below rows that outranked it, which is the fixed
 * group order this whole module replaced.
 *
 * @param rows - The ranked list.
 * @param labelOf - What to head a given row's run with.
 */
export function groupRankedRows<T>(
  rows: readonly RankedRow<T>[],
  labelOf: (row: RankedRow<T>) => string
): RankedGroup<T>[] {
  const groups: RankedGroup<T>[] = [];
  for (const row of rows) {
    const label = labelOf(row);
    const current = groups[groups.length - 1];
    if (current && current.label === label) current.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

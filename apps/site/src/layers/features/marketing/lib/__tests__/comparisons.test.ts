import { describe, it, expect } from 'vitest';
import {
  comparisons,
  COMPARISON_DIMENSIONS,
  COMPARISON_FRAMING_COPY,
  dorkosAdvantages,
  dorkosCellFor,
  type ComparisonDimension,
  type ComparisonFraming,
} from '../comparisons';
import { features, type Feature } from '../features';

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRAMINGS: ComparisonFraming[] = ['competitor', 'runtime', 'adjacent', 'discontinued'];

/** How stale a page's facts may get before the suite calls it out. */
const MAX_VERIFICATION_AGE_DAYS = 120;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const featureSlugs = new Set(features.map((f) => f.slug));

describe('comparison catalog data integrity', () => {
  it('all slugs are unique, kebab-case, and never collide with a feature page', () => {
    const slugs = comparisons.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(KEBAB_CASE.test(slug), `"${slug}" is not kebab-case`).toBe(true);
      expect(featureSlugs.has(slug), `"${slug}" collides with a /features slug`).toBe(false);
    }
  });

  it('every dimension has a unique id and at least one backing feature that resolves', () => {
    const ids = COMPARISON_DIMENSIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const dimension of COMPARISON_DIMENSIONS) {
      expect(
        dimension.featureSlugs.length,
        `${dimension.id} has no backing features`
      ).toBeGreaterThan(0);
      for (const slug of dimension.featureSlugs) {
        expect(featureSlugs.has(slug), `${dimension.id} → unknown feature "${slug}"`).toBe(true);
      }
    }
  });

  it('every relatedFeatures reference resolves to a real feature', () => {
    for (const competitor of comparisons) {
      for (const slug of competitor.relatedFeatures ?? []) {
        expect(featureSlugs.has(slug), `${competitor.slug} → unknown feature "${slug}"`).toBe(true);
      }
    }
  });

  it('oneLiner is 120-160 chars, the verdict is written, and the FAQ has 2-5 entries', () => {
    for (const competitor of comparisons) {
      expect(
        competitor.oneLiner.length,
        `${competitor.slug} oneLiner is ${competitor.oneLiner.length} chars (min 120)`
      ).toBeGreaterThanOrEqual(120);
      expect(
        competitor.oneLiner.length,
        `${competitor.slug} oneLiner is ${competitor.oneLiner.length} chars (max 160)`
      ).toBeLessThanOrEqual(160);
      expect(competitor.verdict.trim().length, `${competitor.slug} has no verdict`).toBeGreaterThan(
        0
      );
      expect(competitor.faq.length).toBeGreaterThanOrEqual(2);
      expect(competitor.faq.length).toBeLessThanOrEqual(5);
      for (const entry of competitor.faq) {
        expect(
          entry.q.trim().length,
          `${competitor.slug} has an empty FAQ question`
        ).toBeGreaterThan(0);
        expect(entry.a.trim().length, `${competitor.slug} has an empty FAQ answer`).toBeGreaterThan(
          0
        );
      }
    }
  });

  it('says what the other product is good at, except where it has shut down', () => {
    for (const competitor of comparisons) {
      const strengths = competitor.theirStrengths ?? [];
      if (competitor.framing === 'discontinued') {
        // Nothing to recommend about a product that no longer runs.
        expect(strengths, `${competitor.slug} recommends a shut-down product`).toEqual([]);
        continue;
      }
      expect(strengths.length, `${competitor.slug} names no strength of its own`).toBeGreaterThan(
        0
      );
      for (const strength of strengths) {
        expect(strength.trim().length).toBeGreaterThan(0);
        // Each one finishes its framing's heading ("Use X if …", "Reach for X
        // when …"), so it must not start a new sentence.
        expect(
          strength[0],
          `${competitor.slug} strength "${strength}" should finish the sentence "${COMPARISON_FRAMING_COPY[competitor.framing].theirReasonHeading(competitor.name)} …"`
        ).toBe(strength[0].toLowerCase());
      }
    }
  });

  it('every dimension carries a "you want …" phrase that reads as a fragment', () => {
    for (const dimension of COMPARISON_DIMENSIONS) {
      expect(
        dimension.wantPhrase.trim().length,
        `${dimension.id} has no wantPhrase`
      ).toBeGreaterThan(0);
      expect(
        dimension.wantPhrase.endsWith('.'),
        `${dimension.id} wantPhrase ends in a period; it is rendered mid-sentence`
      ).toBe(false);
      expect(
        dimension.wantPhrase,
        `${dimension.id} wantPhrase is just the table label, which does not read as "you want …"`
      ).not.toBe(dimension.label.toLowerCase());
      expect(
        dimension.wantPhrase[0],
        `${dimension.id} wantPhrase should continue "you want …", not start a sentence`
      ).toBe(dimension.wantPhrase[0].toLowerCase());
    }
  });

  it('never doubles a period when a derived note joins two sentences', () => {
    for (const dimension of COMPARISON_DIMENSIONS) {
      expect(
        dorkosCellFor(dimension).note,
        `${dimension.id} note has a doubled period`
      ).not.toContain('..');
    }
  });

  it('scores every dimension, and every yes/partial claim carries a source', () => {
    for (const competitor of comparisons) {
      for (const dimension of COMPARISON_DIMENSIONS) {
        const cell = competitor.cells[dimension.id];
        expect(cell, `${competitor.slug} has no cell for "${dimension.id}"`).toBeDefined();
        if (!cell) continue;
        expect(
          cell.note.trim().length,
          `${competitor.slug}/${dimension.id} has no note`
        ).toBeGreaterThan(0);
        if (cell.verdict === 'no') continue;
        expect(
          cell.source,
          `${competitor.slug}/${dimension.id} claims "${cell.verdict}" with no source`
        ).toMatch(/^https:\/\//);
      }
      const unknownKeys = Object.keys(competitor.cells).filter(
        (id) => !COMPARISON_DIMENSIONS.some((d) => d.id === id)
      );
      expect(unknownKeys, `${competitor.slug} scores dimensions that do not exist`).toEqual([]);
    }
  });

  it('spells out openness by hand only where the plain yes/no would overstate it', () => {
    for (const competitor of comparisons) {
      if (competitor.openSourceNote === undefined) continue;
      expect(
        competitor.openSourceNote.trim().length,
        `${competitor.slug} has an empty openSourceNote`
      ).toBeGreaterThan(0);
      // It replaces the whole answer rather than sitting beside it, so it has to
      // say what is open and what is not, not just add a caveat.
      expect(
        competitor.openSourceNote,
        `${competitor.slug} openSourceNote repeats the wording it replaces`
      ).not.toMatch(/^(Open, you can read it|Closed, you cannot read it)$/);
    }
  });

  it('lastVerified is a real date, not in the future, and fresh enough to trust', () => {
    const now = Date.now();
    for (const competitor of comparisons) {
      const verified = new Date(competitor.lastVerified);
      expect(
        Number.isNaN(verified.getTime()),
        `${competitor.slug} lastVerified "${competitor.lastVerified}" is not a date`
      ).toBe(false);
      expect(
        verified.getTime(),
        `${competitor.slug} lastVerified is in the future`
      ).toBeLessThanOrEqual(now);
      const ageDays = (now - verified.getTime()) / MS_PER_DAY;
      expect(
        ageDays,
        `${competitor.slug} was last checked ${Math.round(ageDays)} days ago — re-verify the facts`
      ).toBeLessThanOrEqual(MAX_VERIFICATION_AGE_DAYS);
    }
  });

  it('every page cites at least one https source and links the product’s own site', () => {
    for (const competitor of comparisons) {
      expect(competitor.sources.length, `${competitor.slug} cites no sources`).toBeGreaterThan(0);
      for (const source of competitor.sources) {
        expect(source, `${competitor.slug} cites a non-https source`).toMatch(/^https:\/\//);
      }
      expect(competitor.homepage, `${competitor.slug} has no https homepage`).toMatch(
        /^https:\/\//
      );
    }
  });

  it('ships copy for all four framings so a later entry only adds data', () => {
    for (const framing of FRAMINGS) {
      const copy = COMPARISON_FRAMING_COPY[framing];
      expect(copy, `no copy for framing "${framing}"`).toBeDefined();
      expect(copy.headline('Example').length).toBeGreaterThan(0);
      expect(copy.metaTitle('Example')).toContain('Example');
      expect(copy.intro('Example')).toContain('Example');
      expect(copy.theirColumn('Example').length).toBeGreaterThan(0);
      expect(copy.groupLabel.length).toBeGreaterThan(0);
    }
    // Head-to-head pages answer the reversed search on the same address, so the
    // intro says "X vs DorkOS" out loud instead of a second URL doing it.
    expect(COMPARISON_FRAMING_COPY.competitor.intro('Cursor')).toContain('Cursor vs DorkOS');
    expect(COMPARISON_FRAMING_COPY.adjacent.intro('Buzz')).toContain('Buzz vs DorkOS');
    expect(COMPARISON_FRAMING_COPY.competitor.headline('Cursor')).toBe('DorkOS vs Cursor');
    expect(COMPARISON_FRAMING_COPY.runtime.headline('Claude Code')).toBe('DorkOS + Claude Code');
    expect(COMPARISON_FRAMING_COPY.discontinued.headline('Terragon')).toBe('Terragon alternatives');
  });

  it('never promises that a shut-down product’s own announcement is still reachable', () => {
    // A shut-down product takes its website down with it. Terragon's notice went
    // offline with its documentation site — the certificate expired — so a banner
    // telling the reader the details come from an announcement "linked at the
    // bottom of this page" was a promise the page could not keep. The banner says
    // what the page covers instead, and the sources list says where we looked.
    const note = COMPARISON_FRAMING_COPY.discontinued.scopeNote?.('Terragon');
    expect(note, 'the discontinued framing has no scope note').toBeDefined();
    expect(note).toContain('Terragon');
    expect(
      note,
      'the banner points at an announcement that may have gone offline with the product'
    ).not.toMatch(/announcement/i);
  });

  it('gives every framing its own wording for the link out to the other product', () => {
    for (const framing of FRAMINGS) {
      const label = COMPARISON_FRAMING_COPY[framing].outboundLabel('Example');
      expect(label.length, `${framing} has no outbound link label`).toBeGreaterThan(0);
      expect(label, `${framing} outbound label does not name the product`).toContain('Example');
    }
    // A live product is there to be looked at; a dead one is not.
    expect(COMPARISON_FRAMING_COPY.competitor.outboundLabel('Cursor')).toBe(
      'See Cursor for yourself'
    );
    expect(COMPARISON_FRAMING_COPY.discontinued.outboundLabel('Terragon')).not.toContain(
      'for yourself'
    );
  });
});

describe('dorkosAdvantages', () => {
  it('claims only the dimensions DorkOS fully delivers and the other product does not', () => {
    for (const competitor of comparisons) {
      const claimed = dorkosAdvantages(competitor);
      for (const dimension of claimed) {
        expect(
          dorkosCellFor(dimension).verdict,
          `${competitor.slug} claims "${dimension.id}" where DorkOS is not fully there`
        ).toBe('yes');
        expect(
          competitor.cells[dimension.id]?.verdict,
          `${competitor.slug} claims "${dimension.id}" where they also score yes`
        ).not.toBe('yes');
      }
    }
  });

  it('drops a dimension the other product also delivers', () => {
    const cursor = comparisons.find((c) => c.slug === 'cursor');
    expect(cursor, 'the cursor entry is the fixture this test reads').toBeDefined();
    const claimedIds = dorkosAdvantages(cursor!).map((d) => d.id);
    // Cursor scores `yes` on extensibility, so DorkOS must not claim that one.
    expect(cursor!.cells['extensibility']?.verdict).toBe('yes');
    expect(claimedIds).not.toContain('extensibility');
    expect(claimedIds).toContain('multi-runtime');
  });
});

describe('dorkosCellFor — the demo-claim gate', () => {
  const dimensionWith = (featureSlugs: string[]): ComparisonDimension => ({
    id: 'test-dimension',
    label: 'Test dimension',
    featureSlugs,
    question: 'Does the gate hold?',
    wantPhrase: 'the gate to hold',
  });

  /**
   * One feature per lifecycle stage, so every arm of the gate is exercised
   * whatever the shipped catalog happens to contain.
   *
   * These fixtures used to be looked up out of the real catalog, which quietly
   * made the suite depend on DorkOS always shipping something unproven: the
   * moment the last alpha feature was promoted, the lookup returned undefined
   * and the gate tests fell over. A catalog with nothing early in it is a good
   * outcome, not a broken test.
   */
  const stageFixture = (slug: string, name: string, status: Feature['status']): Feature => ({
    slug,
    name,
    product: 'core',
    category: 'infrastructure',
    tagline: `What ${name} gives you`,
    description:
      'A stand-in feature used only by this suite, long enough to look like a real catalog entry without pretending to be one.',
    status,
    benefits: ['Exists only in this test', 'Never ships a claim', 'Keeps the gate honest'],
  });

  const gaFeature = stageFixture('shipped-thing', 'Shipped Thing', 'ga');
  const betaFeature = stageFixture('nearly-there', 'Nearly There', 'beta');
  const alphaFeature = stageFixture('still-early', 'Still Early', 'alpha');
  const unshippedFeature = stageFixture('not-shipped-yet', 'Not Shipped Yet', 'coming-soon');
  const catalog: Feature[] = [gaFeature, betaFeature, alphaFeature, unshippedFeature];

  /** Score a dimension over the synthetic catalog above. */
  const cellFor = (slugs: string[], dorkosNote?: string) =>
    dorkosCellFor({ ...dimensionWith(slugs), ...(dorkosNote ? { dorkosNote } : {}) }, catalog);

  it('says yes only when every backing feature is generally available', () => {
    const cell = cellFor([gaFeature.slug]);
    expect(cell.verdict).toBe('yes');
    expect(cell.note).toBe(gaFeature.tagline);
  });

  it('counts a beta feature as proven, because beta is past the demo-claim gate', () => {
    expect(cellFor([betaFeature.slug]).verdict).toBe('yes');
  });

  it('never says yes when a backing feature is still alpha', () => {
    const cell = cellFor([gaFeature.slug, alphaFeature.slug]);
    expect(cell.verdict).not.toBe('yes');
    expect(cell.verdict).toBe('partial');
  });

  it('names the feature that is still early, in one clean sentence', () => {
    const cell = cellFor([gaFeature.slug, alphaFeature.slug]);
    expect(cell.note).toBe(
      `${gaFeature.tagline}. ${alphaFeature.name} is still early: built, but not yet proven in everyday use.`
    );
  });

  it('joins an authored note that already ends in a period without doubling it', () => {
    const cell = cellFor([alphaFeature.slug], 'Everything you need is here.');
    expect(cell.note).toBe(
      `Everything you need is here. ${alphaFeature.name} is still early: built, but not yet proven in everyday use.`
    );
    expect(cell.note).not.toContain('..');
  });

  it('never says yes for an alpha feature standing alone either', () => {
    expect(cellFor([alphaFeature.slug]).verdict).toBe('partial');
  });

  it('holds for every shipped dimension: an unproven backing feature can never score yes', () => {
    for (const dimension of COMPARISON_DIMENSIONS) {
      const backing = dimension.featureSlugs.map((slug) => features.find((f) => f.slug === slug)!);
      const hasUnproven = backing.some(
        (feature) => feature.status === 'alpha' || feature.status === 'coming-soon'
      );
      const cell = dorkosCellFor(dimension);
      if (hasUnproven) {
        expect(cell.verdict, `${dimension.id} claims yes over an unproven feature`).not.toBe('yes');
      }
      expect(cell.note.trim().length, `${dimension.id} derived an empty note`).toBeGreaterThan(0);
    }
  });

  it('an authored note cannot buy a yes past an alpha feature', () => {
    const cell = cellFor([alphaFeature.slug], 'Everything here works perfectly.');
    expect(cell.verdict).toBe('partial');
    expect(cell.note).toContain('Everything here works perfectly');
    expect(cell.note).toContain(alphaFeature.name);
  });

  it('never says yes over a feature that has not shipped yet', () => {
    const cell = cellFor([unshippedFeature.slug]);
    expect(cell.verdict, 'a coming-soon feature was scored as delivered').toBe('partial');
    expect(cell.note).toContain(unshippedFeature.name);
    expect(cell.note).toContain('still early');
  });

  it('says yes for that same feature once it ships', () => {
    // The mirror of the test above: with only the status changed, the gate
    // opens. Without this pair, a broken gate that always returned partial
    // would pass every other test in this block.
    const shipped: Feature[] = [{ ...unshippedFeature, status: 'ga' }];
    expect(dorkosCellFor(dimensionWith([unshippedFeature.slug]), shipped).verdict).toBe('yes');
  });

  it('refuses a dimension with no backing features rather than claiming yes', () => {
    expect(() => dorkosCellFor(dimensionWith([]))).toThrow(/no backing features/);
  });

  it('refuses a dimension pointing at a feature that no longer exists', () => {
    expect(() => dorkosCellFor(dimensionWith(['not-a-real-feature']))).toThrow(/unknown feature/);
  });
});

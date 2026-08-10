/**
 * The Ask DorkBot preamble: what it says, what it refuses to say, and the bound
 * it never crosses (BC-48).
 */
import { describe, it, expect } from 'vitest';
import { SEED_CONTEXT_MAX_LENGTH } from '@dorkos/shared/schemas';
import {
  buildDorkBotSeed,
  DORKBOT_SEED_MAX_LENGTH,
  type DorkBotSeedFacts,
} from '../model/launch/build-dorkbot-seed';

const KNOWN: DorkBotSeedFacts = {
  originPath: '/marketplace',
  agentNames: ['DorkBot', 'tangerine', 'cardamom'],
  version: '0.58.0',
  updateReady: false,
  erroredSessionIds: [],
};

describe('buildDorkBotSeed', () => {
  it('names the page they came from, the fleet size and the version', () => {
    const seed = buildDorkBotSeed(KNOWN);

    expect(seed).toContain('the marketplace');
    expect(seed).toContain('/marketplace');
    expect(seed).toContain('3 agents registered');
    expect(seed).toContain('v0.58.0');
  });

  it('names a route nothing has a phrase for, rather than dropping it', () => {
    const seed = buildDorkBotSeed({ ...KNOWN, originPath: '/marketplace/sources' });

    expect(seed).toContain('/marketplace/sources');
    expect(seed).toContain('the marketplace');
  });

  it('says nothing at all about a page it does not know', () => {
    const seed = buildDorkBotSeed({ ...KNOWN, originPath: null });

    // Omission, never a guess: no sentence, and specifically no `null` leaking
    // into prose a model reads.
    expect(seed).not.toMatch(/They were on/);
    expect(seed).not.toContain('null');
    expect(seed).not.toContain('undefined');
    // …while the same builder DOES say it when it knows, which is what makes
    // the absence above meaningful.
    expect(buildDorkBotSeed(KNOWN)).toMatch(/They were on/);
  });

  it('says nothing about a version it has not been told', () => {
    const seed = buildDorkBotSeed({ ...KNOWN, version: null });

    expect(seed).not.toMatch(/running DorkOS/);
    expect(seed).not.toContain('null');
  });

  it('mentions an update only while one is waiting', () => {
    expect(buildDorkBotSeed({ ...KNOWN, updateReady: true })).toContain('newer version is ready');
    expect(buildDorkBotSeed(KNOWN)).not.toContain('newer version is ready');
  });

  it('reports what just failed, and stays silent when nothing has', () => {
    expect(buildDorkBotSeed({ ...KNOWN, erroredSessionIds: ['sess-9'] })).toContain('sess-9');
    expect(buildDorkBotSeed(KNOWN)).not.toMatch(/ended in an error/);
  });

  it('stands on its own when it knows nothing else', () => {
    const seed = buildDorkBotSeed({
      originPath: null,
      agentNames: [],
      version: null,
      updateReady: false,
      erroredSessionIds: [],
    });

    expect(seed).toContain('Ask DorkBot');
    expect(seed).toContain('0 agents registered');
    expect(seed.length).toBeGreaterThan(0);
  });

  it('truncates a pathological fleet rather than crossing the bound', () => {
    const enormous = Array.from({ length: 5000 }, (_, i) => `agent-with-a-long-name-${i}`);
    const seed = buildDorkBotSeed({ ...KNOWN, agentNames: enormous });

    expect(seed.length).toBeLessThanOrEqual(DORKBOT_SEED_MAX_LENGTH);
    expect(seed.length).toBeLessThan(SEED_CONTEXT_MAX_LENGTH);
    expect(seed).toMatch(/…\(context truncated\)$/);
    // Observable: the same builder leaves an ordinary fleet whole and unmarked,
    // so the marker above is evidence of truncation rather than of a suffix the
    // builder always appends.
    expect(buildDorkBotSeed(KNOWN)).not.toMatch(/context truncated/);
    expect(buildDorkBotSeed(KNOWN).length).toBeLessThan(DORKBOT_SEED_MAX_LENGTH);
  });

  it('leaves the server headroom rather than landing on its limit', () => {
    // `SendMessageRequestSchema` REJECTS a longer seed, so a builder that
    // clamped exactly to the bound would be one rounding error from a refused
    // turn.
    expect(DORKBOT_SEED_MAX_LENGTH).toBeLessThan(SEED_CONTEXT_MAX_LENGTH);
  });
});

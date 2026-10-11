/**
 * Where checks run, in words (spec `heartbeats` §6.3, §14).
 */
import { describe, expect, it } from 'vitest';
import type { HeartbeatChecks } from '@dorkos/shared/heartbeat-schemas';
import { checksSentence, checksUsageWords } from '../lib/checks-words';

const base: HeartbeatChecks = {
  runsOn: 'runtime',
  runtime: 'claude-code',
  today: 0,
  tokens: 0,
  offer: false,
};

describe('checksSentence', () => {
  it('names DorkOS credits with today’s count while checks run there', () => {
    expect(checksSentence({ ...base, runsOn: 'credits', today: 41 })).toBe(
      'Checks run on DorkOS credits. 41 today.'
    );
  });

  it('names the agent’s own runtime otherwise', () => {
    expect(checksSentence(base)).toBe('Checks run on Claude Code.');
  });
});

describe('checksUsageWords', () => {
  it('says nothing before any check ran on credits today', () => {
    expect(checksUsageWords(base)).toBeNull();
  });

  it('says today’s tokens, and never a price', () => {
    const words = checksUsageWords({ ...base, runsOn: 'credits', today: 3, tokens: 1240 });
    expect(words).toBe('1,240 tokens today.');
    expect(words).not.toMatch(/\$/);
  });

  it('keeps today’s credits checks in view after credits dropped out', () => {
    expect(checksUsageWords({ ...base, today: 1, tokens: 90 })).toBe(
      '1 check on credits earlier today, 90 tokens.'
    );
  });
});

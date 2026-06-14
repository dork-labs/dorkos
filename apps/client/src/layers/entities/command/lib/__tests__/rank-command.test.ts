import { describe, it, expect } from 'vitest';
import type { CommandEntry } from '@dorkos/shared/types';
import { rankCommand } from '../rank-command';

const usage: CommandEntry = {
  fullCommand: '/usage',
  description: 'Show context usage',
  aliases: ['cost', 'stats'],
};
const compact: CommandEntry = { fullCommand: '/compact', description: 'Compact the conversation' };
const context: CommandEntry = { fullCommand: '/context', description: 'Show token budget' };
const statusline: CommandEntry = {
  fullCommand: '/statusline',
  description: 'Configure the status line',
};

describe('rankCommand — ranking ladder (DOR-119)', () => {
  it('ranks an exact command-name match best (bucket 0)', () => {
    expect(rankCommand('usage', usage).bucket).toBe(0);
  });

  it('ranks a name prefix above a name subsequence', () => {
    const prefix = rankCommand('compa', compact); // '/compact' prefix
    const subsequence = rankCommand('cpt', compact); // c..p..t scattered
    expect(prefix.bucket).toBeLessThan(subsequence.bucket);
  });

  it('ranks a name match above a description-only match', () => {
    // '/context' matches by name; '/usage' only matches via its description "context".
    const byName = rankCommand('context', context);
    const byDescription = rankCommand('context', usage);
    expect(byName.match).toBe(true);
    expect(byDescription.match).toBe(true);
    expect(byName.bucket).toBeLessThan(byDescription.bucket);
  });

  it('ranks an alias match above an unrelated name subsequence (the /stats → /usage bug)', () => {
    // 'stats' is an exact alias of /usage, but only a loose subsequence of '/statusline'.
    const viaAlias = rankCommand('stats', usage);
    const viaNameSubsequence = rankCommand('stats', statusline);
    expect(viaAlias.bucket).toBeLessThan(viaNameSubsequence.bucket);
  });
});

describe('rankCommand — alias provenance (DOR-120)', () => {
  it('reports the matched alias when a command surfaces via an alias', () => {
    expect(rankCommand('cost', usage).matchedAlias).toBe('cost');
    expect(rankCommand('stats', usage).matchedAlias).toBe('stats');
  });

  it('reports no alias when the command matches by its name', () => {
    expect(rankCommand('usage', usage).matchedAlias).toBeUndefined();
  });

  it('does not match a command unrelated to the query', () => {
    expect(rankCommand('zzz', compact).match).toBe(false);
  });
});

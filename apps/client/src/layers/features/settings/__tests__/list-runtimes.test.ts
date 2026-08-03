import { describe, it, expect } from 'vitest';
import { listRuntimes } from '../lib/list-runtimes';

describe('listRuntimes', () => {
  it('says nothing at all for nothing at all', () => {
    expect(listRuntimes([])).toBe('');
  });

  it('names one runtime without punctuation it does not need', () => {
    expect(listRuntimes([{ label: 'Codex' }])).toBe('Codex');
  });

  it('joins two with "and", never a comma', () => {
    expect(listRuntimes([{ label: 'Codex' }, { label: 'OpenCode' }])).toBe('Codex and OpenCode');
  });

  it('joins three the way a person would say them', () => {
    expect(
      listRuntimes([{ label: 'Claude Code' }, { label: 'Codex' }, { label: 'OpenCode' }])
    ).toBe('Claude Code, Codex and OpenCode');
  });

  it('keeps the order it was handed, because the caller ordered it on purpose', () => {
    expect(listRuntimes([{ label: 'OpenCode' }, { label: 'Claude Code' }])).toBe(
      'OpenCode and Claude Code'
    );
  });
});

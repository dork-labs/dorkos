import { describe, it, expect, vi, afterEach } from 'vitest';
import { NO_PROVENANCE, provenanceLine } from '../lib/provenance';

afterEach(() => vi.useRealTimers());

describe('provenanceLine', () => {
  it('says nothing with an em-dash, never the word "unknown"', () => {
    // `null` is an honest "nobody in the searched window touched this", not a
    // failure to find out — so it reads as an absence, not as a shrug.
    expect(provenanceLine(null)).toEqual({ label: NO_PROVENANCE, title: null });
    expect(NO_PROVENANCE).toBe('—');
  });

  it('says the same for a source that cannot answer the question at all', () => {
    expect(provenanceLine(undefined).label).toBe(NO_PROVENANCE);
  });

  it('reads as a name and a relative time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const line = provenanceLine({
      sha: 'abc123',
      author: 'Kai',
      at: '2026-08-27T09:00:00.000Z',
      subject: 'Sketch the room brief',
    });
    expect(line.label).toBe('Kai · 3h ago');
  });

  it('keeps the commit subject for the hover, where the width is', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const line = provenanceLine({
      sha: 'abc123',
      author: 'Kai',
      at: '2026-08-27T11:59:50.000Z',
      subject: 'Sketch the room brief',
    });
    expect(line.title).toBe('Sketch the room brief · Kai, Just now');
  });
});

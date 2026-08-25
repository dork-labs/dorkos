import { describe, expect, it } from 'vitest';

import { MemoryMatchError } from '@dorkos/shared/memory-provider';

import { applyMemoryOp } from '../ops.js';

const NOTES = ['## Notes', '', '- deploys go out on Tuesdays', '- Priya prefers short replies', ''];

/** A memory file that looks like a real one: scaffold comment, heading, notes. */
function memory(...extra: string[]): string {
  return ['<!--', 'This is your memory file.', '-->', '', ...NOTES, ...extra].join('\n');
}

describe('add', () => {
  it('appends the note with its provenance suffix', () => {
    const next = applyMemoryOp(memory(), {
      action: 'add',
      text: 'the staging database resets nightly',
      provenance: { room: '#ops', date: '2026-08-24' },
    });

    expect(next).toContain('- the staging database resets nightly (noted in #ops, 2026-08-24)');
  });

  it('leaves every existing note in place', () => {
    // An `add` that quietly rewrote the file would pass a test that only checked
    // for the new line.
    const next = applyMemoryOp(memory(), {
      action: 'add',
      text: 'something new',
      provenance: { room: null, date: '2026-08-24' },
    });

    expect(next).toContain('- deploys go out on Tuesdays');
    expect(next).toContain('- Priya prefers short replies');
  });

  it('appends without a suffix when the caller has no turn context', () => {
    const next = applyMemoryOp('## Notes\n', { action: 'add', text: 'a bare note' });
    expect(next).toBe('## Notes\n- a bare note\n');
  });

  it('round-trips unicode exactly, including emoji and combining marks', () => {
    // Byte-for-byte: a normalisation pass or a naive slice would change these.
    const text = 'Ana Lucía prefers 日本語 docs — ✅ 🇯🇵 é \u{1F468}‍\u{1F4BB}';
    const next = applyMemoryOp('## Notes\n', { action: 'add', text });

    expect(next).toContain(text);
    expect(Buffer.from(next, 'utf8').includes(Buffer.from(text, 'utf8'))).toBe(true);
  });

  it('keeps exactly one newline at the end however untidy the file was', () => {
    const next = applyMemoryOp('## Notes\n\n\n   \n', { action: 'add', text: 'tidy' });
    expect(next).toBe('## Notes\n- tidy\n');
  });
});

describe('replace', () => {
  it('rewrites the one note that matches', () => {
    const next = applyMemoryOp(memory(), {
      action: 'replace',
      oldText: 'deploys go out on Tuesdays',
      text: 'deploys go out on Wednesdays',
    });

    expect(next).toContain('- deploys go out on Wednesdays');
    expect(next).not.toContain('Tuesdays');
    expect(next).toContain('- Priya prefers short replies');
  });

  it('refuses when the text matches twice, and lists both', () => {
    const twice = memory('- deploys go out on Tuesdays, usually');

    try {
      applyMemoryOp(twice, {
        action: 'replace',
        oldText: 'deploys go out on Tuesdays',
        text: 'never',
      });
      expect.unreachable('an ambiguous match must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryMatchError);
      const matchErr = err as MemoryMatchError;
      expect(matchErr.kind).toBe('ambiguous');
      expect(matchErr.nearMatches).toEqual([
        '- deploys go out on Tuesdays',
        '- deploys go out on Tuesdays, usually',
      ]);
      expect(matchErr.message).toContain('appears more than once');
    }
  });

  it('refuses when the text matches nothing, and lists what came closest', () => {
    try {
      applyMemoryOp(memory(), {
        action: 'replace',
        oldText: 'deploys go out on Thursdays',
        text: 'never',
      });
      expect.unreachable('an absent match must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryMatchError);
      const matchErr = err as MemoryMatchError;
      expect(matchErr.kind).toBe('not-found');
      expect(matchErr.nearMatches).toContain('- deploys go out on Tuesdays');
      expect(matchErr.message).toContain('Nothing in your memory matches');
    }
  });

  it('never offers the scaffold header back as a near match', () => {
    // Offering the instructions would send a model quoting them back as the note
    // it meant to edit.
    try {
      applyMemoryOp(memory(), { action: 'replace', oldText: 'this is your memory', text: 'x' });
      expect.unreachable('an absent match must be refused');
    } catch (err) {
      expect((err as MemoryMatchError).nearMatches).not.toContain('This is your memory file.');
    }
  });

  it('leaves the file untouched when it refuses', () => {
    const before = memory();
    expect(() =>
      applyMemoryOp(before, { action: 'replace', oldText: 'nowhere', text: 'x' })
    ).toThrow(MemoryMatchError);
    // A pure function cannot mutate its input, which is exactly why the ops live
    // here rather than inside the writer: a refusal cannot half-apply.
    expect(before).toBe(memory());
  });
});

describe('remove', () => {
  it('takes the whole note away, not just the matched characters', () => {
    const next = applyMemoryOp(memory(), { action: 'remove', oldText: 'go out on Tuesdays' });

    expect(next).not.toContain('Tuesdays');
    // The leftover-bullet failure: removing only the match would leave "- deploys".
    expect(next).not.toContain('- deploys');
    expect(next).toContain('- Priya prefers short replies');
  });

  it('does not widen the hole it leaves behind', () => {
    const next = applyMemoryOp(memory(), { action: 'remove', oldText: 'Priya prefers' });
    expect(next).not.toMatch(/\n{3,}/);
  });

  it('refuses an ambiguous selector rather than guessing which note to forget', () => {
    const twice = memory('- deploys go out on Tuesdays, usually');
    expect(() => applyMemoryOp(twice, { action: 'remove', oldText: 'deploys go out' })).toThrow(
      MemoryMatchError
    );
  });

  it('can empty the file completely', () => {
    const next = applyMemoryOp('- the only note\n', { action: 'remove', oldText: 'only note' });
    expect(next).toBe('');
  });
});

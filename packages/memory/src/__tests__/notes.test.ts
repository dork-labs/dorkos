/**
 * Notes files, the second level of an agent's memory, on a real filesystem.
 *
 * @vitest-environment node
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_NOTE_MAX_CHARS } from '@dorkos/shared/convention-files';
import { MemoryCapExceededError, MemoryMatchError } from '@dorkos/shared/memory-provider';

import {
  ensureNotesDir,
  listNotes,
  parseFrontmatter,
  readNote,
  NOTE_READ_MAX_CHARS,
} from '../notes.js';
import { MemoryPathError, resolveNoteFile } from '../paths.js';
import { readMemorySnapshot, writeMemory } from '../store.js';

const dirs: string[] = [];

async function agent(): Promise<{ agentId: string; agentPath: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorkos-notes-'));
  dirs.push(dir);
  return { agentId: path.basename(dir), agentPath: dir };
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('notes files', () => {
  it('creates a note with its description in frontmatter and a .gitignore beside it', async () => {
    const ref = await agent();
    const result = await writeMemory(ref, {
      action: 'add',
      note: 'release-steps',
      description: 'How a release: goes "out"',
      text: 'tag, then publish',
      provenance: { room: '#dorkos', date: '2026-10-17' },
    });
    expect(result.created).toBe(true);
    const file = await readFile(resolveNoteFile(ref.agentPath, 'release-steps'), 'utf8');
    expect(file).toContain('description: "How a release: goes \\"out\\""');
    expect(file).toContain('- tag, then publish (noted in #dorkos, 2026-10-17)');
    const ignore = await readFile(
      path.join(ref.agentPath, '.dork', 'memory', '.gitignore'),
      'utf8'
    );
    expect(ignore).toContain('*');
    const list = await listNotes(ref, {});
    expect(list.notes[0]).toMatchObject({
      name: 'release-steps',
      description: 'How a release: goes "out"',
    });
  });

  it('never touches MEMORY.md when writing a note', async () => {
    const ref = await agent();
    await writeMemory(ref, { action: 'add', note: 'x', description: 'X', text: 'only here' });
    expect((await readMemorySnapshot(ref)).status).toBe('absent');
  });

  it('keeps a person’s own .gitignore', async () => {
    const ref = await agent();
    const dir = await ensureNotesDir(ref.agentPath);
    await writeFile(path.join(dir, '.gitignore'), 'mine\n');
    await ensureNotesDir(ref.agentPath);
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('refuses to edit the frontmatter, which is the note’s header', async () => {
    const ref = await agent();
    await writeMemory(ref, { action: 'add', note: 'x', description: 'Secret plan', text: 'body' });
    await expect(
      writeMemory(ref, { action: 'replace', note: 'x', oldText: 'Secret plan', text: 'y' })
    ).rejects.toMatchObject({ kind: 'protected-header' });
  });

  it('protects a migrated stamp like a noted-in stamp', async () => {
    const ref = await agent();
    await writeMemory(ref, { action: 'add', note: 'x', description: 'X', text: 'start' });
    await writeMemory(ref, {
      action: 'add',
      note: 'x',
      text: 'old fact',
      provenance: { room: null, date: '2026-10-17', migrated: true },
    });
    expect((await readNote(ref, 'x')).content).toContain(
      'old fact (migrated from Claude Code memory, 2026-10-17)'
    );
    const edit = writeMemory(ref, {
      action: 'replace',
      note: 'x',
      oldText: 'fact (migrated',
      text: 'fact (noted in',
    });
    await expect(edit).rejects.toBeInstanceOf(MemoryMatchError);
    await expect(edit).rejects.toMatchObject({ kind: 'protected-stamp' });
  });

  it('refuses a write past the note cap, and lets an over-cap note shrink', async () => {
    const ref = await agent();
    await writeMemory(ref, { action: 'add', note: 'big', description: 'Big', text: 'seed' });
    const file = resolveNoteFile(ref.agentPath, 'big');
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}- ${'x'.repeat(MEMORY_NOTE_MAX_CHARS)}\n`
    );
    await expect(
      writeMemory(ref, { action: 'add', note: 'big', text: 'one more' })
    ).rejects.toBeInstanceOf(MemoryCapExceededError);
    await writeMemory(ref, { action: 'remove', note: 'big', oldText: 'seed' });
    // An over-cap note still reads whole.
    expect((await readNote(ref, 'big')).truncated).toBe(false);
  });

  it('reads a note far past the cap cut short, with a warning', async () => {
    const ref = await agent();
    await ensureNotesDir(ref.agentPath);
    await writeFile(resolveNoteFile(ref.agentPath, 'huge'), 'y'.repeat(NOTE_READ_MAX_CHARS + 10));
    const read = await readNote(ref, 'huge');
    expect(read.truncated).toBe(true);
    expect(read.warning).toMatch(/Split it/);
  });

  it('refuses a name the jail does not accept, at the jail', () => {
    for (const bad of ['../escape', 'a/b', 'Upper', 'dot.md', '', '-lead', 'x'.repeat(81)]) {
      expect(() => resolveNoteFile('/agents/a', bad)).toThrow(MemoryPathError);
    }
  });

  it('lists newest first, falls back to the first line for a description, and pages', async () => {
    const ref = await agent();
    const dir = await ensureNotesDir(ref.agentPath);
    await writeFile(path.join(dir, 'old.md'), '# Old heading\n\nbody\n');
    await writeFile(path.join(dir, 'new.md'), '---\ndescription: New one\n---\nbody\n');
    await writeFile(path.join(dir, 'Not A Note.md'), 'ignored: name the jail refuses');
    await utimes(path.join(dir, 'old.md'), new Date('2026-01-01'), new Date('2026-01-01'));
    const all = await listNotes(ref, {});
    expect(all.notes.map((n) => [n.name, n.description])).toEqual([
      ['new', 'New one'],
      ['old', 'Old heading'],
    ]);
    const first = await listNotes(ref, { limit: 1 });
    expect(first.nextCursor).toBe('1');
    expect((await listNotes(ref, { limit: 1, cursor: '1' })).notes[0]!.name).toBe('old');
  });

  it('counts notes a migration copied in this week, for the tidy nudge', async () => {
    const ref = await agent();
    const dir = await ensureNotesDir(ref.agentPath);
    await writeFile(path.join(dir, 'a.md'), '---\nmigratedAt: 2026-10-17\n---\nx\n');
    await writeFile(path.join(dir, 'b.md'), '---\nmigratedAt: 2026-09-01\n---\nx\n');
    const list = await listNotes(ref, {}, Date.parse('2026-10-18'));
    expect(list.recentlyMigrated).toBe(1);
  });

  it('deletes a note when its last line is removed', async () => {
    const ref = await agent();
    await writeMemory(ref, { action: 'add', note: 'brief', description: 'B', text: 'only line' });
    await writeMemory(ref, { action: 'remove', note: 'brief', oldText: 'only line' });
    expect((await readNote(ref, 'brief')).status).toBe('absent');
    expect((await listNotes(ref, {})).total).toBe(0);
  });

  it('reports an absent folder as an empty list and an absent note as absent', async () => {
    const ref = await agent();
    expect(await listNotes(ref, {})).toMatchObject({ status: 'ok', total: 0, notes: [] });
    expect((await readNote(ref, 'nope')).status).toBe('absent');
  });
});

describe('the frontmatter parse is linear (CodeQL 343, DOR-3662)', () => {
  /** The per-line regex the parse replaced, kept here only to prove the two agree. */
  const OLD = /^([A-Za-z][\w-]*):\s*(.*)$/;

  it('agrees with the old regex on every short line made of the characters that matter', () => {
    // No quotes: unquoting is unchanged, so only the line split is compared.
    const alphabet = ['a', ':', ' ', '\t', '-', '\u2028'];
    const lines: string[] = [''];
    for (let length = 1; length <= 6; length += 1)
      for (const prefix of lines.filter((l) => l.length === length - 1))
        for (const c of alphabet) lines.push(prefix + c);
    for (const line of lines) {
      const old = OLD.exec(`description${line}`);
      const want = old?.[1] === 'description' ? old[2]!.trim() || undefined : undefined;
      const parsed = parseFrontmatter(`---\ndescription${line}\n---\nbody\n`);
      expect(parsed.description, JSON.stringify(line)).toBe(want);
    }
  });

  it('parses a long blank-filled frontmatter line in well under a second', () => {
    // Built in code: a field whose value is a long run of blanks that fails at its end.
    const content = `---\nkey:${' \t'.repeat(50_000)}x\u2028y\n---\nbody\n`;
    const started = performance.now();
    expect(parseFrontmatter(content).body).toBe('body\n');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  MemoryCapExceededError,
  MemoryIOError,
  MemoryMatchError,
} from '@dorkos/shared/memory-provider';

import { MEMORY_MAX_CHARS } from '../constants.js';
import { MemoryPathError } from '../paths.js';
import { defaultMemoryTemplate } from '../scaffold.js';
import {
  MEMORY_OVERSIZE_WARNING,
  forgetMemory,
  readMemorySnapshot,
  writeMemory,
} from '../store.js';

let root: string;
let agentPath: string;

/** The ref for the agent staged in this test's tmpdir. */
function ref(id = 'alpha'): { agentId: string; agentPath: string } {
  return { agentId: id, agentPath };
}

/** Put a memory file on disk for the staged agent. */
async function seedMemory(content: string): Promise<string> {
  const file = path.join(agentPath, '.dork', 'MEMORY.md');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return file;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-memory-'));
  agentPath = path.join(root, 'agents', 'alpha');
  await mkdir(agentPath, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readMemorySnapshot — three-way honesty', () => {
  it('reports memory that is there', async () => {
    await seedMemory('## Notes\n- deploys go out on Tuesdays\n');

    const snapshot = await readMemorySnapshot(ref());

    expect(snapshot.status).toBe('present');
    expect(snapshot.content).toContain('deploys go out on Tuesdays');
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.error).toBeUndefined();
  });

  it('reports memory that is confirmed absent — as absent, not as an error', async () => {
    const snapshot = await readMemorySnapshot(ref());

    expect(snapshot.status).toBe('absent');
    expect(snapshot.content).toBe('');
    expect(snapshot.bytes).toBe(0);
    expect(snapshot.error).toBeUndefined();
  });

  it('reports a read that FAILED as an error, distinguishably from an absent file', async () => {
    // The distinction is the whole point. If an unreadable file arrived looking
    // like an empty one, an agent would be told it has no memory and would write
    // a fresh note over the top of everything it could not read. A directory
    // where the file should be is the cheapest real I/O failure to stage.
    await mkdir(path.join(agentPath, '.dork', 'MEMORY.md'), { recursive: true });

    const snapshot = await readMemorySnapshot(ref());

    expect(snapshot.status).toBe('error');
    expect(snapshot.error).toBeTruthy();
    expect(snapshot.content).toBe('');
  });

  it('reports a path it refuses to resolve as an error rather than throwing into the turn', async () => {
    const snapshot = await readMemorySnapshot({ agentId: 'alpha', agentPath: 'relative/path' });

    expect(snapshot.status).toBe('error');
    expect(snapshot.error).toContain('absolute path');
  });

  it('never renders any "you have no memory yet" language, in ANY state it can reach', async () => {
    // The TRUNCATED snapshot is in this loop deliberately. It is the only state
    // that carries DorkOS-authored prose at all — `warning` — so a loop over
    // absent and present alone inspects nothing but the file's own bytes and
    // would pass against any wording this engine ever writes. Every other
    // snapshot's `warning` is undefined; this one's is the string under test.
    const absent = await readMemorySnapshot(ref());

    await seedMemory('x'.repeat(MEMORY_MAX_CHARS + 10));
    const truncated = await readMemorySnapshot(ref());
    expect(truncated.warning).toBeDefined();

    await seedMemory('## Notes\n\n- something\n');
    const present = await readMemorySnapshot(ref());

    const errored = await readMemorySnapshot({ agentId: 'a', agentPath: '../escape' });
    expect(errored.status).toBe('error');

    for (const snapshot of [absent, present, truncated, errored]) {
      const text = `${snapshot.content} ${snapshot.warning ?? ''}`.toLowerCase();
      expect(text).not.toContain('no memory');
      expect(text).not.toContain('no notes');
      expect(text).not.toContain('nothing here yet');
      expect(text).not.toContain('empty');
      expect(text).not.toContain('first note');
    }
  });

  // I-3(a). Red when: whitespace-only content is reported as `present`. A
  // caller would then fence a blank line and announce it as this agent's
  // memory — which is exactly what an agent that just forgot its last note
  // would be shown.
  it('reports a file emptied down to whitespace as absent, not as present-and-blank', async () => {
    for (const blank of ['', '   ', '\n\n', '\t \n  \n']) {
      await seedMemory(blank);
      const snapshot = await readMemorySnapshot(ref());
      expect(snapshot.status, JSON.stringify(blank)).toBe('absent');
      expect(snapshot.content).toBe('');
      expect(snapshot.bytes).toBe(0);
    }
  });

  // The positive control for the case above: without it, both pass for a read
  // that reports everything as absent.
  it('still reports a file holding one character as present', async () => {
    await seedMemory('x');
    expect((await readMemorySnapshot(ref())).status).toBe('present');
  });
});

describe('readMemorySnapshot — a file bigger than the cap', () => {
  it('hands back exactly the cap, and says so out loud', async () => {
    // Only reachable by editing the file on disk: the tool and the wire both
    // refuse to cross the cap. Length and warning are asserted together, because
    // either one alone passes for a bug in the other — a silent trim, or a
    // warning about a trim that never happened.
    const oversize = 'x'.repeat(MEMORY_MAX_CHARS + 500);
    await seedMemory(oversize);

    const snapshot = await readMemorySnapshot(ref());

    expect(snapshot.status).toBe('present');
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.content).toHaveLength(MEMORY_MAX_CHARS);
    expect(snapshot.warning).toBe(MEMORY_OVERSIZE_WARNING);
    expect(snapshot.bytes).toBe(MEMORY_MAX_CHARS + 500);
  });

  // M-1. Red when: the slice is taken without checking what it landed on. The
  // orphaned half of a surrogate pair is not a character — it renders as U+FFFD
  // and travels as an unpaired surrogate through JSON and into a prompt.
  it('never hands back half of an astral character', async () => {
    // '🙂' is two UTF-16 code units, and this file puts the pair astride the cap.
    await seedMemory('x'.repeat(MEMORY_MAX_CHARS - 1) + '🙂' + 'tail');

    const snapshot = await readMemorySnapshot(ref());

    expect(snapshot.truncated).toBe(true);
    // One code unit shorter than the cap, because the half-character was dropped
    // rather than emitted.
    expect(snapshot.content).toHaveLength(MEMORY_MAX_CHARS - 1);
    expect(snapshot.content.endsWith('x')).toBe(true);
    for (const unit of snapshot.content) {
      expect(unit.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xd800);
    }
  });

  it('keeps a whole astral character that fits inside the cap', async () => {
    // The positive control: without it, the case above passes for a read that
    // truncates one character early always, or that strips emoji outright.
    await seedMemory('x'.repeat(MEMORY_MAX_CHARS - 2) + '🙂' + 'tail');

    const snapshot = await readMemorySnapshot(ref());

    expect(snapshot.content).toHaveLength(MEMORY_MAX_CHARS);
    expect(snapshot.content.endsWith('🙂')).toBe(true);
  });

  it('leaves a file exactly at the cap whole', async () => {
    // The positive control for the case above: without it, both would pass for
    // an implementation that truncates everything.
    await seedMemory('x'.repeat(MEMORY_MAX_CHARS));

    const snapshot = await readMemorySnapshot(ref());

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.warning).toBeUndefined();
    expect(snapshot.content).toHaveLength(MEMORY_MAX_CHARS);
  });
});

describe('writeMemory', () => {
  it('creates the file from the scaffold on an agent that has none', async () => {
    // This is how every agent that existed before this feature acquires the file.
    const result = await writeMemory(ref(), {
      action: 'add',
      text: 'deploys go out on Tuesdays',
      provenance: { room: '#ops', date: '2026-08-24' },
    });

    expect(result.created).toBe(true);

    const written = await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8');
    expect(written).toContain('store secrets, credentials');
    expect(written).toContain('- deploys go out on Tuesdays (noted in #ops, 2026-08-24)');
  });

  it('does not claim to have created a file that was already there', async () => {
    await seedMemory('## Notes\n');
    const result = await writeMemory(ref(), { action: 'add', text: 'second' });
    expect(result.created).toBe(false);
  });

  it('reports the size in the unit the cap is in', async () => {
    const result = await writeMemory(ref(), { action: 'add', text: 'héllo 🌍' });
    const written = await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8');

    expect(result.chars).toBe(written.length);
    expect(result.bytes).toBe(Buffer.byteLength(written, 'utf8'));
    expect(result.bytes).toBeGreaterThan(result.chars);
  });

  it('refuses a replace that names no single note, and writes nothing', async () => {
    await seedMemory('## Notes\n- one\n');

    await expect(
      writeMemory(ref(), { action: 'replace', oldText: 'nowhere', text: 'x' })
    ).rejects.toBeInstanceOf(MemoryMatchError);

    expect(await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8')).toBe(
      '## Notes\n- one\n'
    );
  });

  it('forgets a note', async () => {
    await seedMemory('## Notes\n- one\n- two\n');

    await forgetMemory(ref(), { text: 'one' });

    const written = await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8');
    expect(written).not.toContain('- one');
    expect(written).toContain('- two');
  });
});

describe('writeMemory — the cap', () => {
  // `- ` + text + `\n`: an added note costs its text plus three characters.
  const NOTE = 'x'.repeat(10);
  const NOTE_COST = NOTE.length + 3;

  /** A file of exactly `chars` characters, ending in a single newline. */
  function fileOf(chars: number): string {
    return `${'a'.repeat(chars - 1)}\n`;
  }

  it('accepts a write that lands exactly ON the cap', async () => {
    // SEEDED-DEFECT PROOF (run, then restored): changing the comparison in
    // store.ts from `after.length > MEMORY_MAX_CHARS` to `>=` makes THIS test
    // fail with a MemoryCapExceededError, while the rejection test below still
    // passes. That is why both exist: a rejection-only test passes for a cap
    // that is one character too tight, and nobody would ever notice.
    await seedMemory(fileOf(MEMORY_MAX_CHARS - NOTE_COST));

    const result = await writeMemory(ref(), { action: 'add', text: NOTE });

    expect(result.chars).toBe(MEMORY_MAX_CHARS);
  });

  it('refuses a write that would land one character past it', async () => {
    const before = fileOf(MEMORY_MAX_CHARS - NOTE_COST + 1);
    await seedMemory(before);

    await expect(writeMemory(ref(), { action: 'add', text: NOTE })).rejects.toBeInstanceOf(
      MemoryCapExceededError
    );

    // A refusal that had already written is not a refusal.
    expect(await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8')).toBe(before);
  });

  it('names the current size, the cap, and what to do about it', async () => {
    const current = MEMORY_MAX_CHARS - NOTE_COST + 1;
    await seedMemory(fileOf(current));

    // An error naming only the limit leaves an agent guessing how much to cut.
    await expect(writeMemory(ref(), { action: 'add', text: NOTE })).rejects.toThrow(
      new RegExp(`${current} characters.*${MEMORY_MAX_CHARS + 1}.*${MEMORY_MAX_CHARS}`, 's')
    );
    await expect(writeMemory(ref(), { action: 'add', text: NOTE })).rejects.toThrow(/Tidy it up/);
  });

  it('still lets an over-sized file be made smaller', async () => {
    // The escape hatch. A file can only get over the cap by being edited on disk,
    // and if every write were refused the only way back would be another hand
    // edit — so a change that shrinks it is always allowed.
    await seedMemory(`${'a'.repeat(MEMORY_MAX_CHARS + 100)}\n- a note to forget\n`);

    await forgetMemory(ref(), { text: 'a note to forget' });

    const written = await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8');
    expect(written).not.toContain('a note to forget');
  });
});

describe('writeMemory — the path jail', () => {
  it('refuses a traversing agent path and writes nowhere', async () => {
    // SEEDED-DEFECT PROOF (run, then restored): with the `'..'` guard removed
    // from paths.ts, this write SUCCEEDS and lands in
    // <root>/agents/beta/.dork/MEMORY.md — one agent writing into another's
    // memory. Both assertions go red.
    // Built by concatenation, NOT `path.join`, and the difference is the point:
    // `join` normalises the traversal away before the guard ever sees it. A path
    // that still contains `..` when it reaches this engine came from somewhere
    // that did not normalise it — a config value, a database row, a route
    // parameter — which is exactly the case the guard exists for.
    const escaping = `${agentPath}/../beta`;

    await expect(
      writeMemory({ agentId: 'alpha', agentPath: escaping }, { action: 'add', text: 'escaped' })
    ).rejects.toBeInstanceOf(MemoryPathError);

    await expect(
      readFile(path.join(root, 'agents', 'beta', '.dork', 'MEMORY.md'), 'utf8')
    ).rejects.toThrow(/ENOENT/);
  });

  it('keeps two agents in the same run in their own files', async () => {
    const beta = path.join(root, 'agents', 'beta');
    await mkdir(beta, { recursive: true });

    await writeMemory(ref(), { action: 'add', text: 'alpha note' });
    await writeMemory({ agentId: 'beta', agentPath: beta }, { action: 'add', text: 'beta note' });

    const alphaFile = await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8');
    const betaFile = await readFile(path.join(beta, '.dork', 'MEMORY.md'), 'utf8');

    expect(alphaFile).toContain('alpha note');
    expect(alphaFile).not.toContain('beta note');
    expect(betaFile).toContain('beta note');
    expect(betaFile).not.toContain('alpha note');
  });
});

describe('writeMemory — concurrent sessions of one agent', () => {
  it('keeps BOTH notes when two sessions save at the same moment', async () => {
    // The lost-update test, and it asserts survival rather than "no throw": a
    // read-modify-write with no lock does not throw — both writes succeed and the
    // second silently erases the first. Only checking that both notes are in the
    // file can fail for that bug.
    await seedMemory(defaultMemoryTemplate());

    await Promise.all([
      writeMemory(ref(), {
        action: 'add',
        text: 'from the first session',
        provenance: { room: '#one', date: '2026-08-24' },
      }),
      writeMemory(ref(), {
        action: 'add',
        text: 'from the second session',
        provenance: { room: '#two', date: '2026-08-24' },
      }),
    ]);

    const written = await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8');
    expect(written).toContain('- from the first session (noted in #one, 2026-08-24)');
    expect(written).toContain('- from the second session (noted in #two, 2026-08-24)');
  });

  it('keeps every note when eight sessions save at once', async () => {
    await seedMemory(defaultMemoryTemplate());

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => writeMemory(ref(), { action: 'add', text: `note ${i}` }))
    );

    const written = await readFile(path.join(agentPath, '.dork', 'MEMORY.md'), 'utf8');
    for (let i = 0; i < 8; i += 1) {
      expect(written).toContain(`- note ${i}`);
    }
  });
});

describe('writeMemory — when the machine is the problem', () => {
  // M-8. Red when: a raw filesystem error escapes. The operating system's own
  // sentence would then land in a tool result mid-turn, and every caller that
  // wanted to keep the conversation alive would have to guess which thrown
  // values were safe to swallow.
  it('wraps an unwritable memory directory in a typed IO error, not a raw errno', async () => {
    const dorkDir = path.join(agentPath, '.dork');
    await mkdir(dorkDir, { recursive: true });
    await chmod(dorkDir, 0o500);

    try {
      await expect(writeMemory(ref(), { action: 'add', text: 'a note' })).rejects.toBeInstanceOf(
        MemoryIOError
      );
    } finally {
      await chmod(dorkDir, 0o700);
    }
  });

  it('says what happened in words a person or a model can act on', async () => {
    const dorkDir = path.join(agentPath, '.dork');
    await mkdir(dorkDir, { recursive: true });
    await chmod(dorkDir, 0o500);

    try {
      await writeMemory(ref(), { action: 'add', text: 'a note' });
      expect.unreachable('the write must fail');
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryIOError);
      const message = (err as MemoryIOError).message;
      // Plain language, and it distinguishes itself from the refusals a caller
      // CAN act on: nothing about caps, nothing about near matches.
      expect(message).toContain('could not be saved');
      expect(message).toContain('Nothing was changed');
      expect(message).not.toMatch(/EACCES|EPERM|ENOSPC/);
      // The real error survives for the log, off the rendered message.
      expect((err as MemoryIOError).cause).toBeDefined();
    } finally {
      await chmod(dorkDir, 0o700);
    }
  });

  // The positive control: the same path succeeds when the directory is writable,
  // so neither case above passes for a write that always throws.
  it('writes normally when nothing is wrong with the file', async () => {
    await writeMemory(ref(), { action: 'add', text: 'a note' });
    expect((await readMemorySnapshot(ref())).content).toContain('- a note');
  });
});

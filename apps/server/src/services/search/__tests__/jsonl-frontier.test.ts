import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, searchSources, eq, type Db } from '@dorkos/db';
import { sweepFileSource, DISCOVERY_FAILURE_KEY } from '../jsonl-frontier.js';
import { createClaudeCodeSource } from '../registry.js';
import type { FileSource, SourceSweep } from '../types.js';

/**
 * M1 against real files in a real temporary directory, through the real
 * registry row.
 *
 * The suite is organised around the two ways a byte offset goes wrong. A read
 * landing mid-line must not consume the record it cut in half — the shipped
 * `readFromOffset` fails exactly this, by advancing to `stat.size` whatever it
 * read — and a file that shrank must be re-read from zero, because an offset
 * into a rewritten file points at the middle of a line.
 */

let db: Db;
let root: string;
let projects: string;
let source: FileSource;

beforeEach(async () => {
  db = createTestDb();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-search-frontier-'));
  projects = path.join(root, 'projects');
  await fs.mkdir(projects, { recursive: true });
  source = createClaudeCodeSource(() => projects);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** One user record, as a line with its trailing newline. */
function saidLine(text: string, cwd = '/repo/project'): string {
  return `${JSON.stringify({
    type: 'user',
    cwd,
    timestamp: '2026-07-28T10:00:00.000Z',
    message: { role: 'user', content: text },
  })}\n`;
}

/** Path of a session transcript inside the fixture root. */
function transcript(sessionId: string, slug = 'slug-a'): string {
  return path.join(projects, slug, `${sessionId}.jsonl`);
}

/** Create a transcript holding these already-newline-terminated lines. */
async function writeTranscript(sessionId: string, lines: string[]): Promise<string> {
  const file = transcript(sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join(''));
  return file;
}

/** Sweep the fixture root once. */
async function sweep(at = '2026-07-28T12:00:00.000Z'): Promise<SourceSweep> {
  return sweepFileSource(db, source, at);
}

/** Every indexed body for one session, in ordinal order. */
function indexedBodies(originKey: string): string[] {
  return db
    .select({ ordinal: messages.ordinal, body: messages.body })
    .from(messages)
    .where(eq(messages.originKey, originKey))
    .orderBy(messages.ordinal)
    .all()
    .map((row) => row.body);
}

/** The frontier row for one session. */
function frontier(originKey: string) {
  return db.select().from(searchSources).where(eq(searchSources.originKey, originKey)).all()[0];
}

describe('M1 — tailing an append-only transcript', () => {
  it('indexes a whole file on the first pass and nothing on the second', async () => {
    await writeTranscript('s1', [saidLine('one'), saidLine('two')]);

    const first = await sweep();
    expect(first.indexed).toBe(2);
    expect(indexedBodies('s1')).toEqual(['one', 'two']);

    // A no-op sweep has to report zero. An unchanged `count(*)` would also pass
    // for a sweep that re-read and re-upserted every row.
    const second = await sweep();
    expect(second.indexed).toBe(0);
    expect(indexedBodies('s1')).toEqual(['one', 'two']);
  });

  it('resumes at the stored offset when the file grows, without duplicating anything', async () => {
    const file = await writeTranscript('s1', [saidLine('one'), saidLine('two')]);
    await sweep();

    await fs.appendFile(file, saidLine('three'));
    const second = await sweep();

    expect(second.indexed).toBe(1);
    expect(second.rebuilt).toBe(0);
    expect(indexedBodies('s1')).toEqual(['one', 'two', 'three']);
    // Ordinals continue rather than restarting: an append must not renumber
    // what is already searchable.
    expect(
      db.select({ ordinal: messages.ordinal }).from(messages).orderBy(messages.ordinal).all()
    ).toEqual([{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }]);
  });

  it('retains a trailing partial line and advances the offset only past the last COMPLETE line', async () => {
    // The assertion the shipped `readFromOffset` fails: it advances to
    // `stat.size` unconditionally, so the half-written record is both returned
    // truncated AND consumed, and the finished record is never read at all.
    const complete = saidLine('finished');
    const file = await writeTranscript('s1', [complete]);
    const partial = saidLine('half written').slice(0, 20);
    await fs.appendFile(file, partial);

    const result = await sweep();

    expect(result.indexed).toBe(1);
    expect(indexedBodies('s1')).toEqual(['finished']);
    // The partial line is not a malformed line: it was never handed to the
    // projection at all.
    expect(result.skipped).toBe(0);

    const stat = await fs.stat(file);
    const afterLastNewline = Buffer.byteLength(complete, 'utf8');
    expect(frontier('s1')?.byteOffset).toBe(afterLastNewline);
    expect(frontier('s1')?.byteOffset).not.toBe(stat.size);
    // A resume position past EOF is unrecoverable: every later append satisfies
    // `size <= fromOffset` and is never read. The offset is derived from raw
    // newline positions precisely so this cannot happen.
    expect(frontier('s1')?.byteOffset).toBeLessThanOrEqual(stat.size);

    // And the record is read whole once the rest of it lands.
    await fs.appendFile(file, saidLine('half written').slice(20));
    const second = await sweep();
    expect(second.indexed).toBe(1);
    expect(indexedBodies('s1')).toEqual(['finished', 'half written']);
  });

  it('re-reads a file from zero when it shrank', async () => {
    const file = await writeTranscript('s1', [saidLine('one'), saidLine('two'), saidLine('three')]);
    await sweep();
    expect(indexedBodies('s1')).toEqual(['one', 'two', 'three']);

    // Truncated and rewritten: the stored offset now points into the middle of a
    // line, so it is worthless and the only correct answer is to start over.
    await fs.writeFile(file, saidLine('replaced'));
    const second = await sweep();

    expect(second.rebuilt).toBe(1);
    expect(indexedBodies('s1')).toEqual(['replaced']);
    expect(frontier('s1')?.byteOffset).toBe(Buffer.byteLength(saidLine('replaced'), 'utf8'));
  });

  it('deletes the rows of a transcript that is gone', async () => {
    const file = await writeTranscript('s1', [saidLine('one')]);
    await writeTranscript('s2', [saidLine('kept')]);
    await sweep();

    await fs.rm(file);
    const second = await sweep();

    expect(second.pruned).toBe(1);
    expect(indexedBodies('s1')).toEqual([]);
    expect(frontier('s1')).toBeUndefined();
    expect(indexedBodies('s2')).toEqual(['kept']);
  });

  it('KEEPS the rows of an intact transcript whose working directory has vanished', async () => {
    // The §6.4 asymmetry, and the one a well-meaning cleanup gets wrong. The
    // conversation happened and the transcript is still on disk; "what did we
    // decide in that worktree" is exactly the question search exists to answer.
    //
    // The cwd is a real directory that is then REMOVED, so the frontier row
    // genuinely points at a path that is not there — asserting against a path
    // that never existed would pass for an implementation that checks nothing.
    const worktree = path.join(root, 'worktree-that-goes-away');
    await fs.mkdir(worktree, { recursive: true });
    const file = await writeTranscript('s1', [saidLine('in the old worktree', worktree)]);
    await sweep();
    expect(frontier('s1')?.containerPath).toBe(worktree);

    await fs.rm(worktree, { recursive: true, force: true });
    await expect(fs.access(worktree)).rejects.toThrow();

    // Sweep twice: once with the file unchanged (the reuse path, which must not
    // go looking for the directory) and once after it grows (the re-read path,
    // which must not either).
    const idle = await sweep('2026-07-28T13:00:00.000Z');
    await fs.appendFile(file, saidLine('and still writing to it', worktree));
    const after = await sweep('2026-07-28T14:00:00.000Z');

    expect(idle.pruned).toBe(0);
    expect(after.pruned).toBe(0);
    expect(indexedBodies('s1')).toEqual(['in the old worktree', 'and still writing to it']);
    // The path is recorded rather than dropped, so the hit can say the
    // directory is gone instead of failing on it.
    expect(frontier('s1')?.containerPath).toBe(worktree);
    expect(frontier('s1')?.lastError).toBeNull();
  });

  it('rebuilds when the messages table was emptied but the frontier was not', async () => {
    await writeTranscript('s1', [saidLine('one'), saidLine('two')]);
    await sweep();

    // `DELETE FROM messages` is the half of the index anyone would think to
    // throw away. A byte offset trusted on its own leaves this file reporting
    // "nothing new" forever, with search returning nothing and no error anywhere.
    db.delete(messages).run();
    const second = await sweep();

    expect(second.rebuilt).toBe(1);
    expect(indexedBodies('s1')).toEqual(['one', 'two']);
  });

  it('rebuilds when the frontier row was deleted but the messages were not', async () => {
    await writeTranscript('s1', [saidLine('one'), saidLine('two')]);
    await sweep();

    // The other half. Resuming at `indexedTo + 1` from byte zero would index the
    // whole file a second time under fresh ordinals.
    db.delete(searchSources).run();
    const second = await sweep();

    expect(second.rebuilt).toBe(1);
    expect(indexedBodies('s1')).toEqual(['one', 'two']);
  });

  it('reads a transcript that has nothing to say without re-reading it every sweep', async () => {
    // A file whose records are all tool results contributes no message and never
    // will. It must not look like a file that has not been read yet.
    await writeTranscript('s1', [
      `${JSON.stringify({ type: 'system', subtype: 'local_command', cwd: '/repo' })}\n`,
    ]);

    const first = await sweep();
    expect(first.indexed).toBe(0);
    expect(frontier('s1')?.lastOrdinal).toBeNull();

    const second = await sweep();
    expect(second.rebuilt).toBe(0);
    expect(second.indexed).toBe(0);
  });

  it('indexes past a compaction marker, which is a line in a growing file and not a rewrite', async () => {
    const file = await writeTranscript('s1', [saidLine('before the compaction')]);
    await sweep();

    await fs.appendFile(
      file,
      `${JSON.stringify({
        type: 'user',
        isCompactSummary: true,
        timestamp: '2026-07-28T10:05:00.000Z',
        message: { role: 'user', content: 'This session is being continued…' },
      })}\n${saidLine('after the compaction')}`
    );
    const second = await sweep();

    expect(second.rebuilt).toBe(0);
    // The summary itself is not a message — nobody wrote it — but everything
    // after it is.
    expect(indexedBodies('s1')).toEqual(['before the compaction', 'after the compaction']);
    expect(second.indexed).toBe(1);
  });

  it('records why a transcript produced nothing, and keeps sweeping the rest', async () => {
    await writeTranscript('s1', [saidLine('fine')]);
    await writeTranscript('s2', [saidLine('also fine')]);

    const breaking: FileSource = {
      ...source,
      project: (lines, context) => {
        if (context.originKey === 's1') throw new Error('projection blew up');
        return source.project(lines, context);
      },
    };
    const result = await sweepFileSource(db, breaking, '2026-07-28T12:00:00.000Z');

    expect(result.failures).toEqual([
      { sourceId: 'claude-code', originKey: 's1', message: 'projection blew up' },
    ]);
    expect(frontier('s1')?.lastError).toBe('projection blew up');
    // The resume position is left alone so the next pass retries the same bytes
    // rather than skipping them because an attempt was made.
    expect(frontier('s1')?.byteOffset).toBe(0);
    expect(indexedBodies('s2')).toEqual(['also fine']);
  });

  it('refuses BOTH files when two claim one container id, and touches neither frontier row', async () => {
    // `search_sources` is keyed `(source_id, origin_key)`, so a container id is
    // one row and one slice of `messages`. Indexing whichever file the walk
    // happened to reach first is not conservative: directory order is not
    // stable, so the same pair can index one twin this sweep and the other next,
    // leaving a slice built out of both.
    await writeTranscript('s1', [saidLine('the original')]);
    const twin = path.join(projects, 'slug-b', 's1.jsonl');
    await fs.mkdir(path.dirname(twin), { recursive: true });
    await fs.writeFile(twin, saidLine('the impostor'));

    const result = await sweep();

    expect(indexedBodies('s1')).toEqual([]);
    expect(frontier('s1')).toBeUndefined();
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain('2 files claim this container id');
    expect(result.failures[0]?.message).toContain('none was indexed');
  });

  it('freezes what was already indexed under a container id when a twin appears, rather than rewriting it', async () => {
    await writeTranscript('s1', [saidLine('indexed before the twin existed')]);
    await sweep();
    const before = frontier('s1');

    const twin = path.join(projects, 'slug-b', 's1.jsonl');
    await fs.mkdir(path.dirname(twin), { recursive: true });
    await fs.writeFile(twin, saidLine('the impostor'));
    const result = await sweep('2026-07-28T13:00:00.000Z');

    // Refusing must not destroy: the rows stay readable and the frontier row is
    // byte-for-byte what it was, including `last_error`, which has no honest
    // value to take here.
    expect(indexedBodies('s1')).toEqual(['indexed before the twin existed']);
    expect(result.pruned).toBe(0);
    expect(frontier('s1')?.byteOffset).toBe(before?.byteOffset);
    expect(frontier('s1')?.lastOrdinal).toBe(before?.lastOrdinal);
    expect(frontier('s1')?.lastError).toBeNull();
    expect(result.failures).toHaveLength(1);
  });

  it('counts a malformed line without stopping the file or recording an error', async () => {
    await writeTranscript('s1', [
      saidLine('before'),
      '{"type":"user","message":{"role":"user","content":"tor\n',
      saidLine('after'),
    ]);

    const result = await sweep();

    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([]);
    expect(frontier('s1')?.lastError).toBeNull();
    expect(indexedBodies('s1')).toEqual(['before', 'after']);
  });
});

describe('M1 — the failure modes that lose data quietly', () => {
  it('keeps the resume position inside the file when a record holds invalid UTF-8', async () => {
    // `StringDecoder` maps every invalid byte to U+FFFD, which re-encodes to
    // THREE bytes. Accounting from decoded text therefore over-counts, and the
    // stored offset lands past EOF — after which every append satisfies
    // `size <= fromOffset`, is never read, and is lost with no error recorded
    // anywhere. Measured: a 202-byte file stored an offset of 242.
    const file = transcript('s1');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const invalid = Buffer.concat([
      Buffer.from(saidLine('clean record'), 'utf8'),
      Buffer.from(`{"type":"user","cwd":"/repo","message":{"role":"user","content":"`, 'utf8'),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      Buffer.from('"}}\n', 'utf8'),
    ]);
    await fs.writeFile(file, invalid);

    const first = await sweep();
    const stat = await fs.stat(file);

    expect(first.failures).toEqual([]);
    expect(frontier('s1')?.byteOffset).toBe(stat.size);
    expect(frontier('s1')?.byteOffset).toBeLessThanOrEqual(stat.size);

    // The assertion that matters: the next real message still arrives.
    await fs.appendFile(file, saidLine('the message after the mess'));
    const second = await sweep('2026-07-28T13:00:00.000Z');

    expect(second.indexed).toBe(1);
    expect(indexedBodies('s1')).toContain('the message after the mess');
  });

  it('gives up on a file with no line terminator instead of buffering it forever', async () => {
    // Without a cap the reader buffers the whole file into one string looking
    // for a newline that is not coming — every five minutes, forever.
    const file = transcript('s1');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'x'.repeat(1_000));

    const result = await sweepFileSource(db, source, '2026-07-28T12:00:00.000Z', {
      maxCarryBytes: 200,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toContain('no line terminator');
    expect(frontier('s1')?.lastError).toContain('no line terminator');
    expect(frontier('s1')?.byteOffset).toBe(0);

    // And it does not try again until the file changes: the recorded
    // fingerprint is the current one, so the next sweep skips it outright.
    const second = await sweepFileSource(db, source, '2026-07-28T13:00:00.000Z', {
      maxCarryBytes: 200,
    });
    expect(second.failures).toEqual([]);
    expect(second.indexed).toBe(0);
    expect(frontier('s1')?.lastError).toContain('no line terminator');
  });

  // Root ignores the directory permission this test relies on, so it would pass
  // for the wrong reason there rather than prove anything.
  it.skipIf(process.getuid?.() === 0)(
    'one unreadable file does not cost the rest of the source',
    async () => {
      // The realistic trigger is not a permission at all: Claude Code deletes
      // transcripts past `cleanupPeriodDays` on its own schedule, so a file can
      // vanish between this walk's `readdir` and its `stat`. A directory the
      // process may list but not enter reproduces the same throw deterministically.
      await writeTranscript('s1', [saidLine('healthy sibling')]);
      const blocked = path.join(projects, 'slug-blocked');
      await fs.mkdir(blocked, { recursive: true });
      await fs.writeFile(path.join(blocked, 's2.jsonl'), saidLine('unreachable'));
      await fs.chmod(blocked, 0o400);

      try {
        const result = await sweep();

        expect(result.failures).toEqual([]);
        expect(indexedBodies('s1')).toEqual(['healthy sibling']);
        expect(indexedBodies('s2')).toEqual([]);
      } finally {
        await fs.chmod(blocked, 0o700);
      }
    }
  );

  it('reports a failed discovery as a source failure and prunes nothing', async () => {
    // Discovery reaches a filesystem, so it can fail for reasons that have
    // nothing to do with this process. Letting it reject would take down every
    // other source in the tick — and an empty container list from a failed
    // discovery must never be read as "every container is gone".
    await writeTranscript('s1', [saidLine('indexed while the disk was there')]);
    await sweep();

    const broken: FileSource = {
      ...source,
      discover: () => Promise.reject(new Error('root is on a volume that went away')),
    };
    const result = await sweepFileSource(db, broken, '2026-07-28T13:00:00.000Z');

    expect(result.failures).toEqual([
      {
        sourceId: 'claude-code',
        originKey: DISCOVERY_FAILURE_KEY,
        message: 'root is on a volume that went away',
      },
    ]);
    expect(result.pruned).toBe(0);
    expect(indexedBodies('s1')).toEqual(['indexed while the disk was there']);
    expect(frontier('s1')).toBeDefined();
  });

  it('numbers messages continuously across the projection batch boundary', async () => {
    // The projection is called once per batch, not once per file, so ordinals
    // are handed in rather than started from zero. A batch boundary is where an
    // off-by-one in that hand-off would show up, and nowhere else.
    const lines = Array.from({ length: 2_500 }, (_unused, i) => saidLine(`line ${i}`));
    await writeTranscript('s1', lines);

    const result = await sweep();

    expect(result.indexed).toBe(2_500);
    expect(
      db
        .select({ ordinal: messages.ordinal })
        .from(messages)
        .orderBy(messages.ordinal)
        .all()
        .map((row) => row.ordinal)
    ).toEqual([...Array(2_500).keys()]);
  });
});

describe('M1 — `\\n` is the only line terminator', () => {
  /**
   * U+2028 and U+2029 are legal raw inside a JSON string and `JSON.stringify`
   * escapes neither, so a runtime writing whole records emits them as written.
   * Node's `readline` splits on both, tearing a record into fragments that the
   * error handling meant to make a reader robust then discards — 64 real
   * messages lost on the operator's machine (spec Amendment 3).
   *
   * Built with code-point arithmetic, never a literal: a literal U+2028 in a
   * `.ts` file is itself a JavaScript line terminator and a syntax error, and an
   * escape inside a shell-bound string renders to a literal before it reaches
   * the file.
   */
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const NEL = String.fromCharCode(0x0085);
  const torn = `a${LS}b${PS}c${NEL}d`;

  it('reads a record torn by U+2028 and U+2029 as one message, separators intact', async () => {
    await writeTranscript('s1', [saidLine(torn)]);

    const result = await sweep();

    expect(result.skipped).toBe(0);
    expect(indexedBodies('s1')).toEqual([torn]);
    // NEL is the control: it never tore anything, under either reader, and it
    // round-trips here for the same reason it always did.
    expect(indexedBodies('s1')[0]).toContain(NEL);
  });

  it('is what `readline` would have got wrong — three fragments, none of them JSON', async () => {
    // Not a test of the implementation: a test that the trap is real, on the
    // exact bytes the implementation reads correctly above. A record holding k
    // tearing separators becomes k+1 fragments, not two.
    const file = await writeTranscript('s1', [saidLine(torn)]);

    const fragments: string[] = [];
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const fragment of lines) fragments.push(fragment);

    expect(fragments).toHaveLength(3);
    expect(
      fragments.filter((fragment) => {
        try {
          JSON.parse(fragment);
          return true;
        } catch {
          return false;
        }
      })
    ).toEqual([]);
  });
});

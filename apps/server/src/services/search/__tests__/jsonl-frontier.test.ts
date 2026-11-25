import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, searchSources, eq, type Db } from '@dorkos/db';
import { DISCOVERY_FAILURE_KEY, SOURCE_ERROR_MARK } from '../frontier-store.js';
import { sweepFileSource } from '../jsonl-frontier.js';
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
  source = createClaudeCodeSource(() => [projects]);
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
});

describe('M1 — the failure modes that lose data quietly', () => {
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
    // **And the person searching is told.** `sourceWarnings` reads
    // `search_sources.last_error` and nothing else, so a failure that lives only
    // on the sweep result raises no warning at all: the largest corpus DorkOS
    // indexes goes quiet with no visible symptom. The sweep result asserted
    // above passes just as well without this.
    expect(frontier('s1')?.lastError).toContain('root is on a volume that went away');
    expect(frontier('s1')?.lastError).toContain(SOURCE_ERROR_MARK);
    expect(frontier('s1')?.lastIndexedAt).toBe('2026-07-28T13:00:00.000Z');
  });
});

describe('M1 — `\\n` is the only line terminator', () => {
  /**
   * U+2028 and U+2029 are legal raw inside a JSON string and `JSON.stringify`
   * escapes neither. Node24's `readline` treats both as line terminators;
   * Node22's does not. The production reader must preserve them on either
   * runtime, so the negative control explicitly uses an incorrect Unicode
   * delimiter rather than assuming every stock reader splits these bytes.
   * Code-point construction keeps the invisible fixture separators readable.
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
});

describe('M1 — a large file is written in pieces (DOR-2904)', () => {
  /** `count` short user lines; about 7,000 fit in one 1 MiB read chunk. */
  function many(count: number): string[] {
    return Array.from({ length: count }, (_, i) => saidLine(`message ${i} ${'x'.repeat(80)}`));
  }

  /** Every indexed ordinal for one session, in order. */
  function ordinals(originKey: string): number[] {
    return db
      .select({ ordinal: messages.ordinal })
      .from(messages)
      .where(eq(messages.originKey, originKey))
      .orderBy(messages.ordinal)
      .all()
      .map((row) => row.ordinal);
  }

  it('commits a first read of a big file in several transactions, every message once', async () => {
    await writeTranscript('big', many(20_000));
    const transaction = vi.spyOn(db, 'transaction');

    const first = await sweep();

    expect(first.indexed).toBe(20_000);
    expect(transaction.mock.calls.length).toBeGreaterThan(2);
    expect(ordinals('big')).toEqual(Array.from({ length: 20_000 }, (_, i) => i));
    expect((await sweep()).indexed).toBe(0);
  });

  it('resumes after a read cut short between pieces, without losing or repeating a message', async () => {
    await writeTranscript('big', many(20_000));
    const real = source;
    let failing = true;
    source = {
      ...real,
      project: (lines, ctx) => {
        if (failing && ctx.firstOrdinal >= 12_000) throw new Error('the server stopped');
        return real.project(lines, ctx);
      },
    };

    const cut = await sweep();
    const committed = ordinals('big');
    // Some pieces landed before the failure, and nothing after it; the sweep
    // says how many.
    expect(committed.length).toBeGreaterThan(0);
    expect(cut.indexed).toBe(committed.length);
    expect(committed.length).toBeLessThan(20_000);
    expect(frontier('big')?.byteOffset).toBeGreaterThan(0);

    failing = false;
    await sweep();

    expect(ordinals('big')).toEqual(Array.from({ length: 20_000 }, (_, i) => i));
    expect(indexedBodies('big').at(-1)).toContain('message 19999');
  });
});

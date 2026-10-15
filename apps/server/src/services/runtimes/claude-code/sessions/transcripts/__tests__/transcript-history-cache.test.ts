import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, rename, utimes, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { TranscriptHistoryCache, CHUNK_BYTES } from '../transcript-history-cache.js';
import { parseTranscript } from '../../transcript-parser.js';
import { parseTasks } from '../../task-reader.js';

/**
 * A transcript is parsed once and grown as it grows (DOR-2889). Opening a long
 * chat used to re-read and re-parse its whole file on every read: about 230 ms
 * of blocked event loop and hundreds of MB for a 110 MB transcript, paid again
 * on every snapshot, history fetch and turn-end reload.
 *
 * Real files on disk; the cache's own counters say what each read did.
 */

const SESSION = 'cccccccc-0000-4000-8000-000000000001';

let seq = 0;
function user(text: string): string {
  seq += 1;
  return JSON.stringify({
    type: 'user',
    uuid: `u-${seq}`,
    message: { role: 'user', content: text },
    timestamp: '2026-10-13T00:00:00.000Z',
  });
}
function assistant(text: string): string {
  seq += 1;
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${seq}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: '2026-10-13T00:00:01.000Z',
  });
}
function todo(content: string): string {
  seq += 1;
  return JSON.stringify({
    type: 'assistant',
    uuid: `t-${seq}`,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `tool-${seq}`,
          name: 'TodoWrite',
          input: { todos: [{ content, status: 'pending', activeForm: content }] },
        },
      ],
    },
  });
}
function imageCall(id: string): string[] {
  const toolUse = JSON.stringify({
    type: 'assistant',
    uuid: `call-${id}`,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'x.png' } }],
    },
  });
  const toolResult = JSON.stringify({
    type: 'user',
    uuid: `result-${id}`,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    },
  });
  return [toolUse, toolResult];
}
const jsonl = (lines: string[]) => lines.map((line) => `${line}\n`).join('');

describe('TranscriptHistoryCache', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'history-cache-'));
    file = join(dir, `${SESSION}.jsonl`);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** The reference answer: the whole file parsed in one pass, as reads used to. */
  async function wholeParse(): Promise<unknown> {
    const { readFile } = await import('fs/promises');
    const text = await readFile(file, 'utf8');
    return parseTranscript(text.split('\n').filter((line) => line.trim()));
  }

  it('answers an unchanged transcript without reading it again', async () => {
    await writeFile(file, jsonl([user('hi'), assistant('hello')]));
    const cache = new TranscriptHistoryCache();
    const first = await cache.read(file, SESSION);
    const second = await cache.read(file, SESSION);

    expect(second).toEqual(first);
    expect(cache.stats).toEqual({ hits: 1, appends: 0, fullParses: 1 });
  });

  it('parses only the appended lines, and answers what a whole parse would', async () => {
    await writeFile(file, jsonl([user('one'), assistant('two')]));
    const cache = new TranscriptHistoryCache();
    await cache.read(file, SESSION);
    await appendFile(file, jsonl([user('three'), assistant('four')]));

    const grown = await cache.read(file, SESSION);

    expect(cache.stats).toEqual({ hits: 0, appends: 1, fullParses: 1 });
    expect(grown).toEqual(await wholeParse());
    expect(grown.map((m) => m.content)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('merges an assistant record appended right after one already read', async () => {
    // The merge of consecutive assistant records spans the old end of the file.
    await writeFile(file, jsonl([user('q'), assistant('part one')]));
    const cache = new TranscriptHistoryCache();
    await cache.read(file, SESSION);
    await appendFile(file, jsonl([assistant('part two')]));

    expect(await cache.read(file, SESSION)).toEqual(await wholeParse());
  });

  it('holds back an unfinished last line until its newline arrives', async () => {
    const finished = user('done');
    const pending = assistant('still being written');
    await writeFile(file, `${finished}\n${pending.slice(0, 20)}`);
    const cache = new TranscriptHistoryCache();

    expect((await cache.read(file, SESSION)).map((m) => m.content)).toEqual(['done']);

    await appendFile(file, `${pending.slice(20)}\n`);
    const after = await cache.read(file, SESSION);
    expect(after.map((m) => m.content)).toEqual(['done', 'still being written']);
    expect(cache.stats.appends).toBe(1);
  });

  it('reads a final record written without a newline', async () => {
    await writeFile(file, `${user('a')}\n${assistant('b')}`);
    const cache = new TranscriptHistoryCache();
    expect((await cache.read(file, SESSION)).map((m) => m.content)).toEqual(['a', 'b']);

    await appendFile(file, `\n${user('c')}\n`);
    expect((await cache.read(file, SESSION)).map((m) => m.content)).toEqual(['a', 'b', 'c']);
    expect(cache.stats.appends).toBe(1);
  });

  it('parses again from the start when the file was replaced, not appended to', async () => {
    await writeFile(file, jsonl([user('original'), assistant('reply')]));
    const cache = new TranscriptHistoryCache();
    await cache.read(file, SESSION);
    // Same inode, longer, but the bytes already parsed changed underneath.
    await writeFile(file, jsonl([user('rewritten!'), assistant('reply'), user('more')]));

    const after = await cache.read(file, SESSION);
    expect(after.map((m) => m.content)).toEqual(['rewritten!', 'reply', 'more']);
    expect(cache.stats).toEqual({ hits: 0, appends: 0, fullParses: 2 });
  });

  it('parses again from the start when the file shrank', async () => {
    await writeFile(file, jsonl([user('a'), assistant('b'), user('c')]));
    const cache = new TranscriptHistoryCache();
    await cache.read(file, SESSION);
    await writeFile(file, jsonl([user('a')]));

    expect((await cache.read(file, SESSION)).map((m) => m.content)).toEqual(['a']);
    expect(cache.stats.fullParses).toBe(2);
  });

  it('parses again when a different file took the path', async () => {
    // The new file starts with the very bytes already parsed, so only the
    // inode can tell it apart from an append.
    const first = user('old file');
    await writeFile(file, jsonl([first]));
    const cache = new TranscriptHistoryCache();
    await cache.read(file, SESSION);
    const other = join(dir, 'other.jsonl');
    await writeFile(other, jsonl([first, user('new file')]));
    await rename(other, file);

    expect((await cache.read(file, SESSION)).map((m) => m.content)).toEqual([
      'old file',
      'new file',
    ]);
    expect(cache.stats).toEqual({ hits: 0, appends: 0, fullParses: 2 });
  });

  it('parses again when the size is the same but the file is newer', async () => {
    await writeFile(file, jsonl([user('aaaa')]));
    const cache = new TranscriptHistoryCache();
    await cache.read(file, SESSION);
    await writeFile(file, jsonl([user('bbbb')]));
    const { mtime } = await stat(file);
    await utimes(file, mtime, new Date(mtime.getTime() + 5000));

    expect((await cache.read(file, SESSION)).map((m) => m.content)).toEqual(['bbbb']);
    expect(cache.stats.fullParses).toBe(2);
  });

  it('answers a missing transcript with nothing and forgets it', async () => {
    const cache = new TranscriptHistoryCache();
    expect(await cache.read(file, SESSION)).toEqual([]);
    await writeFile(file, jsonl([user('now it exists')]));
    expect(await cache.read(file, SESSION)).toHaveLength(1);
    await rm(file);
    expect(await cache.read(file, SESSION)).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it('hands out a copy, so a caller changing it cannot change the next read', async () => {
    await writeFile(file, jsonl([user('keep me')]));
    const cache = new TranscriptHistoryCache();
    const first = await cache.read(file, SESSION);
    first[0]!.content = 'changed by a caller';
    first.push(first[0]!);

    const second = await cache.read(file, SESSION);
    expect(second.map((m) => m.content)).toEqual(['keep me']);
  });

  it('shares one parse between reads that arrive together', async () => {
    await writeFile(file, jsonl([user('a'), assistant('b')]));
    const cache = new TranscriptHistoryCache();
    const reads = await Promise.all([
      cache.read(file, SESSION),
      cache.read(file, SESSION),
      cache.readTasks(file, SESSION),
    ]);

    expect(reads[0]).toEqual(reads[1]);
    expect(cache.stats).toEqual({ hits: 2, appends: 0, fullParses: 1 });
  });

  it('folds tasks from the same parse, and grows them with the file', async () => {
    await writeFile(file, jsonl([user('plan'), todo('first task')]));
    const cache = new TranscriptHistoryCache();
    expect((await cache.readTasks(file, SESSION)).map((t) => t.subject)).toEqual(
      parseTasks([user('plan'), todo('first task')]).map((t) => t.subject)
    );

    await appendFile(file, jsonl([todo('second list')]));
    const tasks = await cache.readTasks(file, SESSION);
    expect(tasks.map((t) => t.subject)).toEqual(['second list']);
    expect(cache.stats.appends).toBe(1);
  });

  it('reads a transcript bigger than one chunk, with a line split across chunks', async () => {
    const long = 'x'.repeat(CHUNK_BYTES + 1000);
    await writeFile(file, jsonl([user('before'), assistant(long), user('after')]));
    const cache = new TranscriptHistoryCache();

    const messages = await cache.read(file, SESSION);
    expect(messages).toEqual(await wholeParse());
    expect(messages.map((m) => m.content.length)).toEqual([6, long.length, 5]);
  });

  it('keeps no more transcripts than its entry cap, least recently read first out', async () => {
    const cache = new TranscriptHistoryCache({ maxEntries: 2 });
    const files = ['a', 'b', 'c'].map((name) => join(dir, `${name}.jsonl`));
    for (const path of files) await writeFile(path, jsonl([user(path)]));

    await cache.read(files[0]!, 'a');
    await cache.read(files[1]!, 'b');
    await cache.read(files[0]!, 'a'); // a is now the most recent
    await cache.read(files[2]!, 'c'); // evicts b

    expect(cache.size).toBe(2);
    const before = cache.stats.fullParses;
    await cache.read(files[0]!, 'a');
    expect(cache.stats.fullParses).toBe(before);
    await cache.read(files[1]!, 'b');
    expect(cache.stats.fullParses).toBe(before + 1);
  });

  it('keeps within its memory budget, and never keeps one transcript bigger than it', async () => {
    const small = join(dir, 'small.jsonl');
    const big = join(dir, 'big.jsonl');
    await writeFile(small, jsonl([user('tiny')]));
    await writeFile(big, jsonl([assistant('y'.repeat(50_000))]));
    const cache = new TranscriptHistoryCache({ maxBytes: 20_000 });

    await cache.read(small, 'small');
    expect((await cache.read(big, 'big'))[0]!.content).toHaveLength(50_000);

    expect(cache.size).toBe(1);
    await cache.read(big, 'big');
    expect(cache.stats.fullParses).toBe(3); // the big one was answered, never kept
  });

  it('redoes a parse older than six hours, so image timestamps refresh', async () => {
    let now = 1_000_000;
    await writeFile(file, jsonl([user('old')]));
    const cache = new TranscriptHistoryCache({ now: () => now });
    await cache.read(file, SESSION);

    now += 6 * 60 * 60 * 1000 + 1;
    await cache.read(file, SESSION);
    expect(cache.stats).toEqual({ hits: 0, appends: 0, fullParses: 2 });
  });

  it('places each image once, on the read that first parsed its line', async () => {
    const attachImages = vi.fn().mockResolvedValue(undefined);
    await writeFile(file, jsonl([user('look'), ...imageCall('read-1')]));
    const cache = new TranscriptHistoryCache({ attachImages });

    await cache.read(file, SESSION);
    expect(attachImages).toHaveBeenCalledTimes(1);
    expect(attachImages.mock.calls[0]![2]).toHaveLength(1);

    await cache.read(file, SESSION); // unchanged: nothing new to place
    await appendFile(file, jsonl([user('no pictures here')]));
    await cache.read(file, SESSION); // grown, but no new image
    expect(attachImages).toHaveBeenCalledTimes(1);
  });

  it('starts over after a failed read instead of trusting a half-advanced parse', async () => {
    await writeFile(file, jsonl([user('a')]));
    const attachImages = vi.fn().mockRejectedValueOnce(new Error('disk full'));
    const cache = new TranscriptHistoryCache({ attachImages });
    await cache.read(file, SESSION);
    await appendFile(file, jsonl(imageCall('read-2')));

    await expect(cache.read(file, SESSION)).rejects.toThrow('disk full');
    expect(cache.size).toBe(0);
    await cache.read(file, SESSION);
    expect(cache.stats.fullParses).toBe(2);
  });
});

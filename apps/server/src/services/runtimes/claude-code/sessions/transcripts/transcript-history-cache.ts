/**
 * Parsed Claude Code transcripts, kept between reads and grown as they grow.
 *
 * Opening a chat used to read and parse its whole transcript every time: on
 * every cold `/events` snapshot, every `GET /:id/messages`, and every turn-end
 * reload. A 110 MB transcript cost about 230 ms of blocked event loop and about
 * 400 MB of extra memory per read, and the next read paid it all again
 * (DOR-2889).
 *
 * Claude Code only ever appends to a transcript, so this cache keeps the parser
 * itself and how far into the file it got:
 *
 * - **Unchanged file** (same size and mtime): no read at all.
 * - **Grown file**: only the new bytes are read and fed to the same parser.
 *   The bytes just before the old end are re-checked first, so a file that was
 *   replaced rather than appended to is parsed again from the start.
 * - **Anything else** (smaller, same size but newer, a different inode):
 *   parsed again from the start.
 *
 * Reads go through the file in {@link CHUNK_BYTES} pieces rather than as one
 * string, so the first parse of a huge transcript never holds the whole file
 * and its line array in memory at once, and the event loop gets a turn between
 * pieces.
 *
 * Memory is bounded by an estimate of what each parsed transcript holds (its
 * strings), least recently read evicted first. A transcript whose own estimate
 * exceeds the whole budget is parsed and answered but not kept.
 *
 * Entries also expire after {@link MAX_ENTRY_AGE_MS}. Image retention counts on
 * a transcript read refreshing its pictures' timestamps (`attachTranscriptImages`),
 * and a parse that never re-runs would never refresh them.
 *
 * @module services/runtimes/claude-code/sessions/transcripts/transcript-history-cache
 */
import fs from 'fs/promises';
import type { HistoryMessage } from '@dorkos/shared/types';
import { createTranscriptParser } from '../transcript-parser.js';
import type { TranscriptImageRef, TranscriptLine, TranscriptParser } from '../transcript-parser.js';
import { createTaskParser, type TaskParser } from '../task-reader.js';
import type { TaskItem } from '@dorkos/shared/types';

/** Bytes read from the file per step. */
export const CHUNK_BYTES = 1024 * 1024;
/** How many trailing bytes of the parsed range are re-checked before an append. */
const TAIL_CHECK_BYTES = 64;
/** Default memory budget, in estimated bytes of parsed history across entries. */
export const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
/** Default cap on how many transcripts are kept. */
export const DEFAULT_MAX_ENTRIES = 16;
/** A kept parse older than this is redone, see the module notes on images. */
export const MAX_ENTRY_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Places the images newly parsed lines carried onto their tool calls. Runs on
 * the parser's own messages, once per image, so a picture is stored and drawn
 * the first time its line is read and is already in place on every later read.
 */
export type AttachTranscriptImages = (
  sessionId: string,
  messages: HistoryMessage[],
  images: TranscriptImageRef[]
) => Promise<void>;

/** Tuning for {@link TranscriptHistoryCache}. */
export interface TranscriptHistoryCacheOptions {
  /** Places parsed images, see {@link AttachTranscriptImages}. */
  attachImages?: AttachTranscriptImages;
  /** Memory budget in estimated bytes. Default {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** How many transcripts to keep. Default {@link DEFAULT_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/** What the cache did on reads so far. For tests and diagnostics. */
export interface TranscriptHistoryCacheStats {
  /** Reads answered without touching the file's contents. */
  hits: number;
  /** Reads that parsed only bytes appended since the last read. */
  appends: number;
  /** Reads that parsed the file from the start. */
  fullParses: number;
}

interface Entry {
  sessionId: string;
  ino: number;
  /** File size and mtime when last read. */
  size: number;
  mtimeMs: number;
  /** Bytes fed to the parser. Short of `size` while a last line is unfinished. */
  offset: number;
  /** The bytes just before `offset`, to tell an append from a replacement. */
  tail: Buffer;
  parser: TranscriptParser;
  /** Task state folded from the same records. */
  tasks: TaskParser;
  /** The merged messages as of the last read. Never handed out directly. */
  result: HistoryMessage[];
  estimatedBytes: number;
  parsedAt: number;
}

/**
 * Rough heap held by a parsed history: two bytes per string character plus a
 * small charge per object. Only used to decide what to evict, so close is
 * enough; it never needs to match a heap snapshot.
 */
export function estimateHistoryBytes(value: unknown): number {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const next = stack.pop();
    if (typeof next === 'string') total += next.length * 2;
    else if (Array.isArray(next)) {
      total += 16;
      for (const item of next) stack.push(item);
    } else if (next !== null && typeof next === 'object') {
      total += 32;
      for (const item of Object.values(next)) stack.push(item);
    } else total += 8;
  }
  return total;
}

/** A per-transcript cache of parsed history; one per transcript reader. */
export class TranscriptHistoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<string, Promise<Entry | null>>();
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly attachImages: AttachTranscriptImages | undefined;
  /** What reads have done so far. */
  readonly stats: TranscriptHistoryCacheStats = { hits: 0, appends: 0, fullParses: 0 };

  /**
   * Build an empty cache.
   *
   * @param options - Budget, image placement and clock, see {@link TranscriptHistoryCacheOptions}.
   */
  constructor(options: TranscriptHistoryCacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.attachImages = options.attachImages;
  }

  /** How many transcripts are kept. */
  get size(): number {
    return this.entries.size;
  }

  /** Forget every kept parse. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * A transcript's messages, parsed as little as possible.
   *
   * Reads of one file run one at a time, so the reads a chat makes when it
   * opens (messages, tasks, the stream's snapshot) share one parse instead of
   * racing to do several.
   *
   * @param filePath - Absolute transcript path.
   * @param sessionId - The session the transcript belongs to (its file name).
   * @returns A private copy the caller may change; empty when the file is missing.
   */
  async read(filePath: string, sessionId: string): Promise<HistoryMessage[]> {
    const entry = await this.serialized(filePath, sessionId);
    return entry ? structuredClone(entry.result) : [];
  }

  /**
   * A transcript's task list, folded from the same parse as its messages.
   *
   * @param filePath - Absolute transcript path.
   * @param sessionId - The session the transcript belongs to.
   * @returns The tasks; empty when the file is missing.
   */
  async readTasks(filePath: string, sessionId: string): Promise<TaskItem[]> {
    const entry = await this.serialized(filePath, sessionId);
    return entry ? structuredClone(entry.tasks.result()) : [];
  }

  /** One refresh per file at a time; later callers wait for and share the earlier one. */
  private async serialized(filePath: string, sessionId: string): Promise<Entry | null> {
    const previous = this.running.get(filePath) ?? Promise.resolve();
    const current = previous.then(
      () => this.refresh(filePath, sessionId),
      () => this.refresh(filePath, sessionId)
    );
    this.running.set(filePath, current);
    try {
      return await current;
    } finally {
      if (this.running.get(filePath) === current) this.running.delete(filePath);
    }
  }

  private async refresh(filePath: string, sessionId: string): Promise<Entry | null> {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      this.entries.delete(filePath);
      return null;
    }

    let entry = this.entries.get(filePath);
    if (
      entry &&
      (entry.sessionId !== sessionId ||
        entry.ino !== stat.ino ||
        stat.size < entry.size ||
        this.now() - entry.parsedAt > MAX_ENTRY_AGE_MS)
    ) {
      entry = undefined;
    }

    if (entry && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) {
      this.stats.hits += 1;
      this.touch(filePath, entry);
      return entry;
    }

    // Any failure from here leaves the entry half-advanced, so it is dropped
    // and the next read starts over rather than trusting it.
    this.entries.delete(filePath);
    const handle = await fs.open(filePath, 'r');
    try {
      if (entry && stat.size > entry.size && (await this.stillAppendOnly(handle, entry))) {
        this.stats.appends += 1;
      } else {
        this.stats.fullParses += 1;
        entry = {
          sessionId,
          ino: stat.ino,
          size: 0,
          mtimeMs: 0,
          offset: 0,
          tail: Buffer.alloc(0),
          parser: createTranscriptParser(),
          tasks: createTaskParser(),
          result: [],
          estimatedBytes: 0,
          parsedAt: this.now(),
        };
      }
      const images: TranscriptImageRef[] = [];
      await this.feed(handle, entry, stat.size, images);
      if (images.length > 0 && this.attachImages) {
        await this.attachImages(sessionId, entry.parser.unmerged(), images);
      }
    } finally {
      await handle.close();
    }

    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    entry.result = entry.parser.result();
    entry.estimatedBytes = estimateHistoryBytes(entry.parser.unmerged());
    this.keep(filePath, entry);
    return entry;
  }

  /** Whether the bytes before the parsed end are still the ones that were parsed. */
  private async stillAppendOnly(handle: fs.FileHandle, entry: Entry): Promise<boolean> {
    if (entry.tail.length === 0) return entry.offset === 0;
    const now = Buffer.alloc(entry.tail.length);
    const { bytesRead } = await handle.read(now, 0, now.length, entry.offset - entry.tail.length);
    return bytesRead === now.length && now.equals(entry.tail);
  }

  /**
   * Feed the parser every complete line between its offset and `end`.
   *
   * A line is complete at its newline. The bytes after the last newline are
   * fed only when they already parse as JSON (a final record written without
   * one); otherwise they are left for the next read, which will see them whole.
   */
  private async feed(
    handle: fs.FileHandle,
    entry: Entry,
    end: number,
    images: TranscriptImageRef[]
  ): Promise<void> {
    let position = entry.offset;
    // An unfinished line's pieces, joined only once its newline arrives, so a
    // multi-megabyte line is copied once rather than once per chunk.
    let carry: Buffer[] = [];
    while (position < end) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, end - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const piece = chunk.subarray(0, bytesRead);
      const lastNewline = piece.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        carry.push(piece);
        continue;
      }
      const lines = Buffer.concat([...carry, piece.subarray(0, lastNewline + 1)]);
      this.pushLines(entry, lines.toString('utf8', 0, lines.length - 1), images);
      carry = [piece.subarray(lastNewline + 1)];
      entry.offset = position - (bytesRead - lastNewline - 1);
      entry.tail = Buffer.from(lines.subarray(Math.max(0, lines.length - TAIL_CHECK_BYTES)));
    }
    const rest = Buffer.concat(carry);
    if (rest.length > 0 && isCompleteJson(rest.toString('utf8'))) {
      this.pushLines(entry, rest.toString('utf8'), images);
      entry.offset += rest.length;
      entry.tail = Buffer.from(rest.subarray(Math.max(0, rest.length - TAIL_CHECK_BYTES)));
    }
  }

  /** Parse each line once and hand the record to both parsers. */
  private pushLines(entry: Entry, text: string, images: TranscriptImageRef[]): void {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record: TranscriptLine;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      entry.parser.pushRecord(record, images);
      entry.tasks.pushRecord(record);
    }
  }

  /** Record a read: most recent last, then evict down to the budget. */
  private touch(filePath: string, entry: Entry): void {
    this.entries.delete(filePath);
    this.entries.set(filePath, entry);
  }

  private keep(filePath: string, entry: Entry): void {
    this.entries.delete(filePath);
    if (entry.estimatedBytes > this.maxBytes) return;
    this.entries.set(filePath, entry);
    let total = 0;
    for (const kept of this.entries.values()) total += kept.estimatedBytes;
    for (const [key, kept] of this.entries) {
      if (total <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      if (key === filePath) continue;
      this.entries.delete(key);
      total -= kept.estimatedBytes;
    }
  }
}

function isCompleteJson(text: string): boolean {
  if (!text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * **M1** — the mechanism that indexes append-only JSONL tailed at a byte offset
 * (message-search spec §3, §5).
 *
 * Written once for the mechanism, not once per source: discovery is the source's,
 * the projection is the source's, and everything between them — change detection,
 * the incremental read, the upsert, the shrink rebuild and the prune — lives
 * here. Claude Code uses it today and Codex joins it with one registry row.
 *
 * ## Two rules this file exists to get right
 *
 * **Line boundaries are the reader's problem.** The shipped `readFromOffset`
 * (`runtimes/claude-code/sessions/transcript-reader.ts`) advances its offset to
 * `stat.size` unconditionally, so a read landing mid-line returns a truncated
 * final record AND consumes its bytes — the record is lost forever, because the
 * next read starts past it. This reader retains any trailing partial line and
 * advances the stored offset only past the last COMPLETE line. What transfers
 * from the shipped reader is the `(mtimeMs, size)` change signal and nothing
 * else.
 *
 * **`\n` is the only line terminator.** Node's `readline` also splits on CR,
 * U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR. `JSON.stringify` escapes
 * none of those, and all of them are legal raw inside a JSON string, so a
 * runtime writing whole records emits them as written — 46 of them across the
 * operator's corpus, tearing 19 real messages into 64 unparseable fragments that
 * the very error handling meant to make a reader robust then discards. Splitting
 * the identical bytes on `\n` alone yields zero malformed lines (spec
 * Amendment 3). Never use `readline` here, and never a splitter that honours
 * Unicode line terminators.
 *
 * @module server/services/search/jsonl-frontier
 */
import fs from 'fs/promises';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { searchSources, eq, sql, type Db } from '@dorkos/db';
import {
  deleteContainerMessages,
  insertMessages,
  pruneVanished,
  readIndexedOrdinals,
  stampAttempt,
  type Writer,
} from './frontier-store.js';
import type {
  FileContainer,
  FileSource,
  KnownContainer,
  ProjectedMessage,
  SourceFailure,
  SourceSweep,
} from './types.js';

/**
 * How much of a file one `read()` pulls in.
 *
 * The delta is streamed rather than allocated whole — the other thing the
 * shipped `readFromOffset` does, and the reason a first sweep over a 671 MB
 * corpus would otherwise allocate one buffer per transcript.
 */
const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * How many complete lines are handed to the projection at once.
 *
 * Raw transcript lines are ~40× the text they contribute (tool results are
 * written twice per call, in two encodings), so batching is what keeps a first
 * read of a large transcript from holding the whole file's raw bytes in memory.
 * The projected messages are kept — they are the small half — and written in one
 * transaction per file.
 */
const PROJECT_BATCH_LINES = 2_000;

/**
 * How many bytes may sit unterminated before the reader gives up on a file.
 *
 * A JSONL file whose "line" never ends is either not JSONL or is one record
 * larger than any transcript has ever held (the largest measured is under a
 * megabyte). Without a cap the reader would buffer the whole file into one
 * string to look for a newline that is not coming, every five minutes forever.
 */
const MAX_CARRY_BYTES = 64 * 1024 * 1024;

/**
 * One file held more unterminated bytes than {@link MAX_CARRY_BYTES}.
 *
 * Its own type because the failure path treats it differently: an ordinary
 * failure retries next sweep, while this one is a property of bytes already on
 * disk and cannot resolve until the file changes. See {@link recordFailure}.
 */
class UnterminatedLineError extends Error {}

/**
 * The `originKey` a failure carries when there is no container to blame —
 * discovery itself failed, so nothing was enumerated to attribute it to. Both
 * shapes use it: a discovery that rejected outright, and one root of several
 * that could not be read.
 *
 * It names no row and none is written: `search_sources` is keyed by container,
 * and inventing a container id to hold an error would put a row in the frontier
 * that discovery can never return, which the prune would then delete on the
 * first healthy sweep. That is a deliberate narrowing of spec Amendment 2's
 * "one `search_sources.last_error` and zero rows" for the per-root case — the
 * visibility it asks for is delivered through {@link SourceSweep.failures},
 * which the reconciler logs, rather than through a row that would flap in and
 * out of the frontier every five minutes.
 */
export const DISCOVERY_FAILURE_KEY = '(discovery)';

/**
 * The `originKey` a failure carries when it is about MANY containers at once —
 * a duplicated directory, where every session id inside it has a twin.
 *
 * A summary cannot borrow one of the ids it summarises: naming the first of 300
 * would read as a fault in that one session, which is the opposite of what
 * happened. A single collision keeps its own id and this key never appears.
 */
export const DUPLICATE_CONTAINERS_KEY = '(duplicate containers)';

/** One file's resume state, read once per sweep rather than once per file. */
interface JsonlFrontierRow {
  /** Bytes already consumed — always just past a newline, never mid-line. */
  byteOffset: number;

  /**
   * Size at the last read. Below it means the file was replaced.
   *
   * Together with {@link JsonlFrontierRow.mtimeMs} this is the whole change
   * signal, and its one blind spot is worth naming: a replacement that lands on
   * the same size and the same mtime reads as no change at all. It needs a
   * rewrite within one millisecond that preserves the byte count exactly, and
   * the answer if it ever happens is a rebuild rather than a repair.
   */
  sizeBytes: number;

  /** Mtime at the last read, in epoch milliseconds. */
  mtimeMs: number;

  /**
   * The highest ordinal this file has contributed, or `null` when it has
   * contributed no message yet — a file of nothing but tool results is a real
   * and permanent case, not a not-yet-read one.
   */
  lastOrdinal: number | null;

  /** The working directory the last sweep recorded, reused when nothing changed. */
  containerPath: string | null;
}

/**
 * Bring one file-backed source's slice of the index up to date.
 *
 * Discovery reports what exists; two queries report what the index already has;
 * only files whose `(size, mtime)` moved do any reading. **A file that has not
 * changed costs one `readdir` entry and one `stat`, and nothing else** — not a
 * transcript read, and not the head read that classifies a file, which discovery
 * settles from the frontier row this sweep hands it. That last clause is the
 * whole reason the frontier is read before discovery rather than after.
 *
 * **A file that throws does not stop the sweep.** Its failure is written to
 * `search_sources.last_error`, its byte offset is left where it was so the next
 * pass retries from the same place, and the remaining files index normally.
 *
 * @param db - The database to write the index to. Must have been opened through
 *   `createDb` — see the `recursive_triggers` note in `packages/db/src/index.ts`.
 * @param source - The registry row being swept.
 * @param at - The ISO-8601 timestamp to stamp this attempt with.
 * @param options - Test seam. `maxCarryBytes` shrinks the unterminated-line cap
 *   so a test can prove the stall path; production never passes it.
 */
export async function sweepFileSource(
  db: Db,
  source: FileSource,
  at: string,
  options: { maxCarryBytes?: number } = {}
): Promise<SourceSweep> {
  const sweep: SourceSweep = {
    sourceId: source.id,
    containers: 0,
    indexed: 0,
    skipped: 0,
    pruned: 0,
    rebuilt: 0,
    failures: [],
  };

  // The frontier is read BEFORE discovery, not after, so discovery can settle an
  // unchanged file from what the last sweep already decided rather than reading
  // its head bytes again.
  const frontier = readJsonlFrontier(db, source.id);

  // **Discovery failing is a source failure, not a sweep failure.** It reaches a
  // filesystem, so it can fail for reasons that have nothing to do with this
  // process — a root on a disconnected volume, a permission removed underneath
  // it. Letting that reject would take down every OTHER source in the same tick,
  // and `SweepResult.failures` promises the opposite: one source contributes zero
  // rows and one warning, never a failed sweep. Nothing is pruned on this path —
  // an empty container list from a failed discovery must never be read as "every
  // container is gone".
  let discovery;
  try {
    discovery = await source.discover(knownContainers(frontier));
  } catch (err) {
    sweep.failures.push({
      sourceId: source.id,
      originKey: DISCOVERY_FAILURE_KEY,
      message: err instanceof Error ? err.message : String(err),
    });
    return sweep;
  }
  sweep.containers = discovery.files.length;

  // **A root that could not be read is reported, never absorbed.** Discovery
  // spans several roots — one per Claude Code account — and it resolves rather
  // than rejecting when one of them fails, so that the readable roots still
  // index. What it must not do is let the unreadable one pass for an account
  // with nothing in it, which is exactly the "a short list looks like a complete
  // one" failure this feature exists to refuse (spec Amendment 2, G3).
  for (const failure of discovery.failures) {
    sweep.failures.push({
      sourceId: source.id,
      originKey: DISCOVERY_FAILURE_KEY,
      message: `${failure.root}: ${failure.message}`,
    });
  }

  const indexedOrdinals = readIndexedOrdinals(db, source.id);
  const live = new Set(discovery.files.map((file) => file.originKey));

  // **Two files claiming one container id: refuse BOTH.**
  //
  // `search_sources` is keyed `(source_id, origin_key)`, so a container id is a
  // single row and a single slice of `messages`. Two files cannot share it. An
  // earlier version indexed whichever came first and refused the second, which
  // sounds conservative and is not: directory order is not stable across
  // machines or across a rename, so the SAME pair could index one twin on one
  // sweep and the other twin on the next, leaving a slice built from both. What
  // survives here instead is whatever was already indexed under that id, frozen
  // and untouched, plus one failure per id on the sweep result.
  //
  // Neither twin's frontier row is written — not even `last_error` — because
  // there is no row that could honestly describe the situation: the row would
  // have to name one file's size, mtime and offset while the error is about
  // there being two. Both are still in `live`, so the prune leaves the existing
  // rows alone. Session ids are UUIDs and no collision exists on any corpus
  // measured, which is exactly why this is asserted rather than assumed.
  //
  // **Several roots is where this stops being hypothetical.** Within one Claude
  // Code account a duplicate session id takes a copied transcript; across
  // accounts it takes only a config directory that was copied, or one root
  // symlinked into another. The failure message therefore names the FULL PATH of
  // every claimant, which is what tells an operator which two accounts collided —
  // a bare session id would leave them grepping for it.
  //
  // **And a whole DIRECTORY duplicated is one fault, so it is one failure.** The
  // realistic multi-root shape is not one stray session id, it is every session
  // id at once — a symlinked account produces a twin for all several hundred
  // files. Reporting each of them separately buries the one fact an operator can
  // act on ("these two directories are the same directory") under hundreds of
  // identical lines, every five minutes, forever. Collisions sharing the same
  // pair of locations are therefore summarised into a single failure.
  const claims = new Map<string, string[]>();
  for (const file of discovery.files) {
    const paths = claims.get(file.originKey);
    if (paths) paths.push(file.filePath);
    else claims.set(file.originKey, [file.filePath]);
  }

  const contested = new Set<string>();
  for (const [originKey, twins] of claims) {
    if (twins.length > 1) contested.add(originKey);
  }
  for (const failure of describeContestedContainers(source.id, claims, contested)) {
    sweep.failures.push(failure);
  }

  for (const file of discovery.files) {
    if (contested.has(file.originKey)) continue;

    try {
      const outcome = await indexFile(db, source, file, frontier.get(file.originKey), {
        indexedTo: indexedOrdinals.get(file.originKey) ?? null,
        at,
        ...(options.maxCarryBytes === undefined ? {} : { maxCarryBytes: options.maxCarryBytes }),
      });
      sweep.indexed += outcome.indexed;
      sweep.skipped += outcome.skipped;
      if (outcome.rebuilt) sweep.rebuilt += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(db, source.id, file, frontier.get(file.originKey), {
        at,
        message,
        stalled: err instanceof UnterminatedLineError,
      });
      sweep.failures.push({ sourceId: source.id, originKey: file.originKey, message });
    }
  }

  // A file that is GONE loses its rows; a file whose working directory is gone
  // keeps every one of them. See {@link pruneVanished}.
  //
  // **Only when discovery was COMPLETE.** A container absent because its root
  // could not be listed is not a container that is gone, and pruning on a
  // partial enumeration would delete an entire account's history the moment its
  // volume hiccupped — then pay a full rebuild to get it back. It is the same
  // rule the rejected-discovery path above already follows.
  //
  // **The cost, stated plainly rather than softened.** This is not "stale rows
  // survive one extra sweep". A root that is PERMANENTLY unreadable — a
  // registered account on a disk that never comes back, a permission nobody
  // restores — freezes pruning for EVERY root, indefinitely: deleted transcripts
  // from healthy accounts keep answering searches until the broken root is
  // fixed or removed from the config. The failure is at least loud, which is why
  // this is survivable and the alternative is not. The real fix is per-root
  // pruning, which needs a `root` column on `search_sources` so a frontier row
  // can say which account it came from; that is filed as follow-up work rather
  // than smuggled into this ticket.
  sweep.pruned =
    discovery.failures.length > 0
      ? 0
      : pruneVanished(db, source.id, live, [...frontier.keys(), ...indexedOrdinals.keys()]);
  stampAttempt(db, source.id, at);
  return sweep;
}

/**
 * The part of each path that is NOT shared with the others, reading from the
 * right — for a set of files claiming one container id, the locations that
 * distinguish them.
 *
 * Two accounts holding the same session id differ only in their root, so
 * `/a/projects/slug/s.jsonl` and `/b/projects/slug/s.jsonl` reduce to `/a` and
 * `/b`. Two slugs inside one root reduce to the two slug directories. Either way
 * the answer is the thing an operator would go and look at, and it is derived
 * from the paths themselves rather than from a root list this function would
 * otherwise have to be handed.
 *
 * @param paths - Absolute paths, at least two, sharing at least a filename.
 * @returns One distinguishing prefix per input, in the same order.
 */
function distinctPrefixes(paths: readonly string[]): string[] {
  const split = paths.map((filePath) => filePath.split(path.sep));
  const shortest = Math.min(...split.map((segments) => segments.length));

  // Stop one short of consuming a whole path: something has to be left to name,
  // and two paths where one is a suffix of the other still differ at the root.
  let shared = 0;
  while (shared < shortest - 1) {
    const tail = split.map((segments) => segments[segments.length - 1 - shared]);
    if (new Set(tail).size !== 1) break;
    shared += 1;
  }

  return split.map(
    (segments) => segments.slice(0, segments.length - shared).join(path.sep) || path.sep
  );
}

/**
 * Turn every contested container id into the fewest honest failures.
 *
 * One collision reports itself, naming both files in full. Collisions that share
 * the same pair of locations — the shape a duplicated or symlinked account makes,
 * where every session id inside it is a twin — collapse into one failure naming
 * those locations and how many ids they cost. See the block comment at the call
 * site for why that matters.
 *
 * @param sourceId - Which source.
 * @param claims - Every container id and the files claiming it.
 * @param contested - The ids claimed more than once.
 * @returns One failure per distinct pair of colliding locations.
 */
function describeContestedContainers(
  sourceId: string,
  claims: ReadonlyMap<string, string[]>,
  contested: ReadonlySet<string>
): SourceFailure[] {
  const groups = new Map<string, { locations: string[]; ids: string[] }>();
  for (const originKey of contested) {
    const twins = claims.get(originKey) ?? [];
    const locations = distinctPrefixes(twins);
    // A NUL (`\u0000`) cannot occur in a path, so it separates without ever
    // joining two locations that only look adjacent.
    const signature = locations.join('\u0000');
    const group = groups.get(signature);
    if (group) group.ids.push(originKey);
    else groups.set(signature, { locations, ids: [originKey] });
  }

  return [...groups.values()].map(({ locations, ids }) => {
    if (ids.length === 1) {
      const originKey = ids[0] as string;
      const twins = claims.get(originKey) ?? [];
      return {
        sourceId,
        originKey,
        message: `${twins.length} files claim this container id and none was indexed: ${twins.join(', ')}`,
      };
    }
    return {
      sourceId,
      originKey: DUPLICATE_CONTAINERS_KEY,
      message:
        `${ids.length} container ids are claimed by more than one file and none was indexed. ` +
        `The claimants differ only in these locations, which are probably the same directory ` +
        `reached two ways: ${locations.join(', ')}`,
    };
  });
}

/**
 * The frontier, narrowed to what discovery is allowed to see.
 *
 * Deliberately not the frontier rows themselves: discovery has no business with
 * a byte offset or an ordinal, and handing it the whole row would invite a
 * second reader of the resume position.
 */
function knownContainers(
  frontier: ReadonlyMap<string, JsonlFrontierRow>
): Map<string, KnownContainer> {
  const known = new Map<string, KnownContainer>();
  for (const [originKey, row] of frontier) {
    known.set(originKey, {
      sizeBytes: row.sizeBytes,
      mtimeMs: row.mtimeMs,
      containerPath: row.containerPath,
    });
  }
  return known;
}

/** Read every file's resume state for one source, in one query. */
function readJsonlFrontier(db: Db, sourceId: string): Map<string, JsonlFrontierRow> {
  const state = new Map<string, JsonlFrontierRow>();
  for (const row of db
    .select({
      originKey: searchSources.originKey,
      byteOffset: searchSources.byteOffset,
      sizeBytes: searchSources.sizeBytes,
      mtimeMs: searchSources.mtimeMs,
      lastOrdinal: searchSources.lastOrdinal,
      containerPath: searchSources.containerPath,
    })
    .from(searchSources)
    .where(eq(searchSources.sourceId, sourceId))
    .all()) {
    state.set(row.originKey, {
      byteOffset: row.byteOffset ?? 0,
      sizeBytes: row.sizeBytes ?? 0,
      mtimeMs: row.mtimeMs ?? 0,
      lastOrdinal: row.lastOrdinal,
      containerPath: row.containerPath,
    });
  }
  return state;
}

/**
 * Index everything one file has gained since the last pass.
 *
 * @returns What was written, what the projection could not use, and whether the
 *   file was re-read whole.
 */
async function indexFile(
  db: Db,
  source: FileSource,
  file: FileContainer,
  known: JsonlFrontierRow | undefined,
  ctx: { indexedTo: number | null; at: string; maxCarryBytes?: number }
): Promise<{ indexed: number; skipped: number; rebuilt: boolean }> {
  // **Shrink means rebuild.** A file below its recorded size was truncated or
  // replaced, and a byte offset into a rewritten file points at the middle of a
  // line — so the offset is worthless and re-reading from zero is the only
  // correct answer. It costs milliseconds.
  const shrank = known !== undefined && file.sizeBytes < known.sizeBytes;

  // The index no longer holds what the frontier claims it wrote. `DELETE FROM
  // messages` is the half of the index anyone would actually think to throw
  // away, and a byte offset trusted on its own would leave this file reporting
  // "nothing new" forever, with search returning nothing and no error recorded
  // anywhere. The frontier is never the only signal.
  const lost =
    known?.lastOrdinal != null && (ctx.indexedTo === null || ctx.indexedTo < known.lastOrdinal);

  // The other half of "deleting the index is a supported recovery": the frontier
  // row is gone but the message rows are not. Resuming at ordinal
  // `indexedTo + 1` from byte zero would index the whole file a second time
  // under fresh ordinals, so every message would be searchable twice.
  const orphaned = known === undefined && ctx.indexedTo !== null;

  const rebuilt = shrank || lost || orphaned;

  // Neither signal moved and the index really holds what the frontier claims.
  // A file whose last read stopped on a partial line lands here too, correctly:
  // the partial cannot have completed without the file growing.
  if (
    !rebuilt &&
    known !== undefined &&
    file.sizeBytes === known.sizeBytes &&
    file.mtimeMs === known.mtimeMs
  ) {
    return { indexed: 0, skipped: 0, rebuilt: false };
  }

  const fromOffset = rebuilt ? 0 : (known?.byteOffset ?? 0);
  // Ordinals continue from what the index holds, so an append never renumbers
  // what is already searchable. On a rebuild they restart at zero, which is
  // exactly why the rebuild deletes the file's rows first.
  const firstOrdinal = rebuilt ? 0 : (ctx.indexedTo ?? -1) + 1;

  const collected: ProjectedMessage[] = [];
  let skipped = 0;
  let nextOrdinal = firstOrdinal;

  const read = await readJsonlLines(
    file.filePath,
    fromOffset,
    (lines) => {
      const projection = source.project(lines, {
        originKey: file.originKey,
        firstOrdinal: nextOrdinal,
      });
      collected.push(...projection.messages);
      skipped += projection.skipped;
      nextOrdinal += projection.messages.length;
    },
    ctx.maxCarryBytes
  );

  const lastOrdinal = collected.at(-1)?.ordinal ?? (rebuilt ? null : (known?.lastOrdinal ?? null));

  db.transaction((tx) => {
    if (rebuilt) deleteContainerMessages(tx, source.id, file.originKey);
    insertMessages(tx, source.id, collected);
    writeFrontier(tx, source.id, file, {
      // Only past the last COMPLETE line. Never `stat.size`.
      byteOffset: read.nextOffset,
      // The larger of the two sizes: discovery's stat can be stale by the time
      // the read reaches EOF, and recording the smaller one would let a later
      // truncation back to that size read as growth.
      sizeBytes: Math.max(file.sizeBytes, read.size),
      // Discovery's mtime deliberately, not the read's: a file that changed
      // between the two is re-read next sweep rather than recorded as caught up.
      mtimeMs: file.mtimeMs,
      lastOrdinal,
      lastIndexedAt: ctx.at,
      lastError: null,
    });
  });

  return { indexed: collected.length, skipped, rebuilt };
}

/** What one incremental read consumed. */
interface JsonlRead {
  /**
   * Bytes consumed in total — the position just past the last complete line, and
   * the offset the next read resumes at. A trailing partial line is left
   * unconsumed so the record it belongs to is read whole once it is written.
   */
  nextOffset: number;

  /** The file's size when the read opened it. */
  size: number;
}

/**
 * Read complete lines from a byte offset, in batches, splitting on `\n` alone.
 *
 * Blank lines are consumed and never handed on: two adjacent newlines are not a
 * record, and passing an empty string to a projection would count as a
 * malformed line that never existed.
 *
 * **Byte accounting comes from the RAW bytes, never from the decoded text**, and
 * that distinction is not academic. `StringDecoder` maps every invalid byte to
 * U+FFFD, which re-encodes to THREE bytes — so a file holding invalid UTF-8
 * (measured: a 202-byte file) made a decoded-length accounting store an offset of
 * 242, past its own EOF. The next appended message then satisfied
 * `size <= fromOffset`, was never read, and was lost permanently with no error
 * recorded anywhere. The resume position is a byte offset into a file, so it is
 * derived from the position of the last `\n` BYTE in each chunk and from nothing
 * else. That also makes `nextOffset <= size` a structural guarantee rather than a
 * hope.
 *
 * @param filePath - The file to read.
 * @param fromOffset - Where to resume. Must be a position just past a newline.
 * @param onBatch - Called with up to {@link PROJECT_BATCH_LINES} complete lines,
 *   in file order.
 * @param maxCarryBytes - How many unterminated bytes to tolerate before giving
 *   up on the file. A parameter only so a test can prove the cap; production
 *   always takes {@link MAX_CARRY_BYTES}.
 * @returns Where the next read resumes, and the size this read saw.
 * @throws {UnterminatedLineError} When one line exceeds `maxCarryBytes`.
 */
async function readJsonlLines(
  filePath: string,
  fromOffset: number,
  onBatch: (lines: string[]) => void,
  maxCarryBytes: number = MAX_CARRY_BYTES
): Promise<JsonlRead> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= fromOffset) return { nextOffset: fromOffset, size };

    // Never the full chunk size for a small delta: a one-line append should not
    // allocate a megabyte, and a sweep touches every file that moved.
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - fromOffset));
    // A chunk boundary can fall inside a multi-byte character. `toString('utf8')`
    // on each chunk in isolation would replace the split character with U+FFFD
    // and corrupt a real message; the decoder holds the incomplete bytes back
    // until the next chunk completes them.
    const decoder = new StringDecoder('utf8');
    let position = fromOffset;
    let consumed = fromOffset;
    let carry = '';
    let batch: string[] = [];

    while (position < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position
      );
      if (bytesRead === 0) break;
      const chunkStart = position;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);

      // The resume position, from the raw bytes. `lastIndexOf` is one scan and
      // it answers the only question the offset cares about: where the last
      // complete line ended. Everything after it is a partial line, and it stays
      // unconsumed however many bytes it turns out to be.
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline !== -1) consumed = chunkStart + lastNewline + 1;

      // What has been READ but not CONSUMED is exactly the unterminated tail, so
      // the cap costs a subtraction rather than a scan of a growing string.
      if (position - consumed > maxCarryBytes) {
        throw new UnterminatedLineError(
          `no line terminator in ${position - consumed} bytes from offset ${consumed}; ` +
            `the file is not newline-delimited JSON, or one record exceeds ${maxCarryBytes} bytes`
        );
      }

      carry += decoder.write(chunk);
      // Split on `\n` and nothing else. See this module's header.
      const parts = carry.split('\n');
      // The last part is whatever followed the final newline — a partial line,
      // or '' when the chunk ended exactly on one. Either way it is not consumed.
      carry = parts.pop() ?? '';

      for (const line of parts) {
        if (line.trim() === '') continue;
        batch.push(line);
        if (batch.length >= PROJECT_BATCH_LINES) {
          onBatch(batch);
          batch = [];
        }
      }
    }

    if (batch.length > 0) onBatch(batch);
    return { nextOffset: consumed, size };
  } finally {
    await handle.close();
  }
}

/**
 * Everything one frontier row records for a file-backed container, minus the
 * container path — that comes from the {@link FileContainer} being written, which
 * is the only thing that knows whether it was re-read or reused.
 */
interface JsonlFrontierWrite extends Omit<JsonlFrontierRow, 'containerPath'> {
  /** ISO-8601 timestamp of this attempt. */
  lastIndexedAt: string;

  /** Why the attempt produced nothing, or `null` when it succeeded. */
  lastError: string | null;
}

/** Upsert one file's frontier row. */
function writeFrontier(
  writer: Writer,
  sourceId: string,
  file: FileContainer,
  row: JsonlFrontierWrite
): void {
  writer
    .insert(searchSources)
    .values({
      sourceId,
      originKey: file.originKey,
      byteOffset: row.byteOffset,
      sizeBytes: row.sizeBytes,
      mtimeMs: row.mtimeMs,
      lastOrdinal: row.lastOrdinal,
      // The cwd a hit opens in, from the file's head record. A file whose
      // directory has since been removed keeps this value and keeps its rows;
      // the result says the directory is gone rather than failing on a path.
      containerPath: file.containerPath,
      lastIndexedAt: row.lastIndexedAt,
      lastError: row.lastError,
    })
    .onConflictDoUpdate({
      target: [searchSources.sourceId, searchSources.originKey],
      set: {
        byteOffset: sql`excluded.byte_offset`,
        sizeBytes: sql`excluded.size_bytes`,
        mtimeMs: sql`excluded.mtime_ms`,
        lastOrdinal: sql`excluded.last_ordinal`,
        containerPath: sql`excluded.container_path`,
        lastIndexedAt: sql`excluded.last_indexed_at`,
        lastError: sql`excluded.last_error`,
      },
    })
    .run();
}

/**
 * Record why a file produced nothing, leaving its resume position alone.
 *
 * The byte offset is deliberately not advanced: the next pass must retry the
 * same bytes, not skip them because an attempt was made.
 *
 * `stalled` is the one exception, and it is about which failures can resolve on
 * their own. An ordinary failure — a projection that threw, a permission that
 * will be granted back — is worth retrying every five minutes, so the recorded
 * fingerprint stays where it was and the next sweep reads again. A file with no
 * line terminator in it cannot become terminated without changing, so its
 * CURRENT `(size, mtime)` is recorded: the next sweep sees it as unchanged and
 * skips it entirely, and it is picked back up the moment somebody appends. The
 * failure stays visible in `last_error` the whole time.
 *
 * @param db - The database to write.
 * @param sourceId - Which source.
 * @param file - The file that failed, as discovery reported it.
 * @param known - Its frontier row before this attempt, if it had one.
 * @param outcome - When the attempt ran, what went wrong, and whether the file
 *   can be expected to fail identically until it changes.
 */
function recordFailure(
  db: Db,
  sourceId: string,
  file: FileContainer,
  known: JsonlFrontierRow | undefined,
  outcome: { at: string; message: string; stalled: boolean }
): void {
  db.transaction((tx) =>
    writeFrontier(tx, sourceId, file, {
      byteOffset: known?.byteOffset ?? 0,
      sizeBytes: outcome.stalled ? file.sizeBytes : (known?.sizeBytes ?? 0),
      mtimeMs: outcome.stalled ? file.mtimeMs : (known?.mtimeMs ?? 0),
      lastOrdinal: known?.lastOrdinal ?? null,
      lastIndexedAt: outcome.at,
      lastError: outcome.message,
    })
  );
}

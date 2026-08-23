/**
 * CLI handler for `dorkos room export` (DOR-1225).
 *
 * Rooms live only in the DorkOS database, so this is the verb that turns one
 * into a file: `GET /api/rooms/:id/export` streamed straight to disk, one JSON
 * object per line. The server decides WHAT the file says; this command decides
 * WHERE it lands, which is the split that keeps a filesystem write on the
 * machine the person is sitting at rather than behind an HTTP route.
 *
 * Two things it does beyond moving bytes:
 *
 * - **Names a room the way a person does.** `#backend`, `backend` and the room's
 *   ULID all work, resolved through `GET /api/rooms`.
 * - **Checks the receipt.** An export's last line is a `summary`; a download
 *   that died half-way is otherwise a perfectly valid file of the messages that
 *   made it. A file with no summary is reported as incomplete and exits
 *   non-zero, rather than being handed over as though it were whole.
 *
 * Handlers return an exit code rather than calling `process.exit` so `cli.ts`
 * stays the single source of truth for termination.
 *
 * @module commands/room
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { apiCall, apiRequest } from '../lib/api-client.js';
import { printError } from '../lib/operator-output.js';

/** Help text for `dorkos room` (no subcommand or `--help`). */
export const ROOM_USAGE = `Usage: dorkos room <subcommand> [options]

Work with your channels and direct messages from the terminal.

Subcommands:
  export <room>              Save a room's whole history as a file

export options:
      --out <file>           Where to write it. Use "-" for standard output.
                             Defaults to a name based on the room, in the
                             current directory.
      --force                Overwrite the file if it already exists

Examples:
  dorkos room export #backend
  dorkos room export backend --out ~/archive/backend.jsonl
  dorkos room export 01JABC... --out - | grep deploy`;

/** Written to stdout instead of a file. */
const STDOUT_TARGET = '-';

/** A room as `GET /api/rooms` returns it, narrowed to what resolution needs. */
interface RoomListItem {
  id: string;
  slug: string | null;
  title: string;
}

/** Parsed arguments for `dorkos room export`. */
export interface RoomExportArgs {
  /** What the person typed: `#backend`, `backend`, or a room id. */
  room: string;
  /** Destination path, `'-'` for stdout, or undefined to use the server's name. */
  out?: string;
  force: boolean;
}

/**
 * Parse the argv slice after `dorkos room export`.
 *
 * @param rawArgs - Argv after `export`.
 * @returns Typed {@link RoomExportArgs}.
 */
export function parseRoomExportArgs(rawArgs: string[]): RoomExportArgs {
  const usage = 'Usage: dorkos room export <room> [--out <file>] [--force]';
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        out: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    if (
      err instanceof TypeError &&
      (err as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    ) {
      const match = err.message.match(/Unknown option '([^']+)'/);
      throw new Error(`Unknown option for 'room export': ${match?.[1] ?? 'unknown'}\n${usage}`);
    }
    throw err;
  }
  const room = parsed.positionals[0];
  if (!room) throw new Error(`Name the room you want to export.\n${usage}`);
  if (parsed.positionals.length > 1) {
    throw new Error(`Export one room at a time.\n${usage}`);
  }
  return {
    room,
    out: typeof parsed.values.out === 'string' ? parsed.values.out : undefined,
    force: Boolean(parsed.values.force),
  };
}

/**
 * Turn what somebody typed into a room id.
 *
 * A ULID goes straight through — asking the server for the whole room list to
 * confirm an id it is about to be given anyway is a round trip for nothing, and
 * the export call itself answers "no such room" perfectly well. Anything else is
 * matched against channel slugs, then against titles, both case-insensitively,
 * with a leading `#` ignored because that is how a channel is written.
 *
 * @param reference - `#backend`, `backend`, or a room id.
 * @returns The room id to export.
 */
async function resolveRoomId(reference: string): Promise<string> {
  const wanted = reference.replace(/^#/, '').toLowerCase();
  if (!reference.startsWith('#') && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(reference)) {
    return reference;
  }

  const { rooms } = await apiCall<{ rooms: RoomListItem[] }>('GET', '/api/rooms');
  const bySlug = rooms.filter((room) => room.slug?.toLowerCase() === wanted);
  if (bySlug.length === 1) return bySlug[0].id;

  const byTitle = rooms.filter((room) => room.title.toLowerCase() === wanted);
  if (byTitle.length === 1) return byTitle[0].id;
  if (byTitle.length > 1) {
    throw new Error(
      `More than one room is called "${reference}". Use its id instead:\n` +
        byTitle.map((room) => `  ${room.id}  ${room.title}`).join('\n')
    );
  }
  throw new Error(`No room called "${reference}". Run \`dorkos room export --help\` for examples.`);
}

/**
 * The filename the server suggested, or a fallback built from the room id.
 *
 * The suggestion is read out of `Content-Disposition` and then reduced to its
 * basename: a filename is a name, and a header is not a place to accept a path
 * from.
 *
 * @param disposition - The `Content-Disposition` header, if any.
 * @param roomId - The room, for the fallback name.
 */
function suggestedFilename(disposition: string | null, roomId: string): string {
  const match = disposition?.match(/filename="([^"]+)"/);
  const name = match ? path.basename(match[1]) : '';
  return name && name !== '.' && name !== '..' ? name : `room-${roomId}.jsonl`;
}

/** What a finished (or unfinished) download turned out to be. */
interface ExportOutcome {
  /**
   * How many messages the trailing summary claimed, or `null` when there was no
   * trailing summary — which is exactly what a truncated download leaves.
   */
  entryCount: number | null;
  /**
   * Why it stopped, when it stopped for a reason this process saw: a dropped
   * connection, a full disk. `null` when the body simply ended short, which the
   * missing receipt already reports.
   */
  reason: string | null;
}

/**
 * Stream the export into a writable, keeping only the last line in memory.
 *
 * The whole point of streaming it is that a room's history has no size bound, so
 * nothing here may accumulate the body. What IS accumulated is one line: the
 * export's trailing `summary`, which is the only evidence that the file is
 * whole. Chunks do not arrive line-aligned, so it is tracked across them rather
 * than read off the last chunk.
 *
 * **A stream failure is reported, not thrown.** A dropped connection rejects the
 * pipeline with something like `terminated`, and letting that reach the caller's
 * generic error handler is how a person ends up reading `Error: terminated`
 * about their own history. It comes back as an outcome with no receipt and a
 * reason instead, so there is exactly one "this export is not whole" path and it
 * says the useful thing.
 *
 * @param body - The response body.
 * @param destination - Where the bytes go.
 * @param closeDestination - Whether to close it when the body ends. False for
 *   `process.stdout`, which this command does not own and must leave open for
 *   the message it writes afterwards.
 * @returns What arrived, and why it stopped if it stopped badly.
 */
async function streamExport(
  body: ReadableStream<Uint8Array>,
  destination: NodeJS.WritableStream,
  closeDestination: boolean
): Promise<ExportOutcome> {
  const decoder = new TextDecoder();
  let pending = '';
  let lastLine = '';

  const watched = async function* watch(): AsyncGenerator<Uint8Array> {
    for await (const chunk of Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])) {
      const bytes = chunk as Uint8Array;
      pending += decoder.decode(bytes, { stream: true });
      const parts = pending.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) if (part.trim()) lastLine = part;
      yield bytes;
    }
  };

  let reason: string | null = null;
  try {
    await pipeline(watched(), destination, { end: closeDestination });
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }

  try {
    const trailing = pending.trim() || lastLine;
    const parsed = JSON.parse(trailing) as { type?: string; entryCount?: number };
    if (parsed.type === 'summary' && typeof parsed.entryCount === 'number') {
      // A receipt that arrived before a late failure still means the export is
      // whole — but only if nothing went wrong on the way, since a write that
      // failed after the last line landed did not put those bytes on disk.
      if (reason === null) return { entryCount: parsed.entryCount, reason: null };
    }
  } catch {
    // Not JSON at all — the body stopped mid-line, which the null receipt says.
  }
  return { entryCount: null, reason };
}

/**
 * Write the export to a file, or leave the file exactly as it was.
 *
 * **The staging directory is the whole point.** Writing straight to the target
 * truncates it the moment the stream opens, so a `--force` retry whose download
 * then died replaced a good export from last month with two partial lines — and
 * `--force` is precisely what somebody retrying a failed export reaches for. The
 * bytes land in a scratch directory beside the target instead, and the rename
 * only happens once the trailing receipt has been read. Beside it, not in the
 * system temp directory, so the rename stays on one filesystem and is therefore
 * atomic; a fresh `mkdtemp` rather than a predictable `.partial`, so two runs of
 * this command cannot write to one staging file. It is the same shape the
 * marketplace installer uses (stage → atomic rename → clean up).
 *
 * @param body - The response body.
 * @param target - The absolute path the export should end up at.
 * @returns What arrived. The target is untouched unless this reports a receipt.
 */
async function writeExportFile(
  body: ReadableStream<Uint8Array>,
  target: string
): Promise<ExportOutcome> {
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.dorkos-export-'));
  const scratch = path.join(staging, path.basename(target));
  // Opened inside the try so a synchronous throw here still runs the cleanup below.
  let file: fs.WriteStream | undefined;
  try {
    file = fs.createWriteStream(scratch);
    const outcome = await streamExport(body, file, true);
    if (outcome.entryCount !== null) fs.renameSync(scratch, target);
    return outcome;
  } finally {
    // Wait for the file to be let go of before touching the directory it is in.
    // A download that dies rejects the pipeline while the scratch file's `open`
    // is still running on the threadpool, so the file appears a moment AFTER
    // the export has failed — and a file appearing mid-sweep makes `rmSync`
    // fail with ENOTEMPTY, which `force` does not forgive (it forgives a
    // missing path, not a directory that refilled). That is how a failed export
    // left a `.dorkos-export-*` directory on somebody's disk. Once the stream
    // has closed there is nothing left in flight to race.
    if (file) await finished(file).catch(() => {});
    // All-or-nothing: a file with no receipt cannot be read as an export, so
    // leaving one behind would only be a trap for whoever found it later.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Implements `dorkos room export`.
 *
 * @param args - Parsed export arguments.
 * @returns The intended process exit code.
 */
export async function runRoomExport(args: RoomExportArgs): Promise<number> {
  try {
    const roomId = await resolveRoomId(args.room);
    const res = await apiRequest('GET', `/api/rooms/${encodeURIComponent(roomId)}/export`);
    if (!res.body) throw new Error('The server sent no export.');

    const toStdout = args.out === STDOUT_TARGET;
    let target: string | null = null;
    if (!toStdout) {
      target = path.resolve(
        args.out ?? suggestedFilename(res.headers.get('content-disposition'), roomId)
      );
      // Refused rather than overwritten: an export is somebody's history, and
      // the one keystroke between `backend.jsonl` and the copy they made last
      // month should not be able to destroy it.
      if (!args.force && fs.existsSync(target)) {
        console.error(`Error: ${target} already exists. Pass --force to replace it.`);
        return 1;
      }
    }

    const outcome = target
      ? await writeExportFile(res.body, target)
      : await streamExport(res.body, process.stdout, false);

    if (outcome.entryCount === null) {
      // Never reported as a success. An export with no trailing summary stopped
      // part-way, and it is a copy of somebody's history that they may be about
      // to rely on.
      console.error('Error: the export stopped before it finished, so it is not complete.');
      if (outcome.reason) console.error(`Reason: ${outcome.reason}`);
      console.error(
        target
          ? `Nothing was written — ${target} is exactly as it was. Run the command again.`
          : 'What you have above is incomplete. Run the command again.'
      );
      return 1;
    }

    const { entryCount } = outcome;
    const messages = `${entryCount} ${entryCount === 1 ? 'message' : 'messages'}`;
    // On stderr even in the file case, so `--out -` pipes cleanly into anything.
    console.error(target ? `Saved ${messages} to ${target}` : `Exported ${messages}`);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Dispatch `dorkos room <subcommand>`.
 *
 * @param rawArgs - Argv after `room`.
 * @returns The intended process exit code.
 */
export async function runRoomDispatcher(rawArgs: string[]): Promise<number> {
  const subcommand = rawArgs[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(ROOM_USAGE);
    return subcommand === undefined ? 1 : 0;
  }

  if (subcommand === 'export') {
    const rest = rawArgs.slice(1);
    if (rest[0] === '--help' || rest[0] === '-h') {
      console.log(ROOM_USAGE);
      return 0;
    }
    try {
      return await runRoomExport(parseRoomExportArgs(rest));
    } catch (err) {
      printError(err);
      return 1;
    }
  }

  console.error(`Unknown room subcommand: ${subcommand}`);
  console.error(ROOM_USAGE);
  return 1;
}

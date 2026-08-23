/**
 * Tests for `dorkos room export` (`commands/room.ts`).
 *
 * The api-client is mocked; everything downstream of it is real, including the
 * file that lands on disk — the whole point of the command is that a room
 * becomes a file, and a test that stubbed the write would prove nothing about
 * it. Files go under `os.tmpdir()`, never near a dork home.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: string }
    ) {
      super(body.error ?? `HTTP ${status}`);
    }
  }
  return { ApiError, apiCall: vi.fn(), apiRequest: vi.fn() };
});

import { apiCall, apiRequest } from '../../lib/api-client.js';
import { parseRoomExportArgs, runRoomExport, runRoomDispatcher } from '../room.js';

const apiCallMock = vi.mocked(apiCall);
const apiRequestMock = vi.mocked(apiRequest);

const ROOM_ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

/** The three lines a small, complete export is made of. */
const WHOLE_EXPORT = [
  JSON.stringify({
    type: 'room-export',
    format: 'dorkos.room-export',
    version: 1,
    room: { id: ROOM_ID, slug: 'backend' },
  }),
  JSON.stringify({ type: 'entry', seq: 1, text: 'first' }),
  JSON.stringify({ type: 'summary', entryCount: 1, firstSeq: 1, lastSeq: 1 }),
].join('\n');

let workDir: string;

/** Stand in for the export response, with a body streamed exactly as fetch does. */
function exportResponse(body: string, filename = 'room-backend-2026-08-15.jsonl'): Response {
  return {
    headers: new Headers({ 'content-disposition': `attachment; filename="${filename}"` }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks, split mid-line on purpose: the receipt check has to
        // survive a body that does not arrive line-aligned.
        const bytes = new TextEncoder().encode(body);
        const cut = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    }),
  } as unknown as Response;
}

/**
 * A response whose body dies part-way, the way a dropped connection does.
 *
 * `TypeError: terminated` is verbatim what undici raises when the socket goes
 * away mid-body, which is the error the friendly message has to replace.
 */
function droppedResponse(prefix: string): Response {
  return {
    headers: new Headers({ 'content-disposition': 'attachment; filename="room-backend.jsonl"' }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(prefix));
        controller.error(new TypeError('terminated'));
      },
    }),
  } as unknown as Response;
}

/** Everything in the work directory, so a leftover staging directory is visible. */
function workDirEntries(): string[] {
  return fs.readdirSync(workDir).sort();
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-room-export-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('parseRoomExportArgs', () => {
  it('takes the room and its options', () => {
    expect(parseRoomExportArgs(['#backend', '--out', 'x.jsonl', '--force'])).toEqual({
      room: '#backend',
      out: 'x.jsonl',
      force: true,
    });
  });

  it('needs a room', () => {
    expect(() => parseRoomExportArgs([])).toThrow(/Name the room/);
  });

  it('refuses two rooms at once', () => {
    expect(() => parseRoomExportArgs(['a', 'b'])).toThrow(/one room at a time/);
  });

  it('names an option it does not know', () => {
    expect(() => parseRoomExportArgs(['#backend', '--everything'])).toThrow(/--everything/);
  });
});

describe('runRoomExport', () => {
  it('writes the export to a file and reports what it saved', async () => {
    apiRequestMock.mockResolvedValue(exportResponse(WHOLE_EXPORT));
    const out = path.join(workDir, 'backend.jsonl');

    const code = await runRoomExport({ room: ROOM_ID, out, force: false });

    expect(code).toBe(0);
    expect(fs.readFileSync(out, 'utf-8')).toBe(WHOLE_EXPORT);
    // A room id goes straight to the export call: there is nothing to look up.
    expect(apiCallMock).not.toHaveBeenCalled();
    expect(apiRequestMock).toHaveBeenCalledWith('GET', `/api/rooms/${ROOM_ID}/export`);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('Saved 1 message');
  });

  it('looks a channel up by name, with or without the #', async () => {
    apiCallMock.mockResolvedValue({
      rooms: [
        { id: 'other', slug: 'frontend', title: 'Frontend' },
        { id: ROOM_ID, slug: 'backend', title: 'Backend' },
      ],
    });
    apiRequestMock.mockResolvedValue(exportResponse(WHOLE_EXPORT));

    const code = await runRoomExport({
      room: '#Backend',
      out: path.join(workDir, 'a.jsonl'),
      force: false,
    });

    expect(code).toBe(0);
    expect(apiRequestMock).toHaveBeenCalledWith('GET', `/api/rooms/${ROOM_ID}/export`);
  });

  it('says so when no room goes by that name', async () => {
    apiCallMock.mockResolvedValue({
      rooms: [{ id: 'other', slug: 'frontend', title: 'Frontend' }],
    });

    const code = await runRoomExport({ room: '#backend', force: false });

    expect(code).toBe(1);
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  it('uses the name the server suggested when no --out is given', async () => {
    apiRequestMock.mockResolvedValue(exportResponse(WHOLE_EXPORT, 'room-backend-2026-08-15.jsonl'));
    const cwd = process.cwd();
    process.chdir(workDir);
    try {
      const code = await runRoomExport({ room: ROOM_ID, force: false });
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(workDir, 'room-backend-2026-08-15.jsonl'))).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it('writes to standard output on --out -, leaving it open to report afterwards', async () => {
    apiRequestMock.mockResolvedValue(exportResponse(WHOLE_EXPORT));
    const written: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return true;
      });
    const end = vi.spyOn(process.stdout, 'end').mockImplementation(() => process.stdout);

    const code = await runRoomExport({ room: ROOM_ID, out: '-', force: false });

    expect(code).toBe(0);
    expect(written.join('')).toBe(WHOLE_EXPORT);
    // Standard output belongs to the shell, not to this command: closing it
    // would take the pipe down with the report that follows.
    expect(end).not.toHaveBeenCalled();
    write.mockRestore();
    end.mockRestore();
  });

  it('refuses to overwrite an existing file unless told to', async () => {
    const out = path.join(workDir, 'backend.jsonl');
    fs.writeFileSync(out, 'last month');
    apiRequestMock.mockResolvedValue(exportResponse(WHOLE_EXPORT));

    expect(await runRoomExport({ room: ROOM_ID, out, force: false })).toBe(1);
    expect(fs.readFileSync(out, 'utf-8')).toBe('last month');

    apiRequestMock.mockResolvedValue(exportResponse(WHOLE_EXPORT));
    expect(await runRoomExport({ room: ROOM_ID, out, force: true })).toBe(0);
    expect(fs.readFileSync(out, 'utf-8')).toBe(WHOLE_EXPORT);
  });

  it('reports a truncated download as a failure, and writes no file at all', async () => {
    // The same export with its receipt cut off — which is exactly what a body
    // that ended early leaves behind.
    const truncated = WHOLE_EXPORT.split('\n').slice(0, 2).join('\n');
    apiRequestMock.mockResolvedValue(exportResponse(truncated));
    const out = path.join(workDir, 'backend.jsonl');

    const code = await runRoomExport({ room: ROOM_ID, out, force: false });

    expect(code).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('not complete');
    // All-or-nothing: an export with no receipt cannot be read as one, so
    // leaving the fragment behind would only be a trap for whoever found it.
    expect(fs.existsSync(out)).toBe(false);
    expect(workDirEntries(), 'no staging directory survives').toEqual([]);
  });

  it('leaves a previous export untouched when the download dies mid-stream', async () => {
    // The reviewer's reproduction, and the reason this command stages: --force
    // is exactly what somebody retrying a failed export reaches for, and the
    // retry must not be able to destroy the copy they already had.
    const out = path.join(workDir, 'backend.jsonl');
    const lastMonth = `${WHOLE_EXPORT}\n`;
    fs.writeFileSync(out, lastMonth);
    apiRequestMock.mockResolvedValue(droppedResponse('{"type":"room-export"'));

    const code = await runRoomExport({ room: ROOM_ID, out, force: true });

    expect(code).toBe(1);
    expect(fs.readFileSync(out, 'utf-8'), 'the month-old export survives').toBe(lastMonth);
    expect(workDirEntries()).toEqual(['backend.jsonl']);

    const said = vi.mocked(console.error).mock.calls.flat().join(' ');
    // The bare `Error: terminated` a rejected pipeline produces is never what a
    // person is shown about their own history — but the cause is still named.
    expect(said).toContain('stopped before it finished');
    expect(said).toContain('exactly as it was');
    expect(said).toContain('Reason: terminated');
  });

  it('clears the staging directory only once the dead download has let go of the file', async () => {
    // The mechanism behind a leftover `.dorkos-export-*`, pinned at its cause.
    // A body that dies rejects the pipeline while the scratch file's `open` is
    // still running on the threadpool: measured over 100 dropped downloads, the
    // stream had closed 0 times by the time the old cleanup ran, and the file
    // it goes on to create lands inside `rmSync`'s walk-then-remove window
    // often enough (~5% of runs) to fail the removal with ENOTEMPTY and strand
    // the directory. Waiting for the close is what makes that unraceable, so
    // that — not the leftover, which only shows up on the unlucky runs — is
    // what this asserts.
    const out = path.join(workDir, 'backend.jsonl');
    fs.writeFileSync(out, `${WHOLE_EXPORT}\n`);
    apiRequestMock.mockResolvedValue(droppedResponse('{"type":"room-export"'));

    // Both spies delegate to the real thing: they observe the order the command
    // does its work in, they do not change it.
    const createWriteStream = fs.createWriteStream.bind(fs);
    let scratch: fs.WriteStream | undefined;
    vi.spyOn(fs, 'createWriteStream').mockImplementation(((
      ...args: Parameters<typeof fs.createWriteStream>
    ) => {
      scratch = createWriteStream(...args);
      return scratch;
    }) as typeof fs.createWriteStream);

    const rmSync = fs.rmSync.bind(fs);
    const closedWhenCleared: (boolean | undefined)[] = [];
    vi.spyOn(fs, 'rmSync').mockImplementation(((...args: Parameters<typeof fs.rmSync>) => {
      closedWhenCleared.push(scratch?.closed);
      return rmSync(...args);
    }) as typeof fs.rmSync);

    expect(await runRoomExport({ room: ROOM_ID, out, force: true })).toBe(1);

    expect(closedWhenCleared, 'cleaned up once, with nothing still in flight').toEqual([true]);
    expect(workDirEntries()).toEqual(['backend.jsonl']);
  });

  it('does not claim success when the write fails after the last line arrived', async () => {
    // A receipt that reached this process is not a receipt that reached the
    // disk. Without the `reason === null` guard the outcome below reads as a
    // complete export and the rename fires on a half-written file.
    apiRequestMock.mockResolvedValue(exportResponse(WHOLE_EXPORT));
    const out = path.join(workDir, 'backend.jsonl');
    const failing = vi.spyOn(fs, 'createWriteStream').mockImplementation(
      () =>
        new Writable({
          write(_chunk, _encoding, done) {
            done(new Error('ENOSPC: no space left on device'));
          },
        }) as unknown as fs.WriteStream
    );

    const code = await runRoomExport({ room: ROOM_ID, out, force: false });

    expect(code).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('ENOSPC');
    failing.mockRestore();
  });
});

describe('runRoomDispatcher', () => {
  it('prints usage and fails when given no subcommand', async () => {
    expect(await runRoomDispatcher([])).toBe(1);
  });

  it('prints usage and succeeds on --help', async () => {
    expect(await runRoomDispatcher(['--help'])).toBe(0);
  });

  it('names a subcommand it does not know', async () => {
    expect(await runRoomDispatcher(['archive'])).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toContain('archive');
  });
});

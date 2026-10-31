/**
 * The durable record of every chat whose warm process is holding background
 * work right now, so a process that ends anyway can be followed by a turn
 * (DOR-2065).
 *
 * ## The promise this keeps
 *
 * Under the bare Claude Code CLI, a background shell, Monitor or helper agent
 * that finishes after the turn ended wakes the chat with a new turn. Under
 * DorkOS the warm process keeps that promise while it lives (`process-quiet.ts`
 * holds it for the work). But a process can still be ended with the work
 * inside it: the server restarts, gracefully or by a hard kill; the four-hour
 * ceiling takes it back; the session record is evicted; the CLI crashes. The
 * work dies with the process, and the wake it would have brought never comes.
 *
 * Relaunching the CLI with `--resume` is not enough on its own. Measured on CLI
 * 2.1.289: the relaunched CLI writes its own "background command didn't finish
 * before the previous session ended" notice into the transcript and answers
 * `result/success` with `num_turns: 0` — the model never runs. So DorkOS has to
 * start the turn itself, and the CLI's notice then rides that turn and gives
 * the agent the detail.
 *
 * ## Why a file, and when it is written
 *
 * A hard kill runs no exit handler, so the record has to exist BEFORE the kill:
 * it is written the moment a process starts holding work, and removed the
 * moment it stops (the work finished and its report was delivered). Writes
 * happen only on those two flips, never per frame. A graceful shutdown leaves
 * the record in place. The next boot reads every record left behind and
 * removes each one only once its chat is settled, so a boot that dies midway
 * wakes the rest next time.
 *
 * Only the server going away wakes a chat. Every ending the running server
 * sees for itself — the ceiling, an eviction, a crash, a Stop — clears the
 * record instead (`services/session/runtime-turns/wake-cut-short-work.ts`
 * says why).
 *
 * Lives beside `warm-processes.json` (`sessions/warm-process-ledger.ts`) under
 * the same data directory, and writes the same way: synchronously and
 * atomically, so the kill it exists to survive cannot leave half a file.
 *
 * ## Bound to the data directory that wrote it
 *
 * The file names chats by transcript id, and transcripts live in the shared
 * `~/.claude*` folders, not in the data directory. So a COPY of a data directory
 * booted elsewhere would wake the original install's live chats and run their
 * tools (DOR-3071). The file therefore records the data directory it was
 * written in, and a boot from any other path wakes nothing and says so once. A
 * file from before the binding (0.127.x and earlier) carries no path and still
 * wakes, so an upgrade does not lose the work it was holding.
 *
 * @module services/runtimes/claude-code/messaging/background-work-ledger
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';

/** Where the record lives, relative to `dorkHome`. */
const LEDGER_RELATIVE_PATH = path.join('cache', 'runtimes', 'claude-code', 'background-work.json');

/** One chat whose warm process is holding background work. */
const BackgroundWorkRecordSchema = z.object({
  /** The key this session's pump is filed under in this server. */
  key: z.string().min(1),
  /**
   * The id to wake the chat under: its transcript id, which is the one a
   * restarted server can still find.
   */
  sessionId: z.string().min(1),
  /** The directory the chat runs in, so the wake starts in the right place. */
  cwd: z.string().min(1),
  /** When the process started holding the work, as epoch ms. */
  since: z.number(),
});

const BackgroundWorkFileSchema = z.object({
  /**
   * The data directory that wrote the file, resolved. Absent in files written
   * before DOR-3071, which are trusted as this directory's own.
   */
  dorkHome: z.string().min(1).optional(),
  sessions: z.array(BackgroundWorkRecordSchema),
});

/**
 * A data directory as a comparable path: symlinks resolved, so the same
 * directory reached two ways still matches itself.
 *
 * @param dorkHome - The data directory as given
 */
function resolveHome(dorkHome: string): string {
  try {
    return fs.realpathSync(dorkHome);
  } catch {
    return path.resolve(dorkHome);
  }
}

/** One chat whose warm process is holding background work. */
export type BackgroundWorkRecord = z.infer<typeof BackgroundWorkRecordSchema>;

/**
 * The chats holding background work in one data directory.
 *
 * Never throws: a record that cannot be written costs a wake after a restart,
 * which is the bug as it already was, and must never take a warm process or a
 * boot down with it.
 */
export class BackgroundWorkLedger {
  private readonly filePath: string;
  private readonly home: string;

  /**
   * Build a ledger over one data directory.
   *
   * @param dorkHome - The data directory whose chats this tracks
   */
  constructor(dorkHome: string) {
    this.filePath = path.join(dorkHome, LEDGER_RELATIVE_PATH);
    this.home = resolveHome(dorkHome);
  }

  /** Where this ledger is stored. */
  get path(): string {
    return this.filePath;
  }

  /**
   * Write down that a chat's process has started holding background work.
   * Replaces any earlier record for the same key.
   *
   * @param record - The chat, where it runs, and since when
   */
  hold(record: BackgroundWorkRecord): void {
    const sessions = this.read().filter((entry) => entry.key !== record.key);
    sessions.push(record);
    this.write(sessions);
  }

  /**
   * Forget a chat's record: its work finished, or its process ended in a way
   * that must not wake it.
   *
   * @param key - The key the record was held under
   * @param since - When given, remove the record only if it is that one, so a
   *   boot settling a previous run's record cannot remove the record this run
   *   has written for the same chat since
   * @returns The record that was removed, or undefined when there was none
   */
  release(key: string, since?: number): BackgroundWorkRecord | undefined {
    const sessions = this.read();
    const found = sessions.find(
      (entry) => entry.key === key && (since === undefined || entry.since === since)
    );
    if (found === undefined) return undefined;
    this.write(sessions.filter((entry) => entry !== found));
    return found;
  }

  /**
   * Every record as it stands. Unreadable reads as empty, and so does a file
   * another data directory wrote.
   */
  read(): BackgroundWorkRecord[] {
    const file = this.readFile();
    return file === null || this.isForeign(file) ? [] : file.sessions;
  }

  /**
   * The records a previous run of THIS data directory left, for the boot to
   * wake. A file another data directory wrote — this one is a copy, or was
   * moved — wakes nothing: it is removed with one log line, because the chats
   * it names belong to the install that wrote it.
   */
  readLeftover(): BackgroundWorkRecord[] {
    const file = this.readFile();
    if (file === null) return [];
    if (!this.isForeign(file)) return file.sessions;
    logger.warn(
      '[background-work-ledger] written by another data directory; waking none of its chats',
      { writtenBy: file.dorkHome, dorkHome: this.home, sessions: file.sessions.length }
    );
    this.write([]);
    return [];
  }

  /** Whether the file was written by a data directory other than this one. */
  private isForeign(file: z.infer<typeof BackgroundWorkFileSchema>): boolean {
    return file.dorkHome !== undefined && file.dorkHome !== this.home;
  }

  /** The file as it sits on disk, or null when absent or unreadable. */
  private readFile(): z.infer<typeof BackgroundWorkFileSchema> | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = BackgroundWorkFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      // Truncated by a kill mid-write that the rename did not cover, or edited
      // by hand. Nothing in it can be trusted to name a chat.
      return null;
    }
  }

  /** Persist the records atomically, removing the file when there are none. */
  private write(sessions: BackgroundWorkRecord[]): void {
    if (sessions.length === 0) {
      try {
        fs.rmSync(this.filePath, { force: true });
      } catch {
        // A stale record only costs one extra wake after a restart.
      }
      return;
    }
    const temp = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ dorkHome: this.home, sessions }, null, 2));
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      logger.warn('[background-work-ledger] could not write the record', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // Nothing further to try; the stray temp file is inert.
      }
    }
  }
}

/** This data directory's ledger, built on first use. */
let shared: BackgroundWorkLedger | undefined;

/**
 * The one ledger this server writes to.
 *
 * A module-level singleton for the reason `sharedWarmProcessLedger` is one: its
 * writer sits deep inside the warm-process wiring and its reader at the top of
 * boot, and the single-instance lock already makes one per data directory.
 */
export function sharedBackgroundWorkLedger(): BackgroundWorkLedger {
  shared ??= new BackgroundWorkLedger(resolveDorkHome());
  return shared;
}

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
 * happen only on those two flips, never per frame. The next boot takes every
 * record left behind ({@link BackgroundWorkLedger.takeAll}) and wakes each
 * chat once.
 *
 * Lives beside `warm-processes.json` (`sessions/warm-process-ledger.ts`) under
 * the same data directory, and writes the same way: synchronously and
 * atomically, so the kill it exists to survive cannot leave half a file.
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
  sessions: z.array(BackgroundWorkRecordSchema),
});

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

  /**
   * Build a ledger over one data directory.
   *
   * @param dorkHome - The data directory whose chats this tracks
   */
  constructor(dorkHome: string) {
    this.filePath = path.join(dorkHome, LEDGER_RELATIVE_PATH);
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
   * @returns The record that was removed, or undefined when there was none
   */
  release(key: string): BackgroundWorkRecord | undefined {
    const sessions = this.read();
    const found = sessions.find((entry) => entry.key === key);
    if (found === undefined) return undefined;
    this.write(sessions.filter((entry) => entry !== found));
    return found;
  }

  /** Every record as it stands. Unreadable reads as empty. */
  read(): BackgroundWorkRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = BackgroundWorkFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.sessions : [];
    } catch {
      // Truncated by a kill mid-write that the rename did not cover, or edited
      // by hand. Nothing in it can be trusted to name a chat.
      return [];
    }
  }

  /**
   * Take every record a previous run left behind and clear the file, so each
   * one wakes its chat at most once even if the boot that took it dies too.
   *
   * Call once at boot, before anything can warm a process in this run.
   */
  takeAll(): BackgroundWorkRecord[] {
    const sessions = this.read();
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch (error) {
      logger.warn('[background-work-ledger] could not clear the record', {
        path: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return sessions;
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
      fs.writeFileSync(temp, JSON.stringify({ sessions }, null, 2));
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

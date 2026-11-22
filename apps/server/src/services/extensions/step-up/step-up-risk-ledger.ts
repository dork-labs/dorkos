/**
 * When a risky mini app last cleared, so a browser that loaded it stays
 * refused (Security's M1 on #3401, DOR-3234).
 *
 * A mini app an agent can rewrite runs in the app's own page. Once its risk
 * clears (the folder is deleted, the person moves it out or turns it off), the
 * page that already loaded it never reloads by itself, so its code can still be
 * there, hooking `fetch` or the DOM, when the next web step-up shows the
 * password field. The server cannot see a page's code, so it judges by time:
 * a browser session that started before the risk cleared may hold that page,
 * and its web step-up is refused until the person signs in again.
 *
 * The ledger is written to disk on each change, so a restart does not forget a
 * risk that cleared while a tab stayed open. A ledger that cannot be read fails
 * closed: it counts as a risk still present, until the next reading with none.
 *
 * The bundle route takes a reading before it serves a mini app's code, and
 * serves nothing when that reading could not be kept (DOR-4906): only then
 * may a held mini app, whose code is never served, be left out of the list.
 * A ledger from before serve-time readings (no `servedSince`) cannot vouch
 * for tabs opened then, so opening one counts as a clear at that moment.
 *
 * @module services/extensions/step-up/step-up-risk-ledger
 */
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { logger } from '../../../lib/logger.js';

const LedgerFileSchema = z.object({
  /** Whether the last reading found a risk. */
  present: z.boolean(),
  /** When a reading first found none after one with a risk, in ms; null when never. */
  clearedAt: z.number().nullable(),
  /** Since when every served bundle took a reading first, in ms (DOR-4906). */
  servedSince: z.number().optional(),
});

type LedgerState = z.infer<typeof LedgerFileSchema>;

const NEVER: LedgerState = { present: false, clearedAt: null };

/** Whether a mini app risk was present, and when it last cleared. */
export class StepUpRiskLedger {
  private state: LedgerState;
  /** Whether {@link state} is what the file holds; false after a failed read or write. */
  private onDisk: boolean;

  /**
   * Open the ledger, reading what it last kept.
   *
   * @param file - Where to keep it; in memory only when absent.
   * @param now - The opening's time, in ms.
   */
  constructor(
    private readonly file?: string,
    now: number = Date.now()
  ) {
    const read = file ? readLedger(file) : { state: NEVER, onDisk: true };
    this.state = read.state;
    this.onDisk = read.onDisk;
    // Tabs opened before readings were taken at serve time may hold code no
    // reading saw: browsers signed in before now confirm only after signing in again.
    if (file && this.state.servedSince === undefined) {
      this.save({ ...this.state, clearedAt: now, servedSince: now });
    }
  }

  /**
   * Record one reading of the loaded mini apps' risks.
   *
   * @param riskCount - How many risks the reading found.
   * @param now - The reading's time, in ms.
   * @returns Whether the file now holds this reading (always true in memory).
   */
  note(riskCount: number, now: number = Date.now()): boolean {
    let next = this.state;
    if (riskCount > 0 && !next.present) next = { ...next, present: true };
    if (riskCount === 0 && next.present) next = { ...next, present: false, clearedAt: now };
    if (next === this.state && this.onDisk) return true;
    return this.save(next);
  }

  /**
   * Whether a browser session that started at `startedAt` may still hold a
   * risky mini app's code: a risk is present, or one cleared after it started.
   *
   * @param startedAt - When the session started, in ms; null when unknown.
   */
  mayHoldRiskyCode(startedAt: number | null): boolean {
    if (this.state.present) return true;
    if (this.state.clearedAt === null) return false;
    return startedAt === null || startedAt <= this.state.clearedAt;
  }

  /** Keep `next`, in memory first; whether it reached the disk too. */
  private save(next: LedgerState): boolean {
    this.state = next;
    this.onDisk = this.writeFile(next);
    return this.onDisk;
  }

  /** Write `next` atomically; whether it landed. Always true in memory. */
  private writeFile(next: LedgerState): boolean {
    if (!this.file) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temp, this.file);
      return true;
    } catch (error) {
      logger.warn('[StepUp] Could not save the mini app risk ledger', {
        error: (error as Error).name,
      });
      return false;
    }
  }
}

/** The ledger on disk; none yet is a clean ledger, an unreadable one fails closed. */
function readLedger(file: string): { state: LedgerState; onDisk: boolean } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: NEVER, onDisk: true };
    return { state: { present: true, clearedAt: null }, onDisk: false };
  }
  try {
    const parsed = LedgerFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return { state: parsed.data, onDisk: true };
  } catch {
    // Unreadable JSON: fail closed below.
  }
  logger.warn(
    '[StepUp] The mini app risk ledger is unreadable; web step-up waits for a clean reading'
  );
  return { state: { present: true, clearedAt: null }, onDisk: false };
}

let live = new StepUpRiskLedger();

/**
 * The running server's ledger.
 */
export function stepUpRiskLedger(): StepUpRiskLedger {
  return live;
}

/**
 * Keep the running server's ledger in a file under the data folder. Called once at startup.
 *
 * @param file - The ledger's path; a fresh in-memory ledger when absent.
 */
export function useStepUpRiskLedgerFile(file?: string): void {
  live = new StepUpRiskLedger(file);
}

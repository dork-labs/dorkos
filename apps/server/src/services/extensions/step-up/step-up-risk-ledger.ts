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
});

type LedgerState = z.infer<typeof LedgerFileSchema>;

const NEVER: LedgerState = { present: false, clearedAt: null };

/** Whether a mini app risk was present, and when it last cleared. */
export class StepUpRiskLedger {
  private state: LedgerState;

  /**
   * Open the ledger, reading what it last kept.
   *
   * @param file - Where to keep it; in memory only when absent.
   */
  constructor(private readonly file?: string) {
    this.state = file ? readLedger(file) : NEVER;
  }

  /**
   * Record one reading of the loaded mini apps' risks.
   *
   * @param riskCount - How many risks the reading found.
   * @param now - The reading's time, in ms.
   */
  note(riskCount: number, now: number = Date.now()): void {
    if (riskCount > 0) {
      if (!this.state.present) this.save({ present: true, clearedAt: this.state.clearedAt });
      return;
    }
    if (this.state.present) this.save({ present: false, clearedAt: now });
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

  private save(next: LedgerState): void {
    this.state = next;
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn('[StepUp] Could not save the mini app risk ledger', {
        error: (error as Error).name,
      });
    }
  }
}

/** The ledger on disk; none yet is a clean ledger, an unreadable one fails closed. */
function readLedger(file: string): LedgerState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NEVER;
    return { present: true, clearedAt: null };
  }
  try {
    const parsed = LedgerFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Unreadable JSON: fail closed below.
  }
  logger.warn(
    '[StepUp] The mini app risk ledger is unreadable; web step-up waits for a clean reading'
  );
  return { present: true, clearedAt: null };
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
 * @param file - The ledger's path.
 */
export function useStepUpRiskLedgerFile(file: string): void {
  live = new StepUpRiskLedger(file);
}

/**
 * What every runtime's hold on a heavy shell job shares (DOR-4209): the words the chat shows while
 * a job waits, the status event that carries them, and a wait that never throws.
 *
 * Claude Code holds a job in a `PreToolUse` hook, Codex at the ask Codex sends before it runs a
 * command, OpenCode at its `bash` permission ask. Each then hands the call to its own normal
 * decision, whatever the wait's ending; this module only waits. The words are counts only: a job's
 * place in line, never what is ahead of it. The wait fails open: when the gate breaks, the job goes
 * on to its runtime's normal decision, and the log names the error's class alone, never a command or
 * an error message, either of which can carry a path.
 *
 * @module services/core/load-gate/runtime-wait
 */
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { classifyCommand } from './heavy-classifier.js';
import {
  errorName,
  hardCapMs,
  isAbortError,
  type HeldSlot,
  type JobOwner,
  type LoadGate,
  type WaitStatus,
} from './load-gate.js';
import { loadGateSettings, machineLoadGate } from './machine-load-gate.js';

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, `21st`: English ordinals, where 11 to 13 take `th`. */
function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** A rough time left, as a person reads it: `40m`, `3h`. */
function roughly(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MS_PER_MINUTE));
  return minutes < MINUTES_PER_HOUR ? `${minutes}m` : `${Math.round(minutes / MINUTES_PER_HOUR)}h`;
}

/**
 * What the chat says while a heavy job waits. Its place in line and nothing about the jobs ahead.
 *
 * @param status - How the wait is going, as the gate reports it.
 * @param capMs - When the job runs anyway, or `undefined` when the settings cannot be read.
 */
export function loadWaitMessage(status: WaitStatus, capMs: number | undefined): string {
  const place = status.position <= 1 ? 'Next in line' : `${ordinal(status.position)} in line`;
  if (!status.pastMaxWait) return `Waiting for the computer to calm down. ${place}.`;
  const runsAnyway =
    capMs === undefined ? '' : ` It runs anyway in about ${roughly(capMs - status.waitedMs)}.`;
  return `Still waiting for the computer. ${place}.${runsAnyway}`;
}

/**
 * The chat's status line for a waiting job. The app shows the newest one in place of the last, and
 * clears it at the turn's next event.
 *
 * @param status - How the wait is going, as the gate reports it.
 * @param settings - The settings in force, or `null` when they cannot be read.
 */
export function loadWaitEvent(status: WaitStatus, settings: LoadGateSettings | null): StreamEvent {
  const message = loadWaitMessage(status, settings ? hardCapMs(settings) : undefined);
  return { type: 'system_status', data: { message, status: LOAD_WAIT_STATUS } };
}

/**
 * What the chat says while a new reply waits for the computer to calm down before it starts
 * (DOR-4743). It is not in the line, so it has no place to tell, and it starts anyway at
 * `maxWaitMinutes`, so there is no "still waiting" to say either.
 */
const LOAD_START_WAIT_MESSAGE = 'Waiting for the computer to calm down before starting.';

/**
 * The chat's status line while a new reply waits to start: the same `waiting_for_load` status a
 * waiting job sends, so the app shows and clears it the same way.
 */
export function loadStartWaitEvent(): StreamEvent {
  return {
    type: 'system_status',
    data: { message: LOAD_START_WAIT_MESSAGE, status: LOAD_WAIT_STATUS },
  };
}

/**
 * Read the load-gate settings, or `null` when they cannot be read (the config not loaded yet).
 *
 * @param settings - The settings getter.
 */
export function readSettingsOrNull(settings: () => LoadGateSettings): LoadGateSettings | null {
  try {
    return settings();
  } catch {
    return null;
  }
}

/** What a runtime's hold uses, each replaceable in tests. */
export interface RuntimeWaitDeps {
  /** The gate; the server's own by default. */
  gate?: () => LoadGate;
  /** The `runtimes.loadGate` settings, for the wait's words; the live config by default. */
  settings?: () => LoadGateSettings;
  /** Where the hold's few lines go. None carries command text. */
  log?: { warn(message: string, data: Record<string, unknown>): void };
}

/**
 * Whether the gate would hold `command` now: the gate is on and the classifier calls it heavy, by
 * the same reading the gate itself makes. Lets a runtime hand a light command to its normal
 * decision at once, exactly as before the gate existed.
 *
 * @param command - The shell command line.
 * @param deps - The settings, for tests.
 */
export function wouldHold(command: string, deps: RuntimeWaitDeps = {}): boolean {
  const settings = readSettingsOrNull(deps.settings ?? loadGateSettings);
  if (settings?.enabled === false) return false;
  const classification = classifyCommand(command, settings?.heavyCommands);
  return classification.heavy && classification.reason !== undefined;
}

/** One heavy-job wait a runtime asks for. */
export interface HeavyTurnRequest {
  /** The shell command line, classified by the gate and never logged or shown. */
  command: string;
  /** Who the job is for, for the person's own list of waiting jobs only. */
  owner: JobOwner;
  /**
   * The agent thread the job belongs to (`<runtime>:<chat>:<thread>`): calls with the same key
   * share one place in line and one slot (`chat-turns.ts`), so a thread never waits behind itself.
   */
  shareKey?: string;
  /** Stops the wait: the ticket leaves the line. */
  signal?: AbortSignal;
  /** Hears the chat's status line: once when the wait starts, then about every minute. */
  notify: (event: StreamEvent) => void;
}

/**
 * Wait for a heavy shell command's turn. Never throws: a stop, a gate failure and a light command
 * all come back as `null`, and the caller's normal decision runs next either way.
 *
 * @param request - The command, who it is for, what stops it and where its words go.
 * @param deps - The gate, the settings and the log, for tests.
 * @returns The slot (with a share key, this call's share of it) to give back when the command
 *   ends, or `null` when there is nothing to give
 *   back: the command is light, the gate is off, the wait was stopped, or the gate broke.
 */
export async function waitForHeavyTurn(
  request: HeavyTurnRequest,
  deps: RuntimeWaitDeps = {}
): Promise<HeldSlot | null> {
  const gate = deps.gate ?? machineLoadGate;
  const settings = deps.settings ?? loadGateSettings;
  const log = deps.log ?? logger;
  try {
    // The gate classifies with the shell guard's own parser, and logs a hard-cap run and a
    // let-through itself, by program name.
    const owner = request.shareKey
      ? { ...request.owner, shareKey: request.shareKey }
      : request.owner;
    return await gate().gateIfHeavy(request.command, owner, {
      ...(request.signal ? { signal: request.signal } : {}),
      onWait: (status) => request.notify(loadWaitEvent(status, readSettingsOrNull(settings))),
    });
  } catch (error) {
    if (!isAbortError(error)) {
      log.warn('[LoadGate] the wait broke; the command goes on', { error: errorName(error) });
    }
    return null;
  }
}

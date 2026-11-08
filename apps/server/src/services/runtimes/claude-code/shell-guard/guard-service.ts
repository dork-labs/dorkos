/**
 * The server's one shell guard: its host, what the person is told when it can't start, and their
 * choice to go on without it (DOR-3300).
 *
 * **Going on without the check is a person's, for this run only.** It lives in this module's memory
 * and in no file, so a restart ends it and nothing an agent can write brings it back. The only way
 * to set it is the person-only route (`routes/system-shell-check.ts`), and only once a restart has
 * already been tried: an open row from an earlier run is how this knows one was.
 *
 * @module services/runtimes/claude-code/shell-guard/guard-service
 */
import type { ShellCheckStatus } from '@dorkos/shared/notification-schemas';
import { logger } from '../../../../lib/logger.js';
import { armEscalation } from '../../../notifications/escalation-service.js';
import {
  notify,
  resolveStanding,
  unresolvedStanding,
} from '../../../notifications/notification-service.js';
import { resolveGuardChild } from './guard-child-file.js';
import { GuardHost } from './guard-host.js';

/** One host for the server: children are shared by every launch. */
let host: GuardHost | undefined;
/** The episode the person has been told about, while it lasts. */
let down: { since: string; full: boolean } | null = null;
/** Whether an earlier run left this episode open, so a restart didn't help. */
let afterRestart = false;
/** Whether a person chose to go on at Full. */
let continuing = false;

/** When the notice an earlier run left open was raised, if one was. */
function earlierEpisode(): string | undefined {
  try {
    return unresolvedStanding('shell.check_down')[0]?.createdAt;
  } catch (err) {
    logger.warn('[ShellGuard] could not read earlier notices', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return undefined;
  }
}

/** Tell the person, on the row and on the phone: the row is what they find later. */
function sayCheckDown({ full }: { full: boolean }): void {
  afterRestart = earlierEpisode() !== undefined;
  down = { since: new Date().toISOString(), full };
  void notify('shell.check_down', down);
  armEscalation('shell.check_down', down);
}

/** A check worked: close this run's notice, or one a restart left open, and any choice to go on. */
function sayCheckBack(): void {
  continuing = false;
  afterRestart = false;
  const since = down ? undefined : earlierEpisode();
  const ended = down ?? (since ? { since, full: false } : null);
  down = null;
  if (!ended) return;
  void resolveStanding(
    'shell.check_down',
    { ...ended, clearedAt: new Date().toISOString() },
    { outcome: 'cleared' }
  );
}

/** The server's guard host, made on first use. */
export function guardHost(): GuardHost {
  host ??= new GuardHost({
    childFile: resolveGuardChild,
    onUnavailable: sayCheckDown,
    onRecovered: sayCheckBack,
    log: logger,
  });
  return host;
}

/** What the app shows about the check. */
export function shellCheckStatus(): ShellCheckStatus {
  return {
    down: down !== null,
    full: down?.full ?? false,
    canContinue: down !== null && afterRestart,
    continuing,
  };
}

/** Whether a person chose to go on without the check, until restart. */
export function goingOnWithoutCheck(): boolean {
  return continuing;
}

/**
 * Go on at Full without the check, until restart. For the person-only route alone.
 *
 * @returns Whether it took: not unless the check is down and a restart was already tried.
 */
export function continueWithoutCheck(): boolean {
  if (!shellCheckStatus().canContinue) return false;
  continuing = true;
  return true;
}

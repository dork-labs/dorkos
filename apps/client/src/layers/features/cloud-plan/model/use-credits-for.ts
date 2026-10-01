/**
 * "Use credits for" — whether each runtime's turns run on DorkOS credits, as a
 * VIEW onto that runtime's own default sign-in.
 *
 * **It holds no state of its own, on purpose.** Who pays for a turn is decided
 * where each runtime already decides it — its machine-default sign-in — and a
 * second switch stored here would be a second answer to that question, free to
 * disagree with the first. So every row reads the runtime's answer and, when it
 * writes, writes the runtime's default and nothing else.
 *
 * **What this build can reach.** Credits are still one process-wide choice here:
 * the server holds one inference token, and while it does, every runtime it is
 * wired for runs on it (`GET /api/cloud/credits`). That is the machine default
 * this reads, and turning it on asks the server for the token. The token is
 * held in memory and expires, so credits also stop on their own when it runs
 * out, and the credits read re-asks while they are on so the switch follows.
 * There is no way to put a runtime back on its own sign-in short of a
 * restart, an unlink or that expiry, so a row says so rather than offering an
 * "off" that does nothing. When credits
 * become an entry in each runtime's own sign-in list, {@link readCreditsFor}
 * and {@link useCreditsFor}'s writer are the only two places that change: the
 * rows already carry `canTurnOff` and `previousSignIn` for the switch to use.
 *
 * @module features/cloud-plan/model/use-credits-for
 */
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { useCloudCredits, useSelectCloudCredits } from './use-cloud-plan';

/** One runtime the credits path is wired for, as the switch row reads it. */
export interface CreditsForRow {
  /** The runtime's type id (`claude-code`). Never rendered. */
  runtime: string;
  /** The runtime's display name. */
  name: string;
  /** Whether this runtime's turns run on DorkOS credits right now. */
  on: boolean;
  /** Whether turning it on from here can work. */
  canTurnOn: boolean;
  /** Whether turning it off from here can work. False until the server can do it. */
  canTurnOff: boolean;
  /**
   * The sign-in turning it off goes back to, named — or `null` when the runtime
   * has no sign-in of its own to name.
   */
  previousSignIn: string | null;
}

/**
 * Read the rows from the credits report.
 *
 * Only a runtime the server reports as wired gets a row, and only while the
 * server has the credits path switched on at all: a switch for a runtime credits
 * cannot reach would be a promise about somebody's money that nothing keeps.
 *
 * @param report - `GET /api/cloud/credits`, or `undefined` while it loads.
 */
export function readCreditsFor(report: CloudCreditsStatus | undefined): CreditsForRow[] {
  if (!report?.enabled) return [];
  return Object.entries(report.runtimes)
    .filter(([, state]) => state === 'wired')
    .map(([runtime]) => ({
      runtime,
      name: runtimeDisplayName(runtime),
      on: report.ready,
      canTurnOn: true,
      canTurnOff: false,
      previousSignIn: null,
    }));
}

/** The rows, and the one write that changes a runtime's default. */
export interface UseCreditsFor {
  rows: CreditsForRow[];
  /** A write is in flight; every switch waits for it. */
  pending: boolean;
  /**
   * Why the last turn-on did not take, in words for the person, or `null`.
   *
   * It says only that credits could not be turned on — never "nothing
   * changed", because what state survived is the server's report to give, and
   * the switch already shows that report.
   */
  failure: string | null;
  /**
   * Put one runtime's default on credits, or back on its own sign-in.
   *
   * @param runtime - The row's runtime id.
   * @param on - The state the switch was moved to.
   */
  setOn: (runtime: string, on: boolean) => void;
}

/** Read and write which runtimes run on DorkOS credits. */
export function useCreditsFor(): UseCreditsFor {
  const { data } = useCloudCredits();
  const select = useSelectCloudCredits();
  const rows = readCreditsFor(data);

  const setOn = (runtime: string, on: boolean) => {
    const row = rows.find((candidate) => candidate.runtime === runtime);
    if (row === undefined || row.on === on) return;
    if (on && row.canTurnOn) select.mutate();
  };

  // The select answers the same report whether or not it armed anything, so a
  // turn-on worked only when the report it sent back says credits are live. A
  // turn-on that DID work stays quiet afterwards, even once the pass runs out
  // and the switch reads off again: that is the report changing, not this
  // write failing.
  const failure = select.isError
    ? `Couldn’t turn on DorkOS credits. ${errorReason(select.error)}`
    : select.isSuccess && !select.data.ready
      ? 'Couldn’t turn on DorkOS credits: DorkOS couldn’t get a pass for this computer. Try again in a moment.'
      : null;

  return { rows, pending: select.isPending, failure, setOn };
}

/**
 * The reason a failed request gave, or a plain fallback when it gave none.
 *
 * @param error - What the transport rejected with.
 */
function errorReason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Try again in a moment.';
}

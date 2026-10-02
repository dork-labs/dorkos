/**
 * "Use credits for" — whether each runtime's new work runs on DorkOS credits, as
 * a VIEW onto that runtime's recorded Runs on choice (ADR 261001-000811).
 *
 * **It holds no state of its own, on purpose.** Who pays for a turn is decided
 * where each runtime already decides it — its default in Runs on — and a second
 * switch stored here would be a second answer to that question, free to
 * disagree with the first. So every row reads the runtime's recorded choice
 * (`GET /api/cloud/credits` → `defaults[runtime]`) and writes it through the one
 * route that records a person's choice (`PUT /api/cloud/credits/default`).
 *
 * A row is on only when the record says `credits`. A recorded "no", or no
 * record at all, reads off, so the switch never says on for a computer whose
 * new work is not on credits. Turning it off records the person's "no" and puts
 * the runtime back on its own default sign-in, which the row names.
 *
 * @module features/cloud-plan/model/use-credits-for
 */
import type { CloudCreditsChosenBy, CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { claudeAccountName } from '@/layers/shared/lib';
import { useClaudeAccounts, useCloudCredits, useSetCreditsDefault } from '@/layers/shared/model';

/** One runtime the credits path is wired for, as the switch row reads it. */
export interface CreditsForRow {
  /** The runtime's type id (`claude-code`). Never rendered. */
  runtime: string;
  /** The runtime's own name, as every runtime surface says it ("Claude Code"). */
  name: string;
  /** Whether this runtime's new work runs on DorkOS credits by default. */
  on: boolean;
  /** Who turned it on, when it is on. */
  chosenBy: CloudCreditsChosenBy | null;
  /** Whether turning it on from here can work. */
  canTurnOn: boolean;
  /** Whether turning it off from here can work. */
  canTurnOff: boolean;
  /**
   * The sign-in turning it off goes back to, by the name the person gave it —
   * or `null` when it has none (never a raw folder name), which the row says
   * as "its own sign-in".
   */
  previousSignIn: string | null;
}

/**
 * Read the rows from the credits report.
 *
 * Only a runtime the server reports as wired gets a row, and only while credits
 * can be chosen here at all (linked, not switched off): a switch for a runtime
 * credits cannot reach would be a promise about somebody's money that nothing
 * keeps.
 *
 * @param report - `GET /api/cloud/credits`, or `undefined` while it loads.
 * @param previousSignIn - Names the sign-in a runtime goes back to, if known.
 */
export function readCreditsFor(
  report: CloudCreditsStatus | undefined,
  previousSignIn: (runtime: string) => string | null = () => null
): CreditsForRow[] {
  if (!report?.enabled) return [];
  return Object.entries(report.runtimes)
    .filter(([, state]) => state === 'wired')
    .map(([runtime]) => {
      const choice = report.defaults?.[runtime];
      const on = choice?.runsOn === 'credits';
      return {
        runtime,
        name: getRuntimeDescriptor(runtime).label,
        on,
        chosenBy: on ? (choice?.chosenBy ?? null) : null,
        canTurnOn: true,
        canTurnOff: true,
        previousSignIn: previousSignIn(runtime),
      };
    });
}

/**
 * The runtimes a DorkOS account would let this computer run on credits, for
 * the page shown BEFORE linking: every runtime the server reports as wired,
 * unless credits are switched off on this computer. Not gated on `enabled`,
 * which needs a link and so can never be true on that page.
 *
 * @param report - `GET /api/cloud/credits`, or `undefined` while it loads.
 */
export function creditsRuntimesOnOffer(report: CloudCreditsStatus | undefined): string[] {
  if (!report || report.killed) return [];
  return Object.entries(report.runtimes)
    .filter(([, state]) => state === 'wired')
    .map(([runtime]) => getRuntimeDescriptor(runtime).label);
}

/** The rows, and the one write that changes a runtime's default. */
export interface UseCreditsFor {
  rows: CreditsForRow[];
  /** A write is in flight; every switch waits for it. */
  pending: boolean;
  /** Why the last change did not take, in words for the person, or `null`. */
  failure: string | null;
  /**
   * Put one runtime's default on credits, or back on its own sign-in, recorded
   * as the person's choice.
   *
   * @param runtime - The row's runtime id.
   * @param on - The state the switch was moved to.
   */
  setOn: (runtime: string, on: boolean) => void;
}

/** Read and write which runtimes run on DorkOS credits. */
export function useCreditsFor(): UseCreditsFor {
  const { data } = useCloudCredits();
  const setDefault = useSetCreditsDefault();
  const { accounts, ownResolvedAccount, nameFor } = useClaudeAccounts();
  const rows = readCreditsFor(data, (runtime) =>
    runtime === 'claude-code' && ownResolvedAccount
      ? givenName(ownResolvedAccount, accounts, nameFor)
      : null
  );

  const setOn = (runtime: string, on: boolean) => {
    const row = rows.find((candidate) => candidate.runtime === runtime);
    if (row === undefined || row.on === on) return;
    if (on ? !row.canTurnOn : !row.canTurnOff) return;
    setDefault.mutate({ runtime, useCredits: on });
  };

  const failure = setDefault.isError
    ? `Couldn’t change that. ${errorReason(setDefault.error)}`
    : null;

  return { rows, pending: setDefault.isPending, failure, setOn };
}

/**
 * The name a person gave a Claude sign-in (a registered account's label, or
 * Main's), or `null` when all there is to call it is its folder: a path like
 * `.claude-work` means nothing to somebody reading a settings row.
 */
function givenName(
  path: string,
  accounts: readonly { path: string; label: string | null }[],
  nameFor: (path: string) => string
): string | null {
  const registered = accounts.find((account) => account.path === path);
  if (registered) return registered.label;
  const named = nameFor(path);
  return named === claudeAccountName(path, []) ? null : named;
}

/** What a failed turn-on says when the request brought back no reason of its own. */
const NO_REASON = 'Try again in a moment.';

/**
 * The reason a failed turn-on came back with, when the SERVER gave one; the
 * plain fallback otherwise.
 *
 * A transport error's message is not always words meant for a person: a
 * network failure reads "Failed to fetch" or "Load failed", and a response
 * with no JSON body falls back to its status text or "HTTP 500". Only a
 * message the server wrote is passed through — the request got an answer (a
 * numeric `status`), the answer's own JSON `error` field is the message, and
 * it is a sentence (status texts and bare codes never end in one).
 *
 * @param error - What the transport rejected with.
 * @internal Exported for testing only.
 */
export function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return NO_REASON;
  const { status, body } = error as Error & { status?: unknown; body?: unknown };
  const written =
    typeof status === 'number' &&
    typeof body === 'object' &&
    body !== null &&
    (body as { error?: unknown }).error === error.message &&
    /[.!?]$/.test(error.message.trim());
  return written ? error.message : NO_REASON;
}

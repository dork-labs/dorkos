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
import type { RuntimeCapabilities, RuntimeCreditsSupport } from '@dorkos/shared/agent-runtime';
import { getRuntimeDescriptor, useRuntimeCapabilities } from '@/layers/entities/runtime';
import { claudeAccountName, serverSentence } from '@/layers/shared/lib';
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
   * Whether credits cannot reach it right now (not linked, switched off, or
   * its format not served) although its recorded choice is credits: its new
   * work is refused until the person turns this off or credits come back.
   */
  unreachable: boolean;
  /**
   * The sign-in turning it off goes back to, by the name the person gave it —
   * or `null` when it has none (never a raw folder name), which the row says
   * as "its own sign-in".
   */
  previousSignIn: string | null;
  /** What a change reaches, as the runtime declares it; `undefined` while capabilities load. */
  scope: RuntimeCreditsSupport['scope'] | undefined;
  /** What the runtime does not get on credits, in the runtime's own sentence, if anything. */
  caveat: string | undefined;
  /** Whether an agent or a session can pick another account for this runtime. */
  hasAccountPicks: boolean;
}

/**
 * Read the rows from the credits report.
 *
 * A runtime the server reports as wired gets a row while credits can be chosen
 * here at all (linked, not switched off): a switch for a runtime credits
 * cannot reach would be a promise about somebody's money that nothing keeps.
 * The one exception is a runtime whose recorded choice is already credits: it
 * keeps its row, which can only be turned off, so the person can always get
 * back to their own sign-in.
 *
 * @param report - `GET /api/cloud/credits`, or `undefined` while it loads.
 * @param previousSignIn - Names the sign-in a runtime goes back to, if known.
 * @param capabilities - Each runtime's declared capabilities, for what a change reaches.
 */
export function readCreditsFor(
  report: CloudCreditsStatus | undefined,
  previousSignIn: (runtime: string) => string | null = () => null,
  capabilities: Partial<Record<string, RuntimeCapabilities>> = {}
): CreditsForRow[] {
  if (!report) return [];
  const runtimes = new Set([
    ...Object.keys(report.runtimes),
    ...Object.keys(report.defaults ?? {}),
  ]);
  return [...runtimes].flatMap((runtime) => {
    const choice = report.defaults?.[runtime];
    const on = choice?.runsOn === 'credits';
    const reachable =
      report.enabled && report.runtimes[runtime as keyof typeof report.runtimes] === 'wired';
    // A runtime recorded on credits keeps its row even when credits cannot
    // reach it now, so the person can always turn it off.
    if (!reachable && !on) return [];
    return [
      {
        runtime,
        name: getRuntimeDescriptor(runtime).label,
        on,
        chosenBy: on ? (choice?.chosenBy ?? null) : null,
        canTurnOn: reachable,
        canTurnOff: true,
        unreachable: !reachable,
        previousSignIn: previousSignIn(runtime),
        scope: capabilities[runtime]?.credits?.scope,
        caveat: capabilities[runtime]?.credits?.caveat,
        hasAccountPicks: capabilities[runtime]?.supportsAccounts === true,
      },
    ];
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
  const { data: capabilities } = useRuntimeCapabilities();
  const { accounts, ownResolvedAccount, nameFor } = useClaudeAccounts();
  const rows = readCreditsFor(
    data,
    (runtime) =>
      runtime === 'claude-code' && ownResolvedAccount
        ? givenName(ownResolvedAccount, accounts, nameFor)
        : null,
    capabilities?.capabilities
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
 * The reason a failed turn-on came back with, when the SERVER gave one
 * ({@link serverSentence}); the plain fallback otherwise.
 *
 * @param error - What the transport rejected with.
 * @internal Exported for testing only.
 */
export function errorReason(error: unknown): string {
  return serverSentence(error) ?? NO_REASON;
}

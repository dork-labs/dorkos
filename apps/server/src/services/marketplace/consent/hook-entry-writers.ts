/**
 * The space side's writers of the hook decision lists, as the marketplace's
 * consent code reaches them (spec `computer-side-starts-alone` §5.7): a
 * global package's yes or no and a dev link's yes, all `<name>@<digest>`
 * entries in `harness.approvedHooks` and `harness.refusedHooks`.
 *
 * The writers live in `core/approvals/computer-asks/hook-decisions.ts`, the one
 * place that writes those lists. Startup hands them here
 * (`startup/computer-asks.ts`) so this domain writes through them without a
 * second import edge into the approvals. Unset, every write throws and names
 * the missing wiring: a yes never lands and a forget is never silently
 * skipped.
 *
 * @module services/marketplace/consent/hook-entry-writers
 */

/** The three writes the marketplace makes to the hook decision lists. */
export interface HookEntryWriters {
  /**
   * Record a yes for one entry, superseding earlier yeses `replacing` matches.
   *
   * @param entry - The `<name>@<digest>` entry to allow.
   * @param reason - The config-write log line.
   * @param replacing - Earlier yeses this one supersedes.
   */
  recordApproved(entry: string, reason: string, replacing?: (stored: string) => boolean): void;
  /**
   * Record a no for one entry.
   *
   * @param entry - The `<name>@<digest>` entry to turn down.
   * @param reason - The config-write log line.
   */
  recordRefused(entry: string, reason: string): void;
  /**
   * Forget every stored yes `matches` matches, leaving every no in place.
   *
   * @param matches - Which approved entries to forget.
   * @param reason - The config-write log line.
   */
  forgetApproved(matches: (stored: string) => boolean, reason: string): void;
}

/** Thrown by every write before startup hands the writers over. */
export class HookEntryWritersUnwiredError extends Error {
  override readonly name = 'HookEntryWritersUnwiredError';

  constructor() {
    super(
      'The hook decision writers are not wired: startup/computer-asks.ts (wireConsentWrites) hands them to the marketplace before any consent is recorded.'
    );
  }
}

/** The writers before startup: every write refuses. */
const UNWIRED: HookEntryWriters = Object.freeze({
  recordApproved: () => {
    throw new HookEntryWritersUnwiredError();
  },
  recordRefused: () => {
    throw new HookEntryWritersUnwiredError();
  },
  forgetApproved: () => {
    throw new HookEntryWritersUnwiredError();
  },
});

let writers: HookEntryWriters | undefined;

/**
 * Hand the marketplace the space side's hook decision writers, or clear them.
 *
 * @param next - The writers, or `undefined` to clear them.
 */
export function setHookEntryWriters(next: HookEntryWriters | undefined): void {
  writers = next;
}

/** The writers, or ones that throw on every write before startup hands them over. */
export function hookEntryWriters(): HookEntryWriters {
  return writers ?? UNWIRED;
}

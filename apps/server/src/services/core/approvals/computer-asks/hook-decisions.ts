/**
 * Writing the durable record of who may install hooks, and who may not
 * (DOR-522, DOR-1849), on the space side (spec `computer-side-starts-alone`
 * §5.7).
 *
 * `harness.approvedHooks` holds the yeses and `harness.refusedHooks` the noes.
 * Recording either side removes the matching entry from the other, so a
 * package is approved, refused, or undecided, never two of them. What an entry
 * binds, and why a durable no is safe, is `harness/hook-consent.ts`, which
 * reads the same lists for the computer side. Both leaves are `operator-only`
 * (`core/operator/config-write-policy.ts`).
 *
 * @module services/core/approvals/computer-asks/hook-decisions
 */
import {
  hookApprovalEntry,
  hookCommandsKey,
  hookEntryPackageName,
  sameHookCommands,
} from '@dorkos/shared/consent-entries';
import type { HookProjectionRequest } from '@dorkos/shared/computer-asks';
import { readConsent, writeConsent } from './consent-config.js';

/** Both stored lists, as the running server holds them. */
function storedLists(): { approved: readonly string[]; refused: readonly string[] } {
  const harness = readConsent('harness');
  return { approved: harness.approvedHooks, refused: harness.refusedHooks };
}

/**
 * Write both lists back, log what moved, and say nothing when nothing changed.
 *
 * One writer for both sides so the "never in both" invariant lives in a single
 * place rather than in each caller.
 */
function writeDecisions(reason: string, approved: string[], refused: string[]): void {
  const harness = readConsent('harness');
  const sameApproved =
    approved.length === harness.approvedHooks.length &&
    approved.every((entry, i) => entry === harness.approvedHooks[i]);
  const sameRefused =
    refused.length === harness.refusedHooks.length &&
    refused.every((entry, i) => entry === harness.refusedHooks[i]);
  if (sameApproved && sameRefused) return;
  writeConsent('harness', reason, { ...harness, approvedHooks: approved, refusedHooks: refused });
}

/**
 * Record one decision about a package's hooks, replacing every earlier entry
 * for the same commands on either list: one decision per set of commands, and
 * the newest one names the files it covers.
 */
function recordHookDecision(
  request: HookProjectionRequest,
  decision: 'approved' | 'refused',
  reason: string
): void {
  const entry = hookApprovalEntry(request);
  const key = hookCommandsKey(request);
  const { approved, refused } = storedLists();
  const others = (list: readonly string[]): string[] =>
    list.filter((stored) => !sameHookCommands(stored, key));
  writeDecisions(
    reason,
    decision === 'approved' ? [...others(approved), entry] : others(approved),
    decision === 'refused' ? [...others(refused), entry] : others(refused)
  );
}

/**
 * Whether a no for these commands is on record, whatever files they run.
 *
 * @param request - The projection asked about.
 */
export function isHookRefusedOnRecord(request: HookProjectionRequest): boolean {
  const key = hookCommandsKey(request);
  return storedLists().refused.some((stored) => sameHookCommands(stored, key));
}

/**
 * Record a person's yes, so the same package projecting the same hooks into the
 * same project is never asked about again.
 *
 * Idempotent, and it clears any matching refusal: a package cannot be approved
 * and refused at once.
 *
 * @param request - The projection that was allowed.
 */
export function recordHookApproval(request: HookProjectionRequest): void {
  recordHookDecision(request, 'approved', 'approving a package hook');
}

/**
 * Record a person's no, so every later trigger obeys it instead of asking again.
 *
 * Idempotent, and it clears any matching approval — the same package cannot be
 * on both lists. The refusal ends on its own when the package changes what it
 * wants to run (a different digest matches neither list), and a person can end
 * it early with `dorkos harness hooks --revoke <package>`.
 *
 * @param request - The projection that was turned down.
 */
export function recordHookRefusal(request: HookProjectionRequest): void {
  recordHookDecision(request, 'refused', 'turning down a package hook');
}

/**
 * Pin today's files onto a yes recorded before files were pinned, so the next
 * edit to them needs a new yes. The running server's store only; the read-only
 * `--check` path never asks for this.
 *
 * @param request - A projection `hookApprovalMatch` answered `unpinned` for.
 */
export function pinLegacyHookApproval(request: HookProjectionRequest): void {
  if ((request.scripts ?? []).length === 0) return;
  recordHookDecision(request, 'approved', 'pinning the files a package hook runs');
}

/**
 * Record a yes for one stored entry, whatever decision it identifies: a hook
 * projection (`hookApprovalEntry`), a global plugin's programs
 * (`globalActivationEntry` in `marketplace/global-plugin-consent.ts`) or a
 * worktree's `workspace.json` hooks. One writer, so "never on both lists"
 * holds for every kind of entry.
 *
 * @param entry - The `<packageName>@<digest>` entry to allow.
 * @param reason - What the audit log says was happening.
 * @param replacing - Earlier yeses this one supersedes, removed in the same
 *   write (a global package keeps one approval: the one for what is installed).
 */
export function recordApprovedEntry(
  entry: string,
  reason: string,
  replacing: (stored: string) => boolean = () => false
): void {
  const { approved, refused } = storedLists();
  const kept = approved.filter((stored) => stored === entry || !replacing(stored));
  writeDecisions(
    reason,
    kept.includes(entry) ? kept : [...kept, entry],
    refused.filter((stored) => stored !== entry)
  );
}

/**
 * Forget every stored yes a predicate matches, leaving every no in place.
 * Used when a global package is replaced or removed, so an old approval can
 * never cover the same bytes coming back later (a downgrade).
 *
 * @param matches - Which approved entries to forget.
 * @param reason - What the audit log says was happening.
 */
export function forgetApprovedEntries(matches: (stored: string) => boolean, reason: string): void {
  const { approved, refused } = storedLists();
  writeDecisions(
    reason,
    approved.filter((stored) => !matches(stored)),
    [...refused]
  );
}

/**
 * Record a no for one stored entry; the counterpart of {@link recordApprovedEntry}.
 *
 * @param entry - The `<packageName>@<digest>` entry to turn down.
 * @param reason - What the audit log says was happening.
 */
export function recordRefusedEntry(entry: string, reason: string): void {
  const { approved, refused } = storedLists();
  writeDecisions(
    reason,
    approved.filter((stored) => stored !== entry),
    refused.includes(entry) ? [...refused] : [...refused, entry]
  );
}

/** One stored decision, removed by {@link revokeHookDecisions}. */
export interface RevokedHookDecision {
  /** The entry as it was stored. */
  entry: string;
  /** Which list it came off. */
  decision: 'approved' | 'refused';
}

/**
 * Forget every stored decision recorded for one package.
 *
 * Scoped by package NAME rather than by project, and that is the honest scope
 * rather than a shortcut: the digest is one-way, so a stored entry cannot say
 * which project it was recorded in. Only the entry matching what the package
 * declares in the project you are standing in can be identified, and every other
 * entry for that name is already inert — its digest matches nothing, so the
 * package is treated as undecided wherever it now differs. Removing a decision
 * only ever means "ask me again", so the wider scope cannot arm anything; the
 * caller prints each entry it removed and says which one matched here.
 *
 * @param packageName - The package whose decisions to forget.
 * @returns What was removed, in the order the lists held it.
 */
export function revokeHookDecisions(packageName: string): RevokedHookDecision[] {
  const { approved, refused } = storedLists();
  const mine = (entry: string): boolean => hookEntryPackageName(entry) === packageName;
  const removed: RevokedHookDecision[] = [
    ...approved.filter(mine).map((entry) => ({ entry, decision: 'approved' as const })),
    ...refused.filter(mine).map((entry) => ({ entry, decision: 'refused' as const })),
  ];
  if (removed.length === 0) return [];
  writeDecisions(
    'revoking a package hook decision',
    approved.filter((entry) => !mine(entry)),
    refused.filter((entry) => !mine(entry))
  );
  return removed;
}

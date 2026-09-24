/**
 * Marketplace package update flow.
 *
 * Advisory by default: checks installed packages, works out what installing
 * each one right now would give, and returns the comparison without touching
 * any installed package. When `apply` is set, the flow delegates reinstallation
 * of every installation with an update to an injected {@link InstallerLike},
 * which runs the uninstall-without-purge → install pattern that preserves
 * `.dork/data/` and `.dork/secrets.json` (ADR-0233).
 *
 * Two doors lead here, and both check {@link InstallationRecord}s from the
 * installed scanner's one walk rather than walking install roots themselves:
 *
 * - {@link UpdateFlow.run} — one package, the installation the caller resolved
 *   with {@link pickInstallation} (the per-package route).
 * - {@link UpdateFlow.checkInstallations} — every installation it is handed,
 *   one result per installation, each carrying that installation's identity
 *   (the all-packages door, whose shared steps live in `update-installed.ts`).
 *   The caller scans once and passes the records in.
 *
 * Checks from both doors share one server-wide cap
 * ({@link UPDATE_CHECK_CONCURRENCY}). A symlinked install is checked but never
 * reinstalled ({@link LINKED_INSTALL_NOTE}).
 *
 * Either way, an apply reinstalls an installation in the scope it was found in —
 * never the scope the request named — so updating a global package from a
 * project never moves it into that project (ADR 260923-163034).
 *
 * "What installing now would give" is answered by the installer's own
 * resolve → stage → validate pipeline (`MarketplaceInstaller.resolveLatest`),
 * and a version is read by Claude Code's chain on both sides: the version the
 * package declares, else its marketplace entry's, else the commit
 * (`resolvePackageVersion`, ADR 260923-122615). Every check ends in one of
 * three statuses — `current`, `update-available` or `unknown` — and nothing is
 * dropped: a package that cannot be checked says why, and is never reported
 * as current.
 *
 * The installer is injected through {@link InstallerLike} to break the
 * circular dependency between this flow and the full installer orchestrator.
 *
 * @module services/marketplace/flows/update
 */
import { isRealCommitSha } from '@dorkos/marketplace';
import type { InstallRequest, InstallResult } from '../types.js';
import { disclosedEffectsOf, type DisclosedEffects } from '../disclosed-effects.js';
import type { InstallationRecord } from '../installed-scanner.js';
import { Slots } from '../lib/slots.js';
import {
  compareVersions,
  installedVersionOf,
  joinNotes,
  notInScope,
  realCommitOf,
  unknownCheck,
  withIdentity,
} from './update-compare.js';
import { installationUpdateName } from './update-selection.js';
import { TtlMemo } from './update-memo.js';
import { UpdateTargets } from './update-targets.js';
import type {
  InstallationUpdatesRequest,
  InstallationUpdatesResult,
  UpdateCheckResult,
  UpdateFlowDeps,
  UpdatePlan,
  UpdateRequest,
  UpdateResult,
} from './update-types.js';

/**
 * How long a commit lookup or a marketplace index fetch is shared between
 * checks. A named `dorkos update <name>` and the app's per-row Update each send
 * one request per package, so a memo scoped to one call would never span them;
 * one scoped to the instance with this TTL is "shared within one CLI run or UI
 * burst". Without a refresh, a push made within the last minute can still read
 * as current.
 */
export const UPDATE_MEMO_TTL_MS = 60_000;

/**
 * How many update checks run at once on this server, across every request.
 *
 * Each check may `git ls-remote` a repository or stage a package into the
 * cache, and those are bounded by the fetcher's own timeouts. The cap is held
 * by the one {@link UpdateFlow} instance, so two whole-install checks arriving
 * together (the CLI and the app, or two agents) still open at most this many
 * git processes between them, and a slow or unreachable repository holds only
 * its own slot. Concurrent checks of one repository share a single in-flight
 * lookup through the memo — including a failing one, which is never kept once
 * it settles.
 */
export const UPDATE_CHECK_CONCURRENCY = 4;

/** A ref that is already a full commit SHA — `ls-remote` cannot look one up. */
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** The note on a check of a symlinked install, which is never reinstalled. */
export const LINKED_INSTALL_NOTE = 'linked install — update its source instead';

/** One check, plus the request that would apply it. */
interface PlannedCheck {
  check: UpdateCheckResult;
  /** The reinstall request, present only when the check can be applied. */
  request?: InstallRequest;
  /** What the new version would run, when the check was planned with `disclose`. */
  disclosed?: DisclosedEffects | null;
}

/**
 * Advisory-by-default update orchestrator for marketplace packages.
 *
 * {@link UpdateFlow.run} checks one package by name; {@link
 * UpdateFlow.checkInstallations} checks every installation it is handed. Both
 * reinstall `update-available` installations when asked to apply, each in its
 * own scope. One instance serves the whole server, and it holds the
 * commit-lookup and index memos (see {@link UPDATE_MEMO_TTL_MS}).
 */
export class UpdateFlow {
  private readonly commitMemo: TtlMemo<string>;
  /** Where each package would be reinstalled from; holds the index memo. */
  private readonly targets: UpdateTargets;
  /** The server-wide cap on concurrent checks ({@link UPDATE_CHECK_CONCURRENCY}). */
  private readonly checkSlots = new Slots(UPDATE_CHECK_CONCURRENCY);

  /**
   * Build the server's one update flow.
   *
   * @param deps - The installer, sources, fetcher and logger it works through.
   */
  constructor(private readonly deps: UpdateFlowDeps) {
    const now = deps.now ?? Date.now;
    this.commitMemo = new TtlMemo(UPDATE_MEMO_TTL_MS, now);
    this.targets = new UpdateTargets(deps, new TtlMemo(UPDATE_MEMO_TTL_MS, now));
  }

  /**
   * Check one package — the per-package route's door. The caller resolves which
   * installation the name means ({@link pickInstallation}); an apply reinstalls
   * that installation in ITS scope, so a global package is reinstalled globally
   * even when the request named a project. A failed reinstall throws, so the
   * route can map the error to a status.
   *
   * @param req - The package name, its resolved installation, and the apply flag.
   * @returns One check (or one `unknown` "not installed in this scope" check
   *   when there is no installation), and the reinstall when applied.
   */
  async run(req: UpdateRequest): Promise<UpdateResult> {
    const match = req.installation;
    if (!match) return { checks: [notInScope(req.name)], applied: [] };

    const { check, request } = await this.checkSafely(match);
    const applied: InstallResult[] = [];
    if (req.apply) {
      try {
        if (check.status === 'update-available' && request) {
          applied.push(await this.reinstall(match, request));
        }
      } finally {
        // What was just installed changes what the next check should see.
        this.clearMemos();
      }
    }
    return { checks: [check], applied };
  }

  /**
   * Check every installation handed in — the all-packages door. The caller
   * scans once (`scanInstallationRecords`) and passes the records, so a list and
   * its check never walk twice.
   *
   * Checks share the server-wide {@link UPDATE_CHECK_CONCURRENCY} cap and come
   * back in the order given, each carrying its installation's identity. Nothing
   * is dropped: an installation that cannot be checked is `unknown`, with the
   * reason, and a symlinked install is `unknown` with {@link LINKED_INSTALL_NOTE}
   * and is never reinstalled.
   *
   * With `apply`, every `update-available` installation is reinstalled one at a
   * time, in order, in its own scope. A failed reinstall is recorded on that
   * installation as `applyError` and the rest carry on, so one broken package
   * can never hide what already landed.
   *
   * @param req - The scanned installations, and whether to apply.
   * @returns One check per installation.
   */
  async checkInstallations(req: InstallationUpdatesRequest): Promise<InstallationUpdatesResult> {
    const plan = await this.planInstallations(req);
    return req.apply ? this.applyPlan(plan) : { checks: plan.checks };
  }

  /**
   * Check the installations handed in, without applying anything: the first
   * half of {@link checkInstallations}, for a caller that must show the checks
   * to a person and apply only what they approved. With `disclose`, each
   * `update-available` check also says what its new version would run.
   *
   * @param req - The scanned installations, and whether to disclose.
   * @returns The checks, and what an apply of them would reinstall.
   */
  async planInstallations(
    req: Pick<InstallationUpdatesRequest, 'installations' | 'disclose'>
  ): Promise<UpdatePlan> {
    const planned = await Promise.all(
      req.installations.map((record) => this.checkSafely(record, req.disclose ?? false))
    );
    return {
      checks: planned.map(({ check, disclosed }, i) => ({
        ...withIdentity(check, req.installations[i]!.package),
        ...(disclosed !== undefined && { disclosed }),
      })),
      steps: planned.map(({ request }, i) => ({
        record: req.installations[i]!,
        ...(request && { request }),
      })),
    };
  }

  /**
   * Reinstall a plan's `update-available` installations one at a time, in
   * order, each in its own scope. A failed reinstall is recorded on that
   * installation as `applyError` and the rest carry on.
   *
   * With `approved`, only the installations it names (by `installPath`) are
   * reinstalled, and each is held to the disclosure it maps to: the installer
   * refuses a new version that now declares something else
   * (`DisclosureChangedError`), before it removes anything.
   *
   * @param plan - A plan from {@link planInstallations}.
   * @param approved - The approved installations and what each was shown to run.
   * @returns One check per installation, each with its `applied` or `applyError`.
   */
  async applyPlan(
    plan: UpdatePlan,
    approved?: ReadonlyMap<string, DisclosedEffects | null>
  ): Promise<InstallationUpdatesResult> {
    const checks = plan.checks.map((c) => ({ ...c }));
    try {
      for (const [i, { record, request }] of plan.steps.entries()) {
        const check = checks[i]!;
        if (check.status !== 'update-available' || !request) continue;
        const path = record.package.installPath;
        if (approved && !approved.has(path)) continue;
        try {
          check.applied = await this.reinstall(
            record,
            approved ? { ...request, approvedDisclosure: approved.get(path) ?? null } : request
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.deps.logger.warn('update-flow: reinstall failed', {
            packageName: check.packageName,
            installPath: path,
            error: reason,
          });
          check.applyError = reason;
        }
      }
    } finally {
      this.clearMemos();
    }
    return { checks };
  }

  /**
   * Forget every memoized commit lookup and index fetch, so the next check
   * asks again. Called after every apply and by the marketplace refresh route,
   * which is how "I just pushed; check again" gets a fresh answer.
   */
  clearMemos(): void {
    this.commitMemo.clear();
    this.targets.clearMemo();
  }

  /**
   * Reinstall exactly one installation, in the scope it was found in: its
   * project for a project or agent install, none for a global one. The install
   * root is passed through, because the installer otherwise finds its target by
   * name, and a plugin and an agent sharing a name would resolve to the plugin.
   *
   * @internal
   */
  private reinstall(record: InstallationRecord, request: InstallRequest): Promise<InstallResult> {
    return this.deps.installer.update({
      ...request,
      projectPath: record.package.agentPath,
      installRoot: record.package.installPath,
    });
  }

  /**
   * {@link UpdateFlow.checkRecord} inside a server-wide slot, total: a check
   * that throws (an unreadable marketplaces file, a bug) becomes that
   * installation's `unknown` with the reason, and releases its slot, so one
   * failure never fails the request or stalls the checks queued behind it.
   *
   * @internal
   */
  private async checkSafely(record: InstallationRecord, disclose = false): Promise<PlannedCheck> {
    try {
      return await this.checkSlots.run(async () => {
        const planned = await this.checkRecord(record);
        return disclose ? this.discloseSafely(record, planned) : planned;
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn('update-flow: check failed', {
        installPath: record.package.installPath,
        error: reason,
      });
      return {
        check: unknownCheck(
          installationUpdateName(record),
          installedVersionOf(record),
          `couldn't check this package: ${reason}`
        ),
      };
    }
  }

  /**
   * Add what an `update-available` check's new version would run, read from
   * the version a reinstall would install, in the installation's own scope. A
   * new version that cannot be read becomes `unknown` with the reason and
   * loses its reinstall request, so nobody can approve it unseen.
   *
   * @internal
   */
  private async discloseSafely(
    record: InstallationRecord,
    planned: PlannedCheck
  ): Promise<PlannedCheck> {
    if (planned.check.status !== 'update-available' || !planned.request) return planned;
    try {
      const { preview } = await this.deps.installer.preview({
        ...planned.request,
        projectPath: record.package.agentPath,
      });
      // Whatever could not be read cannot be shown, so it cannot be approved:
      // offer nothing rather than a card that silently leaves it out.
      const unread = [
        ...preview.unreadableHooks.map((h) => (h.event ? `${h.path} (${h.event})` : h.path)),
        ...preview.unreadableDeclarations.map((d) => (d.entry ? `${d.path} (${d.entry})` : d.path)),
      ];
      if (unread.length > 0) {
        return {
          check: unknownCheck(
            planned.check.packageName,
            installedVersionOf(record),
            `the new version declares something DorkOS could not read (${unread.join(', ')}), ` +
              `so it can't be approved from here; nothing was changed`
          ),
        };
      }
      return { ...planned, disclosed: disclosedEffectsOf(preview) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        check: unknownCheck(
          planned.check.packageName,
          installedVersionOf(record),
          `couldn't read what the new version would run: ${reason}`
        ),
      };
    }
  }

  /**
   * Check one installation: find where it would be reinstalled from, ask the
   * installer what that would give, and compare by Claude Code's chain. The
   * installed side is the record's declared version and install sidecar.
   *
   * @internal
   */
  private async checkRecord(record: InstallationRecord): Promise<PlannedCheck> {
    const name = installationUpdateName(record);
    const recorded = record.metadata;
    const installedCommit = realCommitOf(record);
    const installed = installedVersionOf(record);
    // A reinstall would replace the link, and the working copy behind it, with a
    // fresh fetch. No request is returned, so no apply can ever reach it.
    if (record.linked) return { check: unknownCheck(name, installed, LINKED_INSTALL_NOTE) };

    const target = await this.targets.find(name, recorded);
    if (target.kind === 'none') {
      this.deps.logger.warn('update-flow: no marketplace entry found for package', {
        packageName: name,
        note: target.note,
      });
      return { check: unknownCheck(name, installed, target.note) };
    }

    const request: InstallRequest =
      target.kind === 'marketplace'
        ? { name, marketplace: target.marketplaceName }
        : { name, source: target.source };
    const latest = await this.deps.installer.resolveLatest(request, {
      installed: {
        commitSha: installedCommit,
        entryVersion: recorded?.entryVersion,
        sourceKey: recorded?.sourceKey,
      },
      commitLookup: (cloneUrl, ref) => this.lookupCommit(cloneUrl, ref),
    });

    const marketplace = target.kind === 'marketplace' ? target.marketplaceName : '';
    const check = compareVersions(name, marketplace, installed, latest);
    if (target.kind === 'direct' && target.note) {
      check.note = joinNotes(target.note, check.note);
    }
    return { check, request };
  }

  /**
   * The memoized commit lookup handed to the installer. A ref that is already
   * a full SHA is its own commit and is returned without `ls-remote`, which
   * matches ref names only and would report a pinned package unreachable. A
   * placeholder answer is returned but never kept, so a retry looks again.
   *
   * @internal
   */
  private lookupCommit(cloneUrl: string, ref: string): Promise<string> {
    if (FULL_SHA_RE.test(ref)) return Promise.resolve(ref);
    return this.commitMemo.get(
      `${cloneUrl}\n${ref}`,
      () => this.deps.fetcher.lookupCommitSha(cloneUrl, ref),
      isRealCommitSha
    );
  }
}

/**
 * Writing the durable record of a repo's settings consents on the space side
 * (spec `computer-side-starts-alone` §5.7): `harness.approvedRepoConfig` and
 * `refusedRepoConfig` (DOR-3297), the commit each repo was last compared
 * against, `repoBaselines` (DOR-3298), and the one-time upgrade pin
 * `repoBaselinesPinned`. All `operator-only`
 * (`core/operator/config-write-policy.ts`). How the computer side reads them is
 * `runtimes/claude-code/repo-settings/repo-config-consent.ts`.
 *
 * @module services/core/approvals/computer-asks/repo-decisions
 */
import { repoConfigEntry } from '@dorkos/shared/consent-entries';
import type { RecordedBaseline, RepoConfigKind } from '@dorkos/shared/computer-asks';
import { readConsent, writeConsent } from './consent-config.js';

/** The most repos whose baseline is remembered; the oldest go first. */
const MAX_BASELINES = 500;

/** The three stored leaves. */
interface Decisions {
  approved: string[];
  refused: string[];
  baselines: Record<string, RecordedBaseline>;
}

/** The leaves as stored now; a missing section reads as nothing decided. */
function stored(): Decisions {
  const harness = (readConsent('harness') ?? {}) as {
    approvedRepoConfig?: string[];
    refusedRepoConfig?: string[];
    repoBaselines?: Record<string, RecordedBaseline>;
  };
  return {
    approved: [...(harness.approvedRepoConfig ?? [])],
    refused: [...(harness.refusedRepoConfig ?? [])],
    baselines: { ...(harness.repoBaselines ?? {}) },
  };
}

/** Write the leaves back, and say nothing when nothing changed. */
function write(reason: string, next: Decisions): void {
  const harness = readConsent('harness');
  if (JSON.stringify(next) === JSON.stringify(stored())) return;
  writeConsent('harness', reason, {
    ...harness,
    approvedRepoConfig: next.approved,
    refusedRepoConfig: next.refused,
    repoBaselines: next.baselines,
  });
}

/** The baselines with one set (moved to the end), the oldest dropped past the cap. */
function withBaseline(
  baselines: Record<string, RecordedBaseline>,
  commonDir: string,
  baseline: RecordedBaseline
): Record<string, RecordedBaseline> {
  const entries = Object.entries(baselines).filter(([key]) => key !== commonDir);
  entries.push([commonDir, { branch: baseline.branch, sha: baseline.sha }]);
  return Object.fromEntries(entries.slice(-MAX_BASELINES));
}

/**
 * Record a person's yes for exactly this content, and clear a matching no. A
 * yes on a trust card also records the commit it trusted.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 * @param trust - The repo and commit a trust card's yes trusts from now on.
 */
export function recordRepoConfigApproval(
  kind: RepoConfigKind,
  digest: string,
  trust?: { commonDir: string; baseline: RecordedBaseline }
): void {
  const entry = repoConfigEntry(kind, digest);
  const current = stored();
  const baselines = trust
    ? withBaseline(current.baselines, trust.commonDir, trust.baseline)
    : current.baselines;
  write('allowing repo settings', {
    approved: current.approved.includes(entry) ? current.approved : [...current.approved, entry],
    refused: current.refused.filter((stored) => stored !== entry),
    baselines,
  });
}

/**
 * Record a person's no for exactly this content.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 */
export function recordRepoConfigRefusal(kind: RepoConfigKind, digest: string): void {
  const entry = repoConfigEntry(kind, digest);
  const current = stored();
  write('turning down repo settings', {
    ...current,
    refused: current.refused.includes(entry) ? current.refused : [...current.refused, entry],
  });
}

/**
 * Record the commit a repo was compared against, so the next comparison starts
 * there.
 *
 * @param commonDir - The repo's shared git folder, by real path.
 * @param baseline - The ref and commit.
 */
export function recordBaseline(commonDir: string, baseline: RecordedBaseline): void {
  const current = stored();
  write('comparing a repo against its default branch', {
    ...current,
    baselines: withBaseline(current.baselines, commonDir, baseline),
  });
}

/** Record that DorkOS pinned the repos it already knew, so it never does that again. */
export function markRepoBaselinesPinned(): void {
  const harness = readConsent('harness') as { repoBaselinesPinned?: boolean } | undefined;
  if (harness?.repoBaselinesPinned === true) return;
  writeConsent('harness', 'pinning the repos DorkOS already knew', {
    ...readConsent('harness'),
    repoBaselinesPinned: true,
  });
}

/**
 * The durable record of which repo and worktree settings a person let run, and
 * which they turned down (DOR-3298), plus the default-branch commit each repo
 * was last compared against.
 *
 * ## Keyed by content only
 *
 * An entry is `<kind>@repo-config-<digest>`, where the digest covers only what
 * would run (`repo-config-parts.ts`): no folder, no agent, no commit. The same
 * hook edit in five worktrees of one repo, or the same `settings.local.json`
 * in two repos, is approved once. A no is the same shape, so it holds wherever
 * that content shows up, until the content changes.
 *
 * ## Where the record lives
 *
 * `harness.approvedRepoConfig`, `harness.refusedRepoConfig` and
 * `harness.repoBaselines` in `~/.dork/config.json`, all `operator-only`
 * (`config-write-policy.ts`): an agent that could write a yes would approve its
 * own hook, and one that could move a baseline would make its hook the
 * default branch's. The residual is the one `hook-consent.ts` states: with
 * login off, a caller that omits its agent header is treated as the operator
 * (DOR-505). The space side writes them
 * (`core/approvals/computer-asks/repo-decisions.ts`), from a card's answer or a
 * decision this side reports through the asks port (a baseline moved forward,
 * the upgrade pin); this module only reads.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-config-consent
 */
import type { RecordedBaseline, RepoConfigKind } from '@dorkos/shared/computer-asks';
import { REPO_CONFIG_ENTRY_MARKER, repoConfigEntry } from '@dorkos/shared/consent-entries';
import { configManager } from '../../../core/config-manager.js';

// The stored form of a decision is the space side's too: it writes these lists
// (`core/approvals/computer-asks/repo-decisions.ts`), this module reads them.
export type { RecordedBaseline, RepoConfigKind };
export { REPO_CONFIG_ENTRY_MARKER, repoConfigEntry };

/** The three stored leaves. */
interface Decisions {
  approved: string[];
  refused: string[];
  baselines: Record<string, RecordedBaseline>;
}

/** The leaves as stored now; a missing section reads as nothing decided. */
function stored(): Decisions {
  const harness = (configManager.get('harness') ?? {}) as {
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

/**
 * Whether a person approved exactly this content.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 */
export function isRepoConfigApproved(kind: RepoConfigKind, digest: string): boolean {
  return stored().approved.includes(repoConfigEntry(kind, digest));
}

/**
 * Whether a person turned down exactly this content.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 */
export function isRepoConfigRefused(kind: RepoConfigKind, digest: string): boolean {
  return stored().refused.includes(repoConfigEntry(kind, digest));
}

/**
 * The default-branch commit a repo was last compared against, if any.
 *
 * @param commonDir - The repo's shared git folder, by real path.
 */
export function recordedBaseline(commonDir: string): RecordedBaseline | undefined {
  const found = stored().baselines[commonDir];
  return found ? { ...found } : undefined;
}

/** Whether DorkOS has pinned the repos it already knew (`harness.repoBaselinesPinned`). */
export function repoBaselinesPinned(): boolean {
  return (
    (configManager.get('harness') as { repoBaselinesPinned?: boolean } | undefined)
      ?.repoBaselinesPinned === true
  );
}

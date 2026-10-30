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
 * (DOR-505).
 *
 * @module services/runtimes/claude-code/repo-settings/repo-config-consent
 */
import { configManager } from '../../../core/config-manager.js';
import { logConfigWrite } from '../../../core/operator/config-write.js';

/** What a repo or worktree setting is. */
export type RepoConfigKind = 'local' | 'mcpJson' | 'hooks';

/** What sits between the kind and the digest in a stored entry. */
export const REPO_CONFIG_ENTRY_MARKER = '@repo-config-';

/** The most repos whose baseline is remembered; the oldest go first. */
const MAX_BASELINES = 500;

/**
 * The stored form of one decision about one content.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 */
export function repoConfigEntry(kind: RepoConfigKind, digest: string): string {
  return `${kind}${REPO_CONFIG_ENTRY_MARKER}${digest}`;
}

/** The commit a repo was last compared against. */
export interface RecordedBaseline {
  /** The ref it resolved from. */
  branch: string;
  /** The commit. */
  sha: string;
}

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

/** Write the leaves back, and say nothing when nothing changed. */
function write(reason: string, next: Decisions): void {
  const harness = configManager.get('harness');
  if (JSON.stringify(next) === JSON.stringify(stored())) return;
  configManager.set('harness', {
    ...harness,
    approvedRepoConfig: next.approved,
    refusedRepoConfig: next.refused,
    repoBaselines: next.baselines,
  });
  logConfigWrite(reason, 'harness', harness, configManager.get('harness'));
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
 * Record a yes, and clear a matching no. Earlier yeses stay: each is about its
 * own content, and another worktree may still hold it.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 * @param trust - A repo baseline the person saw this against, to trust from now on.
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
 * Record a no.
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
 * The default-branch commit a repo was last compared against, if any.
 *
 * @param commonDir - The repo's shared git folder, by real path.
 */
export function recordedBaseline(commonDir: string): RecordedBaseline | undefined {
  const found = stored().baselines[commonDir];
  return found ? { ...found } : undefined;
}

/**
 * Remember the commit a repo was compared against. Called only for a commit
 * that builds on the one recorded before (or the first one seen), or one a
 * person approved settings against.
 *
 * @param commonDir - The repo's shared git folder, by real path.
 * @param baseline - The branch and commit.
 */
export function recordBaseline(commonDir: string, baseline: RecordedBaseline): void {
  const current = stored();
  write('comparing a repo against its default branch', {
    ...current,
    baselines: withBaseline(current.baselines, commonDir, baseline),
  });
}

/** Whether DorkOS has pinned the repos it already knew (`harness.repoBaselinesPinned`). */
export function repoBaselinesPinned(): boolean {
  return (
    (configManager.get('harness') as { repoBaselinesPinned?: boolean } | undefined)
      ?.repoBaselinesPinned === true
  );
}

/** Record that DorkOS pinned the repos it already knew, so it never does that again. */
export function markRepoBaselinesPinned(): void {
  const harness = configManager.get('harness');
  if (repoBaselinesPinned()) return;
  configManager.set('harness', { ...harness, repoBaselinesPinned: true });
  logConfigWrite(
    'pinning the repos DorkOS already knew',
    'harness',
    harness,
    configManager.get('harness')
  );
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

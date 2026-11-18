/**
 * Pure proofs for publishing from a `release/vX.Y.Z` branch tip (DOR-4638,
 * ADR 261118-135124). Nothing here runs a command or reads a file: callers feed
 * `gh api`-shaped JSON and facts read from git, and every check fails closed.
 *
 * The same `checkReleaseCherryPicks` backs the `release-cherry-picks` CI check
 * (DOR-4639) and the publish job, so the two can never disagree.
 */

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BRANCH = /^release\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PICK_LINE = /^\(cherry picked from commit ([a-f0-9]{40})\)$/;

/** Which kind of release branch is being published. */
export type ReleaseBranchMode = 'routine' | 'hotfix';

/** One file a commit changes, as `git diff-tree --name-status` reports it. */
export interface ReleaseBranchFile {
  /** The path after the change (the new path for a rename or copy). */
  path: string;
  /** Git's one-letter status: added, modified, deleted, renamed, copied, type change. */
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  /** The file before the commit; read only for VERSION and package.json files. */
  before?: string;
  /** The file after the commit; read only for VERSION and package.json files. */
  after?: string;
}

/** One commit on a release branch after its cut point. */
export interface ReleaseBranchCommit {
  /** The commit SHA. */
  sha: string;
  /** Its parent SHAs; a release branch is linear, so exactly one. */
  parents: string[];
  /** The full commit message. */
  message: string;
  /** The commit's patch fingerprint (`gitPatchId`), or undefined when it has no diff. */
  patchId: string | undefined;
  /** Every file the commit changes. */
  files: ReleaseBranchFile[];
}

/** Input to the cherry-pick rule. */
export interface CherryPickInput {
  /** The version being released, e.g. `1.2.3`. */
  version: string;
  /**
   * Every commit in `<base>..<head>`, oldest first. For a PR check, `head` is
   * the PR's own head commit, never GitHub's merge ref (a merge commit).
   */
  commits: readonly ReleaseBranchCommit[];
  /** Accept an empty range; off by default, since an empty list may be a short read. */
  allowEmpty?: boolean;
  /** True only when the SHA is an ancestor of (or equal to) the trusted main tip. */
  isMainAncestor: (sha: string) => boolean;
  /** The patch fingerprint of a commit on main, or undefined if it cannot be read. */
  patchIdOf: (sha: string) => string | undefined;
}

/** A stable code for each way a commit can break the cherry-pick rule. */
export type CherryPickCode =
  | 'no-commits'
  | 'bad-sha'
  | 'not-linear'
  | 'multiple-sources'
  | 'source-not-on-main'
  | 'patch-id-mismatch'
  | 'non-release-file'
  | 'release-commit-forbidden-path'
  | 'release-commit-package-json'
  | 'empty-commit';

/** One commit that breaks the cherry-pick rule, and why. */
export interface CherryPickFinding {
  /** The offending commit on the release branch; empty for `no-commits`. */
  sha: string;
  /** What is wrong, as a stable code that tests and alarms match on. */
  code: CherryPickCode;
  /** A plain sentence; it quotes commit data, so print it as data. */
  detail: string;
}

/** Require the branch to be exactly `release/v<version>` for a plain X.Y.Z version. */
export function assertReleaseBranchName(branch: string, version: string): void {
  if (!VERSION.test(version) || !BRANCH.test(branch) || branch !== `release/v${version}`)
    throw Error(`The release branch must be exactly release/v<version>; got "${branch}".`);
}

/**
 * Require `GET /repos/{repo}/branches/{branch}` to name this branch with a tip
 * equal to both the local release commit and the SHA QA and the PM named.
 */
export function assertReleaseBranchTip(
  value: unknown,
  branch: string,
  head: string,
  expected: string
): void {
  if (!SHA.test(head) || !SHA.test(expected))
    throw Error('The release commit and the expected SHA must be full 40-character SHAs.');
  if (
    !isRecord(value) ||
    value.name !== branch ||
    !isRecord(value.commit) ||
    typeof value.commit.sha !== 'string' ||
    !SHA.test(value.commit.sha)
  )
    throw Error(`The trusted tip of ${branch} is unavailable.`);
  if (value.commit.sha !== head)
    throw Error(`The release commit ${head} is not the current tip of ${branch}.`);
  if (head !== expected)
    throw Error(
      `The tip of ${branch} is ${head}, not ${expected}, the SHA QA and the PM named. A commit landed after their OK; check and name the new head first.`
    );
}

/** Routine mode: the branch's merge-base with main must be QA's pin. */
export function assertRoutineBase(mergeBase: string, pin: string): void {
  if (!SHA.test(mergeBase) || !SHA.test(pin) || mergeBase !== pin)
    throw Error(
      `The release branch was cut at ${mergeBase || 'an unknown commit'}, not at QA's pin ${pin}.`
    );
}

/** Hotfix mode: the base tag must be `v<X.Y.(Z-1)>` for release X.Y.Z. */
export function assertHotfixBaseTag(baseTag: string, version: string): void {
  const base = parseVersion(/^v(.+)$/.exec(baseTag)?.[1] ?? '');
  const release = parseVersion(version);
  if (
    !base ||
    !release ||
    base[0] !== release[0] ||
    base[1] !== release[1] ||
    base[2] !== release[2] - 1
  )
    throw Error(
      `A hotfix for ${version} must start from the previous patch tag; got "${baseTag}".`
    );
}

/**
 * Resolve a tag to its commit from `GET /repos/{repo}/git/ref/tags/{tag}` and,
 * for an annotated tag, `GET /repos/{repo}/git/tags/{sha}`.
 */
export function resolveTagCommit(tag: string, ref: unknown, annotated?: unknown): string {
  const fail = () => Error(`The published tag ${tag} could not be resolved to a commit.`);
  if (
    !isRecord(ref) ||
    ref.ref !== `refs/tags/${tag}` ||
    !isRecord(ref.object) ||
    typeof ref.object.sha !== 'string' ||
    !SHA.test(ref.object.sha)
  )
    throw fail();
  if (ref.object.type === 'commit') return ref.object.sha;
  if (
    ref.object.type !== 'tag' ||
    !isRecord(annotated) ||
    annotated.sha !== ref.object.sha ||
    annotated.tag !== tag ||
    !isRecord(annotated.object) ||
    annotated.object.type !== 'commit' ||
    typeof annotated.object.sha !== 'string' ||
    !SHA.test(annotated.object.sha)
  )
    throw fail();
  return annotated.object.sha;
}

/** Require `npm view dorkos@<version> version --json` to answer exactly that version. */
export function assertVersionOnNpm(npmView: string, version: string): void {
  let value: unknown;
  try {
    value = JSON.parse(npmView);
  } catch {
    value = undefined;
  }
  if (value !== version)
    throw Error(`dorkos@${version} is not on npm, so it is not a published base.`);
}

/**
 * Require `GET /repos/{base}...{head}` (GitHub compare) to prove `base` is an
 * ancestor of `head`: the head is ahead (or equal) and never behind.
 */
export function assertBaseIsAncestor(base: string, head: string, value: unknown): void {
  if (
    !SHA.test(base) ||
    !SHA.test(head) ||
    !isRecord(value) ||
    !isRecord(value.base_commit) ||
    !isRecord(value.merge_base_commit) ||
    value.base_commit.sha !== base ||
    value.merge_base_commit.sha !== base ||
    value.behind_by !== 0 ||
    !(value.status === 'ahead' || (value.status === 'identical' && base === head))
  )
    throw Error(`The release commit ${head} does not descend from its base ${base}.`);
}

/** Every rule break in `<base>..<head>`; an empty list is a pass. */
export function checkReleaseCherryPicks(input: CherryPickInput): CherryPickFinding[] {
  if (!input.commits.length && !input.allowEmpty)
    return [
      { sha: '', code: 'no-commits', detail: 'no commits after the cut, so nothing to check' },
    ];
  const findings: CherryPickFinding[] = [];
  for (const commit of input.commits) {
    const problem = commitProblem(commit, input);
    if (problem) findings.push({ sha: commit.sha, code: problem[0], detail: problem[1] });
  }
  return findings;
}

/** Throw a readable error naming every commit that breaks the cherry-pick rule. */
export function assertReleaseCherryPicks(input: CherryPickInput): void {
  const findings = checkReleaseCherryPicks(input);
  if (findings.length)
    throw Error(
      'Only cherry-picks of commits on main, plus the release commit, may ship from a release branch:\n' +
        findings
          .map((f) => `  ${f.sha.slice(0, 12) || '(none)'} [${f.code}]: ${f.detail.slice(0, 200)}`)
          .join('\n')
    );
}

/** The publish-log block: what is shipping, from which base, on which branch. */
export function formatReleaseBranchLog(input: {
  mode: ReleaseBranchMode;
  base: string;
  baseLabel: string;
  branch: string;
  head: string;
  diffStat: string;
  log: string;
}): string {
  return [
    `Release branch publish (${input.mode})`,
    `  branch: ${input.branch}`,
    `  head:   ${input.head}`,
    `  base:   ${input.baseLabel} (${input.base})`,
    `git diff --stat ${input.base}..${input.head}`,
    input.diffStat || '  (no changes)',
    `git log --oneline ${input.base}..${input.head}`,
    input.log || '  (no commits)',
  ].join('\n');
}

function commitProblem(
  commit: ReleaseBranchCommit,
  input: CherryPickInput
): [CherryPickCode, string] | undefined {
  if (!SHA.test(commit.sha)) return ['bad-sha', 'not a full commit SHA'];
  if (commit.parents.length !== 1)
    return ['not-linear', 'a merge or root commit; the branch must be linear'];
  const picks = commit.message
    .split('\n')
    .map((line) => PICK_LINE.exec(line.trim())?.[1])
    .filter((sha): sha is string => !!sha);
  if (picks.length > 1) return ['multiple-sources', 'names more than one cherry-picked source'];
  if (picks.length === 1) {
    const source = picks[0];
    if (!input.isMainAncestor(source))
      return ['source-not-on-main', `its source ${source.slice(0, 12)} is not on main`];
    const expected = input.patchIdOf(source);
    if (!expected || !commit.patchId || expected !== commit.patchId)
      return [
        'patch-id-mismatch',
        `its change differs from ${source.slice(0, 12)} on main (patch-id mismatch)`,
      ];
    return undefined;
  }
  // Told apart from a stray file so an alarm can say "a workflow or tool file
  // changed on a release branch" (Security M1, M3).
  const forbidden = commit.files.find((file) => FORBIDDEN_PATH.test(file.path));
  if (forbidden)
    return [
      'release-commit-forbidden-path',
      `not a cherry-pick, and ${forbidden.path} is a workflow, tool or lockfile path`,
    ];
  const pkgJson = commit.files.find(
    (file) => PACKAGE_FILES.has(file.path) && !isReleaseFileChange(file, input.version)
  );
  if (pkgJson)
    return [
      'release-commit-package-json',
      `not a cherry-pick, and ${pkgJson.path} changes more than its version`,
    ];
  const stray = commit.files.find((file) => !isReleaseFileChange(file, input.version));
  if (stray)
    return ['non-release-file', `not a cherry-pick, and ${stray.path} is not a release file`];
  if (!commit.files.length) return ['empty-commit', 'not a cherry-pick, and it changes nothing'];
  return undefined;
}

// Never part of a release commit, even where another rule would match.
const FORBIDDEN_PATH =
  /^(\.github\/|\.claude\/|\.agents\/|\.husky\/|patches\/|scripts\/|(apps|packages)\/[^/]+\/scripts\/|lefthook\.yml$|turbo\.json$|\.gitattributes$|\.nvmrc$|\.node-version$)|(^|\/)(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.c?m?js)$/;
const PACKAGE_FILES = new Set([
  'package.json',
  'packages/cli/package.json',
  'packages/cloud-api/package.json',
  'packages/connector-providers/package.json',
  'apps/desktop/package.json',
]);
const NOTES_FILES = new Set(['CHANGELOG.md', 'docs/changelog.mdx', 'docs/changelog-archive.mdx']);

function isReleaseFileChange(file: ReleaseBranchFile, version: string): boolean {
  const { path, status } = file;
  if (NOTES_FILES.has(path)) return status === 'M';
  if (path === 'VERSION') return status === 'M' && file.after?.trim() === version;
  if (PACKAGE_FILES.has(path)) return status === 'M' && onlyVersionChanged(file, version);
  if (/^changelog\/unreleased\/[^/]+\.md$/.test(path)) return status === 'D';
  // Every release renames the rolling archive (…-to-v<previous>.md) by delete and add.
  if (/^changelog\/archive\/CHANGELOG-v0\.1\.0-to-v\d+\.\d+\.\d+\.md$/.test(path))
    return status === 'D' || status === 'A';
  if (path === `blog/dorkos-${version.replaceAll('.', '-')}.mdx`)
    return status === 'A' || status === 'M';
  if (path.startsWith(`apps/site/public/product/archive/v${version}/`) && !path.includes('/../'))
    return status === 'A';
  return false;
}

function onlyVersionChanged(file: ReleaseBranchFile, version: string): boolean {
  try {
    const before: unknown = JSON.parse(file.before ?? '');
    const after: unknown = JSON.parse(file.after ?? '');
    if (!isRecord(before) || !isRecord(after) || after.version !== version) return false;
    const strip = (value: Record<string, unknown>) =>
      JSON.stringify({ ...value, version: undefined });
    return strip(before) === strip(after);
  } catch {
    return false;
  }
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = VERSION.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

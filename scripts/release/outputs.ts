/**
 * The release's text outputs beside the changed files: the GitHub release
 * notes, the release PR body, and the list of `feat`/`fix` commits no fragment
 * covers (release.md Check 5, which the daily release lists instead of asking).
 *
 * @module scripts/release/outputs
 */
import { REPO_URL, type CompiledSection } from './changelog.ts';
import { ReleaseCommitError } from './errors.ts';
import type { BumpDecision, Fragment } from './fragments.ts';
import { backtickMentions } from './markdown.ts';

/** One commit in `v<previous>..P`, as the workflow lists it (`<sha> <subject>`). */
export interface ListedCommit {
  /** The commit SHA, 7 to 40 hex characters. */
  sha: string;
  /** Its subject line. */
  subject: string;
}

const COMMIT_LINE = /^([0-9a-f]{7,40}) (.+)$/;
const USER_FACING = /^(feat|fix)(\([^)]*\))?!?: /;
const PR_SUFFIX = / \(#\d+\)$/;

/** Parse the `--commits` file: one `<sha> <subject>` per line, blank lines ignored. */
export function parseCommitList(text: string): ListedCommit[] {
  return text.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    const match = COMMIT_LINE.exec(line.trimEnd());
    if (!match?.[1] || !match[2])
      throw new ReleaseCommitError(
        `--commits line ${index + 1} is not "<sha> <subject>": ${JSON.stringify(line.slice(0, 80))}`
      );
    return [{ sha: match[1], subject: match[2] }];
  });
}

/**
 * The `feat` and `fix` commits no fragment's `covers:` names. A claim matches
 * a commit by its subject (a squash merge's trailing ` (#N)` ignored on both
 * sides), by a SHA prefix, or by `#N` for the PR number in the subject. The
 * PR check's word-comparison fallback is not repeated here, so this list errs
 * towards naming a commit; the weekly pass decides what it needs.
 */
export function unfragmentedCommits(
  commits: readonly ListedCommit[],
  fragments: readonly Fragment[]
): ListedCommit[] {
  const claims = fragments.flatMap((fragment) => fragment.covers);
  return commits.filter(
    (commit) => USER_FACING.test(commit.subject) && !claims.some((claim) => covers(claim, commit))
  );
}

/**
 * The GitHub release notes: the version's `CHANGELOG.md` section body
 * verbatim, then the update line and the compare link (release.md 6.11; the
 * theme and highlights moved to the weekly post).
 */
export function renderNotes(section: CompiledSection, previous: string, version: string): string {
  return [
    ...section.body,
    '',
    '## Update',
    '',
    '```bash',
    'npm update -g dorkos',
    '```',
    '',
    `**Every change:** ${REPO_URL}/compare/v${previous}...v${version}`,
    '',
  ].join('\n');
}

/** The release PR body: what this release is, and the commits with no changelog entry. */
export function renderPrBody(input: {
  decision: BumpDecision;
  previous: string;
  fragments: readonly Fragment[];
  unfragmented: readonly ListedCommit[];
}): string {
  const { decision, previous, fragments, unfragmented } = input;
  const lines = [
    `Release v${decision.version}, compiled from ${fragments.length} changelog ${fragments.length === 1 ? 'fragment' : 'fragments'} by \`scripts/release/release-commit.ts\`.`,
    '',
    `- Version: ${previous} to ${decision.version} (${decision.bump}: ${decision.reason})`,
    `- Breaking: ${decision.breaking ? 'yes, called out at the top of the notes' : 'no'}`,
    '',
    '## Commits with no changelog entry',
    '',
  ];
  if (!unfragmented.length) lines.push('None.');
  else {
    lines.push(
      `These \`feat\` and \`fix\` commits since v${previous} have no fragment. The weekly pass backfills any a user would notice.`,
      ''
    );
    lines.push(
      ...backtickMentions(
        unfragmented.map((commit) => `- ${commit.sha.slice(0, 10)} ${commit.subject}`)
      )
    );
  }
  lines.push('');
  return lines.join('\n');
}

function covers(claim: string, commit: ListedCommit): boolean {
  if (/^[0-9a-f]{7,40}$/.test(claim))
    return commit.sha.startsWith(claim) || claim.startsWith(commit.sha);
  const pr = /^#(\d+)$/.exec(claim)?.[1];
  if (pr) return commit.subject.endsWith(` (#${pr})`);
  return claim.replace(PR_SUFFIX, '') === commit.subject.replace(PR_SUFFIX, '');
}

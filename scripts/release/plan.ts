/**
 * Build the release commit as a plan: every file it changes, before and after,
 * plus the notes and PR body. Pure over a {@link RepoReader}: it reads the
 * release point's files as data, never imports, installs or runs anything from
 * it, and never reads the clock or the network. Same inputs, same bytes.
 *
 * Before a plan is returned it is fed to `checkReleaseCherryPicks`, the rule
 * behind the `release-branch-contents` check, as the one commit
 * `chore(release): v<X.Y.Z>`. A plan that rule would refuse is never returned.
 *
 * @module scripts/release/plan
 */
import {
  checkReleaseCherryPicks,
  type CherryPickFinding,
  type ReleaseBranchFile,
} from '../../packages/cli/scripts/release-branch/rules.ts';
import {
  ARCHIVE_FILE,
  applyCap,
  compileSection,
  insertSection,
  versionHeadings,
  type CompiledSection,
} from './changelog.ts';
import { DOCS_ARCHIVE, DOCS_CHANGELOG, syncDocsChangelog } from './docs-changelog.ts';
import { ReleaseCommitError } from './errors.ts';
import { decideBump, parseFragments, parseVersion, type BumpDecision } from './fragments.ts';
import { findMentions } from './markdown.ts';
import {
  parseCommitList,
  renderNotes,
  renderPrBody,
  unfragmentedCommits,
  type ListedCommit,
} from './outputs.ts';
import {
  API_DOCUMENT,
  PACKAGE_FILES,
  bumpApiDocument,
  bumpPackageJson,
  bumpVersionFile,
} from './version-files.ts';

/** Read-only access to the release point's checkout. */
export interface RepoReader {
  /** A file's text; throws when the file is missing. */
  read(path: string): string;
  /** The entries of a directory, sorted; a subdirectory's name ends with `/`. */
  list(path: string): string[];
}

/** One file the release commit changes. */
export interface PlannedChange {
  /** The repo-relative path. */
  path: string;
  /** Added, modified or deleted. */
  status: 'A' | 'M' | 'D';
  /** The file at the release point; absent when added. */
  before?: string;
  /** The file in the release commit; absent when deleted. */
  after?: string;
}

/** Everything the release commit is, before anything is written or committed. */
export interface ReleasePlan {
  /** The version being released. */
  version: string;
  /** The last released version. */
  previous: string;
  /** The release date, `YYYY-MM-DD`, exactly as given. */
  date: string;
  /** How the version was chosen, and whether it is a breaking release. */
  decision: BumpDecision;
  /** The fragment files compiled into this release, in order. */
  fragments: string[];
  /** Every changed file, sorted by path. */
  changes: PlannedChange[];
  /** The new `CHANGELOG.md` section. */
  section: CompiledSection;
  /** The GitHub release notes. */
  notes: string;
  /** The release PR body. */
  prBody: string;
  /** `feat`/`fix` commits since the last release with no fragment. */
  unfragmented: ListedCommit[];
}

/** What a release plan is built from. */
export interface PlanInput {
  /** The release point's checkout. */
  reader: RepoReader;
  /** The last released version. */
  previous: string;
  /** The release date, `YYYY-MM-DD`; never defaulted from the clock. */
  date: string;
  /** An explicit version, which must be greater than `previous`. */
  version?: string;
  /** The `--commits` file's text: `<sha> <subject>` for each commit since the last tag. */
  commits?: string;
}

/** The release commit's subject, which the cherry-pick rule pins. */
export function releaseSubject(version: string): string {
  return `chore(release): v${version}`;
}

/** Build the plan, or throw {@link ReleaseCommitError} saying why this point cannot ship. */
export function buildReleasePlan(input: PlanInput): ReleasePlan {
  const { reader, previous, date } = input;
  parseVersion(previous, '--previous');
  assertDate(date);
  const names = reader.list('changelog/unreleased');
  const fragments = parseFragments(
    names.map((name) => ({
      name,
      text: name.endsWith('/') ? '' : reader.read(`changelog/unreleased/${name}`),
    }))
  );
  const decision = decideBump(fragments, previous, input.version);
  const { version } = decision;
  const changes: PlannedChange[] = [];
  const modify = (path: string, edit: (text: string) => string) => {
    const before = reader.read(path);
    changes.push({ path, status: 'M', before, after: edit(before) });
  };

  modify('VERSION', (text) => bumpVersionFile(text, previous, version));
  for (const path of PACKAGE_FILES)
    modify(path, (text) => bumpPackageJson(path, text, previous, version));
  modify(API_DOCUMENT, (text) => bumpApiDocument(text, previous, version));

  const section = compileSection(fragments, version, date, decision.breaking);
  const archives = reader.list('changelog/archive').filter((name) => ARCHIVE_FILE.test(name));
  if (archives.length !== 1)
    throw new ReleaseCommitError(
      `changelog/archive/ must hold exactly one CHANGELOG-v0.1.0-to-vX.Y.Z.md; found ${archives.length}.`
    );
  const archivePath = `changelog/archive/${archives[0]}`;
  const archiveText = reader.read(archivePath);
  const changelogBefore = reader.read('CHANGELOG.md');
  const cap = applyCap(insertSection(changelogBefore, section, previous, version), {
    path: archivePath,
    text: archiveText,
  });
  changes.push({
    path: 'CHANGELOG.md',
    status: 'M',
    before: changelogBefore,
    after: cap.changelog,
  });
  if (cap.archive) {
    changes.push({ path: cap.archive.fromPath, status: 'D', before: archiveText });
    changes.push({ path: cap.archive.toPath, status: 'A', after: cap.archive.text });
  }

  const pageBefore = reader.read(DOCS_CHANGELOG);
  const docsArchiveBefore = reader.read(DOCS_ARCHIVE);
  const docs = syncDocsChangelog({
    page: pageBefore,
    archive: docsArchiveBefore,
    section,
    aged: cap.aged,
    oldUpper: cap.oldUpper,
    newUpper: cap.newUpper,
    retained: versionHeadings(cap.changelog.split('\n')).map((heading) => heading.version),
  });
  changes.push({ path: DOCS_CHANGELOG, status: 'M', before: pageBefore, after: docs.page });
  if (docs.archive !== docsArchiveBefore)
    changes.push({
      path: DOCS_ARCHIVE,
      status: 'M',
      before: docsArchiveBefore,
      after: docs.archive,
    });

  for (const fragment of fragments)
    changes.push({
      path: `changelog/unreleased/${fragment.file}`,
      status: 'D',
      before: reader.read(`changelog/unreleased/${fragment.file}`),
    });
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const unfragmented = unfragmentedCommits(parseCommitList(input.commits ?? ''), fragments);
  const plan: ReleasePlan = {
    version,
    previous,
    date,
    decision,
    fragments: fragments.map((fragment) => fragment.file),
    changes,
    section,
    notes: renderNotes(section, previous, version),
    prBody: renderPrBody({ decision, previous, fragments, unfragmented }),
    unfragmented,
  };
  // The compile already backticked every handle; this guards the guard, since
  // GitHub pings a bare one the moment the notes or the PR body are posted.
  const pings = findMentions([...plan.notes.split('\n'), ...plan.prBody.split('\n')]);
  if (pings.length)
    throw new ReleaseCommitError(`The notes would ping ${pings.join(', ')} on GitHub.`);
  assertSelfCheck(plan);
  return plan;
}

/**
 * Run the plan through `checkReleaseCherryPicks` as the single release commit
 * it will be. Nothing in a release commit is a pick, so the main-history
 * callbacks are never consulted; they answer "no" to fail closed if they were.
 */
export function selfCheck(plan: Pick<ReleasePlan, 'version' | 'changes'>): CherryPickFinding[] {
  const files: ReleaseBranchFile[] = plan.changes.map((change) => ({
    path: change.path,
    status: change.status,
    ...(change.before === undefined ? {} : { before: change.before }),
    ...(change.after === undefined ? {} : { after: change.after }),
  }));
  return checkReleaseCherryPicks({
    version: plan.version,
    commits: [
      {
        sha: 'f'.repeat(40),
        parents: ['e'.repeat(40)],
        message: `${releaseSubject(plan.version)}\n`,
        patchId: undefined,
        files,
      },
    ],
    isMainAncestor: () => false,
    patchIdOf: () => undefined,
    isInBase: () => false,
    isRevertedOnMain: () => false,
  });
}

/** Throw unless {@link selfCheck} passes. */
export function assertSelfCheck(plan: Pick<ReleasePlan, 'version' | 'changes'>): void {
  const findings = selfCheck(plan);
  if (findings.length)
    throw new ReleaseCommitError(
      'The release commit would fail release-branch-contents:\n' +
        findings.map((finding) => `  [${finding.code}] ${finding.detail}`).join('\n')
    );
}

/** The plan as `plan.json`: no file contents, stable key order, trailing newline. */
export function planJson(plan: ReleasePlan): string {
  return (
    JSON.stringify(
      {
        version: plan.version,
        previous: plan.previous,
        date: plan.date,
        bump: plan.decision.bump,
        bumpReason: plan.decision.reason,
        breaking: plan.decision.breaking,
        subject: releaseSubject(plan.version),
        fragments: plan.fragments,
        files: plan.changes.map((change) => ({ path: change.path, status: change.status })),
        unfragmentedCommits: plan.unfragmented.map(({ sha, subject }) => ({ sha, subject })),
      },
      null,
      2
    ) + '\n'
  );
}

function assertDate(date: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [year, month, day] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [];
  const real =
    year !== undefined &&
    month !== undefined &&
    day !== undefined &&
    new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === date;
  if (!real) throw new ReleaseCommitError(`--date must be a real YYYY-MM-DD date; got "${date}".`);
}

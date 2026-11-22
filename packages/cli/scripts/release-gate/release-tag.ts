/**
 * Tag a release, only at the exact tree QA said GO on (DOR-5050). Replaces the
 * hand-typed `git tag` + `git push` of `/system:release` 6.9:
 *
 *   pnpm release:tag <X.Y.Z> <merged-squash-sha> [--qa-go-ledger <path>]
 *
 * Refuses, before anything is tagged, a malformed version or SHA, a commit
 * whose VERSION is not the version, a tag that already exists here or on the
 * remote, and anything {@link checkQaGo} refuses.
 */
import { execFileSync } from 'node:child_process';
import { runIfMain } from '../release-branch/entry.ts';
import { checkQaGo, qaGoLedgerPath, QaGoRefusal, takeQaGoLedgerFlag } from './qa-go.ts';

/** What {@link releaseTag} tags. */
export interface ReleaseTagRequest {
  /** The release version, `X.Y.Z`. */
  version: string;
  /** The full SHA of the merged release commit. */
  sha: string;
  /** QA's ledger file. */
  ledgerPath: string;
  /** The repository to tag in. */
  cwd: string;
  /** The remote to push the tag to. */
  remote?: string;
}

/**
 * Check QA's GO for the exact commit, then create the annotated tag and push
 * it. Returns the PASS line and what was pushed.
 *
 * @param request - The version, commit, ledger and repository.
 */
export function releaseTag(request: ReleaseTagRequest): string[] {
  const { version, sha, ledgerPath, cwd, remote = 'origin' } = request;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new QaGoRefusal(`"${version}" is not a release version (X.Y.Z).`);
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new QaGoRefusal(`"${sha}" is not a full 40-hex commit SHA.`);
  const tag = `v${version}`;
  let declared: string;
  try {
    declared = git('show', `${sha}:VERSION`);
  } catch {
    throw new QaGoRefusal(`${sha} has no VERSION file here, so it is not a release commit.`);
  }
  if (declared !== version) throw new QaGoRefusal(`${sha} is version ${declared}, not ${version}.`);
  if (git('tag', '--list', tag))
    throw new QaGoRefusal(`${tag} already exists here. Never move a release tag.`);
  if (git('ls-remote', '--tags', remote, `refs/tags/${tag}`))
    throw new QaGoRefusal(`${tag} already exists on ${remote}. Never move a release tag.`);
  const pass = checkQaGo({ ledgerPath, version, target: sha, cwd });
  git('tag', '-a', tag, '-m', `Release ${tag}`, sha);
  try {
    git('push', remote, `refs/tags/${tag}`);
  } catch (error) {
    // Unpushed, the local tag would make the retry refuse as "already exists".
    git('tag', '-d', tag);
    throw error;
  }
  return [pass, `Tagged ${tag} at ${sha} and pushed it to ${remote}.`];
}

/** Parse `<version> <sha> [--qa-go-ledger <path>]`. */
export function parseReleaseTagArgs(argv: string[]): {
  version: string;
  sha: string;
  ledger: string | undefined;
} {
  const { ledger, rest } = takeQaGoLedgerFlag(argv);
  if (rest.length !== 2)
    throw new QaGoRefusal('Usage: pnpm release:tag <X.Y.Z> <sha> [--qa-go-ledger <path>]');
  return { version: rest[0]!, sha: rest[1]!, ledger };
}

runIfMain(import.meta.url, () => {
  const args = parseReleaseTagArgs(process.argv.slice(2));
  for (const line of releaseTag({
    version: args.version,
    sha: args.sha,
    ledgerPath: qaGoLedgerPath(args.ledger),
    cwd: process.cwd(),
  }))
    console.log(line);
});

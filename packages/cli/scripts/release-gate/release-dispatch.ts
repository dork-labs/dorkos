/**
 * Start a release-branch publish, only at the exact tree QA said GO on
 * (DOR-5050). The Release Publish workflow runs on GitHub, where QA's ledger
 * cannot be read, so the GO is checked here, at the one local step that starts
 * it:
 *
 *   pnpm release:dispatch <X.Y.Z> <expected-sha> <base-sha> [--qa-go-ledger <path>]
 *
 * Routine mode only: hotfix publishing is off in the workflow itself.
 */
import { execFileSync } from 'node:child_process';
import { runIfMain } from '../release-branch/entry.ts';
import { checkQaGo, qaGoLedgerPath, QaGoRefusal, takeQaGoLedgerFlag } from './qa-go.ts';

/** What {@link releaseDispatch} starts. */
export interface ReleaseDispatchRequest {
  /** The release version, `X.Y.Z` (the branch is `release/vX.Y.Z`). */
  version: string;
  /** The full SHA QA and the PM named: the branch tip must equal it. */
  expectedSha: string;
  /** QA's full pin SHA on main, the routine base. */
  base: string;
  /** QA's ledger file. */
  ledgerPath: string;
  /** The repository to resolve the SHAs in. */
  cwd: string;
}

/**
 * Check QA's GO for the exact expected tip, then dispatch Release Publish on
 * main with the same values. Returns the PASS line.
 *
 * @param request - The version, SHAs, ledger and repository.
 * @param gh - Runs `gh` with these arguments; the real CLI by default.
 */
export function releaseDispatch(
  request: ReleaseDispatchRequest,
  gh: (args: string[]) => void = (args) => {
    execFileSync('gh', args, { cwd: request.cwd, stdio: 'inherit' });
  }
): string {
  const { version, expectedSha, base, ledgerPath, cwd } = request;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new QaGoRefusal(`"${version}" is not a release version (X.Y.Z).`);
  for (const sha of [expectedSha, base])
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new QaGoRefusal(`"${sha}" is not a full 40-hex commit SHA.`);
  const pass = checkQaGo({ ledgerPath, version, target: expectedSha, cwd });
  gh([
    'workflow',
    'run',
    'release-publish.yml',
    '--ref',
    'main',
    '-f',
    `version=${version}`,
    '-f',
    `expected_sha=${expectedSha}`,
    '-f',
    'mode=routine',
    '-f',
    `base=${base}`,
  ]);
  return pass;
}

runIfMain(import.meta.url, () => {
  const { ledger, rest } = takeQaGoLedgerFlag(process.argv.slice(2));
  if (rest.length !== 3)
    throw new QaGoRefusal(
      'Usage: pnpm release:dispatch <X.Y.Z> <expected-sha> <base-sha> [--qa-go-ledger <path>]'
    );
  console.log(
    releaseDispatch({
      version: rest[0]!,
      expectedSha: rest[1]!,
      base: rest[2]!,
      ledgerPath: qaGoLedgerPath(ledger),
      cwd: process.cwd(),
    })
  );
});

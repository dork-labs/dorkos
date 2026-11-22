/**
 * Publish one of the release's other npm packages (`@dork-labs/cloud-api`,
 * `@dork-labs/connector-providers`), only from the exact release tag and only
 * at the tree QA said GO on (DOR-5050), the same gate `publish:cli` runs:
 *
 *   tsx publish-package.ts <@dork-labs/name> [--qa-go-ledger <path>]
 *
 * The release version is the checkout's VERSION, and HEAD must be its `vX.Y.Z`
 * tag. Then `pnpm publish --filter <name>` runs with pnpm's own checks.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIfMain } from '../release-branch/entry.ts';
import { checkQaGo, qaGoLedgerPath, QaGoRefusal, takeQaGoLedgerFlag } from './qa-go.ts';

/** The packages this step may publish. */
export const RELEASE_PACKAGES = ['@dork-labs/cloud-api', '@dork-labs/connector-providers'];

/**
 * Check that HEAD is the release tag and QA's GO covers its tree. Returns the
 * PASS line; throws {@link QaGoRefusal} otherwise.
 *
 * @param name - The package to publish.
 * @param ledgerPath - QA's ledger file.
 * @param cwd - The release checkout.
 */
export function checkPackagePublish(name: string, ledgerPath: string, cwd: string): string {
  if (!RELEASE_PACKAGES.includes(name))
    throw new QaGoRefusal(`${name} is not one of ${RELEASE_PACKAGES.join(', ')}.`);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  if (git('status', '--porcelain'))
    throw new QaGoRefusal(
      'The release checkout has changes. Publish only a clean checkout of the tag.'
    );
  const version = readFileSync(join(cwd, 'VERSION'), 'utf8').trim();
  const head = git('rev-parse', 'HEAD');
  let tagged: string;
  try {
    tagged = git('rev-parse', '--verify', `v${version}^{commit}`);
  } catch {
    throw new QaGoRefusal(`v${version} is not tagged here. Tag it with pnpm release:tag first.`);
  }
  if (tagged !== head)
    throw new QaGoRefusal(`HEAD ${head} is not v${version} (${tagged}). Publish from the tag.`);
  return checkQaGo({ ledgerPath, version, target: head, cwd });
}

/**
 * Check, then publish with pnpm's own checks. Returns the PASS line.
 *
 * @param name - The package to publish.
 * @param ledgerPath - QA's ledger file.
 * @param cwd - The release checkout.
 * @param pnpm - Runs `pnpm` with these arguments; the real CLI by default.
 */
export function publishPackage(
  name: string,
  ledgerPath: string,
  cwd: string,
  pnpm: (args: string[]) => void = (args) => {
    execFileSync('pnpm', args, { cwd, stdio: 'inherit' });
  }
): string {
  const pass = checkPackagePublish(name, ledgerPath, cwd);
  pnpm(['publish', `--filter=${name}`]);
  return pass;
}

runIfMain(import.meta.url, () => {
  const { ledger, rest } = takeQaGoLedgerFlag(process.argv.slice(2));
  if (rest.length !== 1) throw new QaGoRefusal('Usage: publish-package.ts <@dork-labs/name>');
  console.log(publishPackage(rest[0]!, qaGoLedgerPath(ledger), process.cwd()));
});

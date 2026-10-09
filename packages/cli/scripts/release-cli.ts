import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, readFile, mkdir, readdir, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
/** This release command currently ships an unavailable VM. A candidate release
 * object cannot substitute a genuine publisher selection transaction. */
export function assertCLIUnselectedVMRelease(value: unknown): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'release,v' ||
    !('v' in value) ||
    value.v !== 1 ||
    !('release' in value) ||
    value.release !== null
  )
    throw Error(
      'The CLI browser VM release is not qualified. Keep the fixed release selection empty.'
    );
}
async function readUnselectedVMRelease(): Promise<unknown> {
  const file = await open(
    join(root, 'scripts/browser-vm-release.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  let first: { value: unknown } | undefined;
  let value: unknown;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 4096)
      throw Error('CLI_RELEASE_SELECTION_FILE');
    const bytes = Buffer.alloc(4097);
    const result = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (
      result.bytesRead !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error('CLI_RELEASE_SELECTION_CHANGED');
    value = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'));
  } catch (failure) {
    first = { value: failure };
  }
  try {
    await file.close();
  } catch (failure) {
    first ??= { value: failure };
  }
  if (first) throw first.value;
  return value;
}
/** Require the requested version and current source to match the exact release tag. */
export function assertCLIReleaseBinding(
  version: string,
  rootVersion: string,
  head: string,
  tagged: string
) {
  if (
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) ||
    version !== rootVersion ||
    !/^[a-f0-9]{40}$/.test(head) ||
    head !== tagged
  )
    throw Error('The CLI release must be the clean, exact merged version tag.');
}
/** Exact original GitHub comparison must prove release HEAD is an ancestor of
 * the freshly resolved trusted repository's default main branch. Local tags do not. */
export function assertCLIMergedRelease(
  head: string,
  main: string,
  comparisonUrl: string,
  value: unknown
) {
  const record = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  if (
    !/^[a-f0-9]{40}$/.test(head) ||
    !/^[a-f0-9]{40}$/.test(main) ||
    !record(value) ||
    !record(value.base_commit) ||
    !record(value.merge_base_commit) ||
    value.base_commit.sha !== head ||
    value.url !== comparisonUrl ||
    !comparisonUrl.endsWith(`/compare/${head}...${main}`) ||
    !Number.isSafeInteger(value.ahead_by) ||
    !Number.isSafeInteger(value.total_commits) ||
    value.behind_by !== 0 ||
    value.ahead_by !== value.total_commits ||
    (value.status === 'identical'
      ? value.ahead_by !== 0
      : !(typeof value.ahead_by === 'number' && value.ahead_by > 0)) ||
    value.merge_base_commit.sha !== head ||
    (value.status !== 'ahead' && value.status !== 'identical') ||
    (value.status === 'identical' ? main !== head : main === head)
  )
    throw Error('This release commit is not proven merged into the current trusted main branch.');
}
function output(command: string, args: string[]) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}
function clean() {
  if (output('git', ['status', '--porcelain']))
    throw Error('Commit the release checkout changes before preparing or publishing the CLI.');
}
/** Explicit release command only. The normal build/prepublish copier preserves
 * the fixed empty VM selection. No obsolete observer producer is dispatched. */
export async function releaseCLI(publish: boolean) {
  assertCLIUnselectedVMRelease(await readUnselectedVMRelease());
  clean();
  const head = output('git', ['rev-parse', 'HEAD']);
  const pkg = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8')) as {
    version: string;
  };
  const tag = 'v' + pkg.version;
  assertCLIReleaseBinding(
    pkg.version,
    (await readFile(join(root, 'VERSION'), 'utf8')).trim(),
    head,
    output('git', ['rev-parse', tag + '^{commit}'])
  );
  const repository = output('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error('The release repository could not be confirmed.');
  const proveMerged = () => {
    const repo: unknown = JSON.parse(output('gh', ['api', `repos/${repository}`]));
    if (
      !repo ||
      typeof repo !== 'object' ||
      !('full_name' in repo) ||
      repo.full_name !== repository ||
      !('default_branch' in repo) ||
      repo.default_branch !== 'main'
    )
      throw Error('The trusted release repository default main branch is unavailable.');
    const branch: unknown = JSON.parse(output('gh', ['api', `repos/${repository}/branches/main`]));
    if (
      !branch ||
      typeof branch !== 'object' ||
      !('name' in branch) ||
      branch.name !== 'main' ||
      !('commit' in branch) ||
      !branch.commit ||
      typeof branch.commit !== 'object' ||
      !('sha' in branch.commit) ||
      typeof branch.commit.sha !== 'string'
    )
      throw Error('The actual current main commit is unavailable.');
    const main = branch.commit.sha;
    if (!/^[a-f0-9]{40}$/.test(main)) throw Error('The actual current main commit is invalid.');
    assertCLIMergedRelease(
      head,
      main,
      `https://api.github.com/repos/${repository}/compare/${head}...${main}`,
      JSON.parse(output('gh', ['api', `repos/${repository}/compare/${head}...${main}`]))
    );
  };
  proveMerged();
  const retainedDirectory = await mkdtemp(join(tmpdir(), 'dorkos-cli-release-'));
  clean();
  assertCLIReleaseBinding(
    pkg.version,
    (await readFile(join(root, 'VERSION'), 'utf8')).trim(),
    output('git', ['rev-parse', 'HEAD']),
    head
  );
  assertCLIUnselectedVMRelease(await readUnselectedVMRelease());
  proveMerged(); // Refresh trusted ancestry before the original build or publication.
  if (publish) {
    // Existing release authorization is exactly invoking publish:cli; no admin/git-check bypass.
    execFileSync('pnpm', ['publish', '--filter=dorkos'], { cwd: root, stdio: 'inherit' });
  } else {
    execFileSync('pnpm', ['--filter', 'dorkos', 'build'], { cwd: root, stdio: 'inherit' });
    clean();
    if (output('git', ['rev-parse', 'HEAD']) !== head)
      throw Error('Release source changed during the original build.');
    const packed = join(retainedDirectory, 'packed');
    await mkdir(packed);
    proveMerged();
    execFileSync('pnpm', ['pack', '--pack-destination', packed], {
      cwd: join(root, 'packages/cli'),
      stdio: 'inherit',
    });
    const files = await readdir(packed);
    if (files.length !== 1 || !files[0].endsWith('.tgz'))
      throw Error('The original release tarball is missing or ambiguous.');
    const tarball = join(packed, files[0]);
    await writeFile(
      join(retainedDirectory, 'release-receipt.json'),
      JSON.stringify({
        commit: head,
        version: pkg.version,
        browserVM: Object.freeze({ selection: null, available: false, publisherQualified: false }),
        tarball,
        published: false,
      }) + '\n',
      { flag: 'wx' }
    );
    console.log(
      `Prepared ${tarball}; retained original package and receipt at ${retainedDirectory}. Nothing was published.`
    );
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--publish'))
    throw Error('Use release:cli:prepare or the explicit publish:cli command.');
  void releaseCLI(args[0] === '--publish').catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

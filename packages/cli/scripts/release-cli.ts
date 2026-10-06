import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, mkdir, readdir, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBrowserNativeArtifactManifest } from './browser-native-artifact.ts';

const workflow = 'browser-native-release-artifact.yml';
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
interface ProducerRun {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string;
}
/** Run metadata chooses a candidate; exact source/workflow attestation is still mandatory. */
export function selectBrowserNativeArtifactRun(
  runs: readonly ProducerRun[],
  commit: string
): number {
  const originals = runs.filter(
    (run) =>
      run.headSha === commit &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      Number.isSafeInteger(run.databaseId) &&
      run.databaseId > 0
  );
  if (!originals.length)
    throw Error(
      'No successful native browser artifact exists for this exact release commit. Run Browser Native Release Artifact at the release tag, then retry.'
    );
  return originals.reduce((latest, run) => Math.max(latest, run.databaseId), 0);
}
/** Require the requested version and current source to match the exact release tag. */
export function assertBrowserNativeReleaseBinding(
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
export function assertBrowserNativeMergedRelease(
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
/** Called only on successful original gh verification output, after its exact signer/source policy. */
export function assertBrowserNativeArtifactAttestation(value: unknown, pin: string) {
  const record = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || !/^[a-f0-9]{64}$/.test(pin))
    throw Error('The verified native artifact digest is unavailable.');
  const matches = value.some(
    (row: unknown) =>
      record(row) &&
      record(row.verificationResult) &&
      record(row.verificationResult.statement) &&
      Array.isArray(row.verificationResult.statement.subject) &&
      row.verificationResult.statement.subject.some(
        (subject: unknown) =>
          record(subject) && record(subject.digest) && subject.digest.sha256 === pin
      )
  );
  if (!matches)
    throw Error('The original verified attestation did not match these native artifact bytes.');
}
interface NativeDispatchBinding {
  head: string;
  tag: string;
  repository: string;
  workflow: string;
}
/** Resume discovery of an entered original dispatch; never replace an ambiguous attempt. */
export async function retainBrowserNativeDispatch(
  markerPath: string,
  binding: NativeDispatchBinding,
  dispatch: () => void | Promise<void>
): Promise<'entered' | 'retained'> {
  const marker = { version: 1, ...binding, status: 'original-dispatch-entering' };
  try {
    await writeFile(markerPath, JSON.stringify(marker) + '\n', { flag: 'wx' });
  } catch (reason) {
    if (!reason || typeof reason !== 'object' || !('code' in reason) || reason.code !== 'EEXIST')
      throw reason;
    const original = await open(
      markerPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await original.stat();
      if (!before.isFile() || before.size > 4096)
        throw Error('The retained native dispatch record is invalid.', { cause: reason });
      const bytes = Buffer.alloc(before.size + 1);
      const read = await original.read(bytes, 0, bytes.length, 0);
      const after = await original.stat();
      if (
        read.bytesRead !== before.size ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw Error('The retained native dispatch record changed during its original read.', {
          cause: reason,
        });
      const value: unknown = JSON.parse(bytes.subarray(0, read.bytesRead).toString('utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(marker).sort()) ||
        Object.entries(marker).some(
          ([key, expected]) =>
            !Object.prototype.hasOwnProperty.call(value, key) ||
            Reflect.get(value, key) !== expected
        )
      )
        throw Error('The retained native dispatch record does not match this exact release.', {
          cause: reason,
        });
    } finally {
      await original.close();
    }
    return 'retained';
  }
  try {
    await dispatch();
  } catch (reason) {
    throw Error(
      'The original native release dispatch outcome is uncertain. Retry this release command to resume Actions discovery; it will not request another producer. If no run appears, inspect Actions and the retained dispatch record before operator recovery.',
      { cause: reason }
    );
  }
  return 'entered';
}

/** Poll only the entered original producer after an ambiguous or delayed dispatch. */
export async function discoverBrowserNativeProducer(
  markerPath: string,
  binding: NativeDispatchBinding,
  originals: {
    list: () => ProducerRun[];
    admit: () => void;
    dispatch: () => void | Promise<void>;
    wait: () => Promise<void>;
  }
): Promise<ProducerRun[]> {
  let runs = originals.list();
  if (runs.length) return runs;
  // Known admission refusal occurs before the exclusive original dispatch record.
  originals.admit();
  await retainBrowserNativeDispatch(markerPath, binding, originals.dispatch);
  for (let attempt = 0; attempt < 30 && !runs.length; attempt++) {
    await originals.wait();
    runs = originals.list();
  }
  if (!runs.length)
    throw Error(
      'The requested original native release producer is not visible yet. Retry the release command to resume Actions discovery; no second producer was requested. If Actions cannot establish the original outcome, inspect the retained dispatch record at ' +
        markerPath +
        ' before operator recovery.'
    );
  return runs;
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
/** Explicit release command only. Preparation downloads verified originals and builds/packs;
 * --publish retains normal pnpm publication and its normal prepublishOnly/gitrelease checks. */
export async function releaseCLI(publish: boolean) {
  clean();
  const head = output('git', ['rev-parse', 'HEAD']);
  const pkg = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8')) as {
    version: string;
  };
  const tag = 'v' + pkg.version;
  assertBrowserNativeReleaseBinding(
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
    assertBrowserNativeMergedRelease(
      head,
      main,
      `https://api.github.com/repos/${repository}/compare/${head}...${main}`,
      JSON.parse(output('gh', ['api', `repos/${repository}/compare/${head}...${main}`]))
    );
  };
  proveMerged(); // Before any release producer acquisition or dispatch.
  const list = (): ProducerRun[] => {
    const value: unknown = JSON.parse(
      output('gh', [
        'run',
        'list',
        '--repo',
        repository,
        '--workflow',
        workflow,
        '--commit',
        head,
        '--event',
        'workflow_dispatch',
        '--limit',
        '20',
        '--json',
        'databaseId,headSha,status,conclusion',
      ])
    );
    if (!Array.isArray(value) || value.length > 20)
      throw Error('The native browser producer list is invalid.');
    return value as ProducerRun[];
  };
  const markerDirectory = resolve(
    root,
    output('git', ['rev-parse', '--git-common-dir']),
    'browser-native-release'
  );
  await mkdir(markerDirectory, { recursive: true });
  let runs = await discoverBrowserNativeProducer(
    join(markerDirectory, head + '.json'),
    { head, tag, repository, workflow },
    {
      list,
      admit: proveMerged,
      dispatch: () => {
        execFileSync('gh', ['workflow', 'run', workflow, '--repo', repository, '--ref', tag], {
          cwd: root,
          stdio: 'inherit',
        });
      },
      wait: () => new Promise<void>((done) => setTimeout(done, 2000)),
    }
  );
  const newest = runs
    .filter(
      (run) => run.headSha === head && Number.isSafeInteger(run.databaseId) && run.databaseId > 0
    )
    .sort((a, b) => b.databaseId - a.databaseId)[0];
  if (!newest) throw Error('The original native release producer is unavailable.');
  if (newest.status !== 'completed') {
    execFileSync(
      'gh',
      ['run', 'watch', String(newest.databaseId), '--repo', repository, '--exit-status'],
      { cwd: root, stdio: 'inherit' }
    );
    runs = list();
  }
  if (
    !runs.some(
      (run) =>
        run.databaseId === newest.databaseId &&
        run.status === 'completed' &&
        run.conclusion === 'success'
    )
  )
    throw Error(
      'The original native release producer failed. Inspect that run; this release command does not retry or replace it.'
    );
  const run = selectBrowserNativeArtifactRun(
    runs.filter((row) => row.databaseId === newest.databaseId),
    head
  );
  const original = JSON.parse(output('gh', ['api', `repos/${repository}/actions/runs/${run}`])) as {
    head_sha?: unknown;
    status?: unknown;
    conclusion?: unknown;
    event?: unknown;
    path?: unknown;
    repository?: { full_name?: unknown };
  };
  if (
    original.head_sha !== head ||
    original.status !== 'completed' ||
    original.conclusion !== 'success' ||
    original.event !== 'workflow_dispatch' ||
    original.path !== '.github/workflows/' + workflow ||
    original.repository?.full_name !== repository
  )
    throw Error('The selected native browser producer is not this original release workflow.');
  const retainedDirectory = await mkdtemp(join(tmpdir(), 'dorkos-cli-release-'));
  const artifact = join(retainedDirectory, 'artifact');
  await mkdir(artifact);
  proveMerged();
  execFileSync(
    'gh',
    [
      'run',
      'download',
      String(run),
      '--repo',
      repository,
      '--name',
      'browser-darwin-arm64-' + head,
      '--dir',
      artifact,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  const manifest = join(artifact, 'handoff-manifest.json');
  // The trusted attestation pins the bytes to the exact source/tag/original workflow,
  // independently of artifact names or a caller-supplied digest file.
  const bytes = await readBrowserNativeArtifactManifest(manifest);
  const pin = createHash('sha256').update(bytes).digest('hex');
  const verified: unknown = JSON.parse(
    output('gh', [
      'attestation',
      'verify',
      manifest,
      '--repo',
      repository,
      '--signer-workflow',
      `${repository}/.github/workflows/${workflow}`,
      '--source-digest',
      head,
      '--signer-digest',
      head,
      '--source-ref',
      'refs/tags/' + tag,
      '--format',
      'json',
    ])
  );
  assertBrowserNativeArtifactAttestation(verified, pin);
  const env = {
    ...process.env,
    DORKOS_BROWSER_DARWIN_ARTIFACT_DIRECTORY: artifact,
    DORKOS_BROWSER_DARWIN_ARTIFACT_SHA256: pin,
  };
  clean();
  assertBrowserNativeReleaseBinding(
    pkg.version,
    (await readFile(join(root, 'VERSION'), 'utf8')).trim(),
    output('git', ['rev-parse', 'HEAD']),
    head
  );
  proveMerged(); // Refresh remote ancestry before publication or the original build.
  if (publish) {
    // Existing release authorization is exactly invoking publish:cli; no admin/git-check bypass.
    execFileSync('pnpm', ['publish', '--filter=dorkos'], { cwd: root, stdio: 'inherit', env });
  } else {
    execFileSync('pnpm', ['--filter', 'dorkos', 'build'], { cwd: root, stdio: 'inherit', env });
    clean();
    if (output('git', ['rev-parse', 'HEAD']) !== head)
      throw Error('Release source changed during the original build.');
    const packed = join(retainedDirectory, 'packed');
    await mkdir(packed);
    proveMerged();
    execFileSync('pnpm', ['pack', '--pack-destination', packed], {
      cwd: join(root, 'packages/cli'),
      stdio: 'inherit',
      env,
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
        producerRun: run,
        manifestSHA256: pin,
        tarball,
        published: false,
      }) + '\n',
      { flag: 'wx' }
    );
    console.log(
      `Prepared ${tarball}; retained original artifact and receipt at ${retainedDirectory}. Nothing was published.`
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

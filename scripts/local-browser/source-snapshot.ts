/** Read-only source custody for built-package proofs; ignored build/evidence outputs stay outside the inventory. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
type SourceEntry =
  | { path: string; kind: 'file'; mode: number; sha256: string }
  | { path: string; kind: 'symlink'; mode: number; target: string }
  | { path: string; kind: 'deleted' };

/** Bind npm's single packed archive to its actual bytes and the frozen source inventory. */
export async function readPackedProof(
  packOutput: string,
  artifacts: string,
  sourceFingerprint: string
) {
  const packed = JSON.parse(packOutput) as {
    filename: string;
    version: string;
    size: number;
    integrity: string;
  }[];
  assert.equal(packed.length, 1);
  const entry = packed[0];
  assert(entry);
  assert.equal(typeof entry.version, 'string');
  assert(entry.version.length > 0);
  assert.equal(path.basename(entry.filename), entry.filename);
  const tarball = path.join(artifacts, entry.filename);
  const bytes = await readFile(tarball);
  assert.equal(bytes.length, entry.size);
  return {
    tarball,
    metadata: {
      sourceFingerprint,
      filename: entry.filename,
      version: entry.version,
      bytes: bytes.length,
      integrity: entry.integrity,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}

/** Inventory tracked and nonignored untracked inputs without following source symlinks. */
export async function captureProofSource(root: string, env: NodeJS.ProcessEnv) {
  const git = (args: string[]) =>
    exec('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
    });
  const [inventory, revision] = await Promise.all([
    git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    git(['rev-parse', 'HEAD']),
  ]);
  const names = [...new Set(inventory.stdout.split(String.fromCharCode(0)).filter(Boolean))]
    .filter((name) => !name.split('/').includes('.dork'))
    .sort();
  const files: SourceEntry[] = [];
  for (const name of names) {
    const file = path.resolve(root, name);
    assert(file.startsWith(path.resolve(root) + path.sep), 'Git inventory escaped the proof root');
    try {
      // Writers are frozen during proof; refuse indexed paths whose internal parents changed.
      let ancestor = path.resolve(root);
      for (const component of name.split('/').slice(0, -1)) {
        ancestor = path.join(ancestor, component);
        const parent = await lstat(ancestor);
        assert(
          !parent.isSymbolicLink() && parent.isDirectory(),
          'Proof source ancestor must be a real directory: ' + ancestor
        );
      }
      const metadata = await lstat(file);
      if (metadata.isSymbolicLink()) {
        files.push({
          path: name,
          kind: 'symlink',
          mode: metadata.mode & 0o777,
          target: await readlink(file),
        });
      } else {
        assert(metadata.isFile(), 'Proof source inventory must contain files or symlinks');
        const hash = createHash('sha256');
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
        } finally {
          await handle.close();
        }
        files.push({
          path: name,
          kind: 'file',
          mode: metadata.mode & 0o777,
          sha256: hash.digest('hex'),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files.push({ path: name, kind: 'deleted' });
    }
  }
  const lock = files.find((file) => file.path === 'pnpm-lock.yaml');
  assert(lock?.kind === 'file', 'The proof requires a real inventoried lockfile');
  const inputs = { head: revision.stdout.trim(), lockSha256: lock.sha256, files };
  return {
    ...inputs,
    fingerprint: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
  };
}

/** Keep source evidence separate from generated dist and stop whenever frozen inputs change. */
export class ProofSourceCustody {
  readonly evidence: {
    head: string;
    lockSha256: string;
    fingerprint: string;
    snapshots: Record<
      string,
      { file: string; fingerprint: string; fileCount: number; unchanged: boolean }
    >;
  };

  private constructor(
    private readonly root: string,
    private readonly output: string,
    private readonly env: NodeJS.ProcessEnv,
    source: Awaited<ReturnType<typeof captureProofSource>>
  ) {
    this.evidence = {
      head: source.head,
      lockSha256: source.lockSha256,
      fingerprint: source.fingerprint,
      snapshots: {},
    };
  }

  /** Freeze the actual source tree before the normal CLI build. */
  static async start(root: string, output: string, env: NodeJS.ProcessEnv) {
    const source = await captureProofSource(root, env);
    const custody = new ProofSourceCustody(root, output, env, source);
    await custody.save('before-build', source);
    return custody;
  }

  private async save(label: string, source: Awaited<ReturnType<typeof captureProofSource>>) {
    const file = path.join(this.output, 'source-' + label + '.json');
    await writeFile(file, JSON.stringify(source, null, 2) + String.fromCharCode(10), {
      flag: 'wx',
      mode: 0o600,
    });
    const unchanged = source.fingerprint === this.evidence.fingerprint;
    this.evidence.snapshots[label] = {
      file,
      fingerprint: source.fingerprint,
      fileCount: source.files.length,
      unchanged,
    };
    assert(unchanged, 'Proof source changed; inspect ' + file);
  }

  /** Save changed inputs too, so a failed freeze has inspectable evidence. */
  async checkpoint(label: string) {
    await this.save(label, await captureProofSource(this.root, this.env));
  }

  /** Preserve an earlier proof failure while recording final inputs before temporary-data removal. */
  async finish(receipt: Record<string, unknown>) {
    try {
      await this.checkpoint('after-proof');
    } catch (error) {
      receipt.sourceSnapshotError = error instanceof Error ? error.stack : String(error);
      receipt.status = 'failed';
      process.exitCode = 1;
    }
  }
}

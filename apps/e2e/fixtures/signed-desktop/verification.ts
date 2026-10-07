import {
  DesktopQualificationSubjectSchema,
  type DesktopQualificationGrant,
} from '@dorkos/shared/browser-desktop-qualification';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readdir, readFile, readlink, realpath, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

export interface Artifact {
  readonly appPath: string;
  readonly treeSHA256: string;
  readonly teamIdentifier: string;
  readonly bundleIdentifier: string;
  readonly version: string;
  readonly observerSHA256: string;
  readonly qualificationSubject?: Readonly<DesktopQualificationGrant['subject']>;
}
export interface SignedDesktopAcceptance {
  readonly first: Artifact;
  readonly upgrade: Artifact;
  readonly artifacts: string;
}
function object(value: unknown, keys: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys
  )
    throw new Error('SIGNED_DESKTOP_CONFIG_SHAPE');
  return value as Record<string, unknown>;
}
const text = (value: unknown, pattern: RegExp, cap = 4096): string => {
  if (typeof value !== 'string' || value.length > cap || !pattern.test(value))
    throw new Error('SIGNED_DESKTOP_CONFIG_VALUE');
  return value;
};
/** Capture parsed nested metadata independently of the caller's mutable descriptor. */
function immutableSubject(value: unknown) {
  const subject = DesktopQualificationSubjectSchema.parse(value);
  Object.freeze(subject.runtimeClass.surface);
  Object.freeze(subject.runtimeClass);
  return Object.freeze(subject);
}
/** Validate one supplied signed application descriptor. */
export function parseSignedDesktopArtifact(value: unknown): Artifact {
  const input = object(
    value,
    value && typeof value === 'object' && 'qualificationSubject' in value
      ? 'appPath,bundleIdentifier,observerSHA256,qualificationSubject,teamIdentifier,treeSHA256,version'
      : 'appPath,bundleIdentifier,observerSHA256,teamIdentifier,treeSHA256,version'
  );
  const appPath = text(input.appPath, /^\//),
    treeSHA256 = text(input.treeSHA256, /^[a-f0-9]{64}$/),
    teamIdentifier = text(input.teamIdentifier, /^[A-Z0-9]{10}$/),
    bundleIdentifier = text(input.bundleIdentifier, /^[A-Za-z0-9.-]+$/, 256),
    version = text(input.version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/),
    observerSHA256 = text(input.observerSHA256, /^[a-f0-9]{64}$/);
  if (!isAbsolute(appPath) || !appPath.endsWith('.app'))
    throw new Error('SIGNED_APP_PATH_REQUIRED');
  return Object.freeze({
    appPath,
    treeSHA256,
    teamIdentifier,
    bundleIdentifier,
    version,
    observerSHA256,
    ...(input.qualificationSubject === undefined
      ? {}
      : {
          qualificationSubject: immutableSubject(input.qualificationSubject),
        }),
  });
}
export const SignedDesktopAcceptanceSchema = Object.freeze({
  parse(value: unknown): SignedDesktopAcceptance {
    const input = object(value, 'artifacts,first,upgrade');
    const artifacts = text(input.artifacts, /^\//);
    if (!isAbsolute(artifacts)) throw new Error('SIGNED_DESKTOP_ARTIFACTS_PATH');
    return Object.freeze({
      first: parseSignedDesktopArtifact(input.first),
      upgrade: parseSignedDesktopArtifact(input.upgrade),
      artifacts,
    });
  },
});
export const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Stable bounded bundle inventory, including legitimate internal framework aliases. */
export async function signedBundleTree(root: string): Promise<string> {
  if ((await realpath(root)) !== root) throw new Error('SIGNED_APP_CANONICAL_PATH_REQUIRED');
  const rows: unknown[] = [];
  let total = 0,
    entries = 0;
  const visit = async (path: string): Promise<void> => {
    const stat = await lstat(path);
    if (++entries > 100_000 || relative(root, path).split('/').length > 64)
      throw new Error('SIGNED_APP_TREE_BOUND');
    const name = relative(root, path);
    if (stat.isSymbolicLink()) {
      const link = await readlink(path);
      const target = await realpath(path);
      if (relative(root, target).startsWith('..') || isAbsolute(relative(root, target)))
        throw new Error('SIGNED_APP_EXTERNAL_LINK');
      rows.push({ path: name, link });
    } else if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else if (stat.isFile()) {
      total += stat.size;
      if (total > 2 * 1024 ** 3 || stat.size > 1024 ** 3) throw new Error('SIGNED_APP_BYTES_BOUND');
      const fd = await open(path, 'r');
      try {
        const before = await fd.stat();
        const h = createHash('sha256');
        const buffer = Buffer.alloc(1024 * 1024);
        let bytes = 0;
        for (;;) {
          const read = await fd.read(buffer, 0, buffer.length, null);
          if (!read.bytesRead) break;
          bytes += read.bytesRead;
          if (bytes > before.size) throw new Error('SIGNED_APP_CHANGED');
          h.update(buffer.subarray(0, read.bytesRead));
        }
        const after = await fd.stat();
        if (
          bytes !== before.size ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error('SIGNED_APP_CHANGED');
        rows.push({ path: name, bytes, sha256: h.digest('hex'), mode: before.mode & 0o777 });
      } finally {
        await fd.close();
      }
    } else throw new Error('SIGNED_APP_UNEXPECTED_ENTRY');
  };
  await visit(root);
  return sha(JSON.stringify(rows));
}

interface OriginalToolReceipt {
  executable: string;
  argv: readonly string[];
  pid: number | undefined;
  exitCode: number | null;
  signalCode: string | null;
  naturalCloseAndPipesJoined: boolean;
  output: string;
  faulted: boolean;
}

/** Exact original tool child, close and both pipe EOFs are joined before outcome. */
export async function originalTool(
  executable: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  retained?: OriginalToolReceipt[]
): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(executable, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let first: { value: unknown } | undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  const fail = (value: unknown) => {
    first ??= { value };
  };
  const terminal = new Promise<void>((yes) => child.once('close', () => yes()));
  child.once('error', fail);
  const stop = () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    } catch (value) {
      fail(value);
    }
  };
  const pipes = [child.stdout, child.stderr].map(
    (pipe) =>
      new Promise<void>((yes) => {
        if (!pipe) {
          fail(new Error('TOOL_PIPE_REQUIRED'));
          yes();
          return;
        }
        pipe.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            fail(new Error('TOOL_OUTPUT_BOUND'));
            stop();
          } else chunks.push(chunk);
        });
        pipe.once('error', (value) => {
          fail(value);
          stop();
        });
        let ended = pipe.readableEnded;
        pipe.once('end', () => {
          ended = true;
        });
        pipe.once('close', () => {
          if (!ended && !pipe.readableEnded) fail(new Error('ORIGINAL_TOOL_PIPE_EOF_UNVERIFIED'));
          yes();
        });
      })
  );
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  await Promise.allSettled([terminal, ...pipes]);
  signal.removeEventListener('abort', stop);
  retained?.push({
    executable,
    argv: [...argv],
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    naturalCloseAndPipesJoined: !first && !signal.aborted,
    output: Buffer.concat(chunks).toString('utf8'),
    faulted: !!first || signal.aborted,
  });
  if (first) throw first.value;
  signal.throwIfAborted();
  if (child.exitCode !== 0 || child.signalCode !== null)
    throw new Error('ORIGINAL_TOOL_REFUSED:' + executable);
  return Buffer.concat(chunks).toString('utf8');
}

const originalVerifications = new WeakMap<
  object,
  Readonly<{ artifact: Artifact; executable: string }>
>();
/** Authenticate the original completed signature checks before inspecting a supplied value. */
export function readOriginalSignedDesktopVerification(value: unknown) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    throw new Error('SIGNED_DESKTOP_ORIGINAL_VERIFICATION_REQUIRED');
  const original = originalVerifications.get(value);
  if (!original) throw new Error('SIGNED_DESKTOP_ORIGINAL_VERIFICATION_REQUIRED');
  return original;
}

/** Verify the exact original bundle signature, notarization and pinned native observer. */
export async function verifySignedDesktop(
  suppliedArtifact: Artifact,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal
) {
  const artifact = parseSignedDesktopArtifact(suppliedArtifact);
  const checks: OriginalToolReceipt[] = [];
  if ((await signedBundleTree(artifact.appPath)) !== artifact.treeSHA256)
    throw new Error('SIGNED_APP_TREE_CHANGED');
  const signature = await originalTool(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', artifact.appPath],
    env,
    signal,
    checks
  );
  if (
    !signature.includes('Authority=Developer ID Application:') ||
    !signature.split('\n').includes('TeamIdentifier=' + artifact.teamIdentifier) ||
    !signature.split('\n').includes('Identifier=' + artifact.bundleIdentifier)
  )
    throw new Error('DEVELOPER_ID_SIGNATURE_REQUIRED');
  await originalTool(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', artifact.appPath],
    env,
    signal,
    checks
  );
  const gatekeeper = await originalTool(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'execute', '--verbose=4', artifact.appPath],
    env,
    signal,
    checks
  );
  if (!gatekeeper.includes('source=Notarized Developer ID'))
    throw new Error('NOTARIZED_DEVELOPER_ID_REQUIRED');
  await originalTool(
    '/usr/bin/xcrun',
    ['stapler', 'validate', artifact.appPath],
    env,
    signal,
    checks
  );
  const plist = join(artifact.appPath, 'Contents/Info.plist');
  const executable = (
    await originalTool(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleExecutable', plist],
      env,
      signal,
      checks
    )
  ).trim();
  const version = (
    await originalTool(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', plist],
      env,
      signal,
      checks
    )
  ).trim();
  if (version !== artifact.version || !/^[A-Za-z0-9 ._-]+$/.test(executable))
    throw new Error('SIGNED_APP_VERSION_OR_EXECUTABLE');
  const native = join(
    artifact.appPath,
    'Contents/Resources/app.asar.unpacked/dist/browser/native/darwin-process-observer'
  );
  if (sha(await readFile(native)) !== artifact.observerSHA256 || !(await lstat(native)).isFile())
    throw new Error('SIGNED_OBSERVER_CHANGED');
  if ((await signedBundleTree(artifact.appPath)) !== artifact.treeSHA256)
    throw new Error('SIGNED_APP_CHANGED_DURING_VERIFICATION');
  const verified = Object.freeze({
    executable: join(artifact.appPath, 'Contents/MacOS', executable),
    native,
    signatureSHA256: sha(signature),
    gatekeeperSHA256: sha(gatekeeper),
    checks: Object.freeze(checks),
  });
  originalVerifications.set(verified, Object.freeze({ artifact, executable: verified.executable }));
  return verified;
}

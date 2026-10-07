import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstallationFilesystem } from './filesystem.js';
import { createInstallationJobs } from './jobs.js';
import {
  FreshVerifierRequestSchema,
  FreshVerifierReplySchema,
  FileIdentitySchema,
  InstallationConfigurationSchema,
  InstallationFailure,
  INSTALLATION_LIMITS,
  INSTALLATION_TARGET,
  canonicalDigest,
  failureCode,
  parseRecord,
  recordBytes,
  sameBinding,
  sameFileIdentity,
  type AttemptBounds,
  type FileIdentity,
  type FileSnapshot,
  type FreshVerifierRequest,
  type FreshVerifierReply,
  type InstallationFilesystem,
  type InstallationJobs,
} from './contracts.js';

// A failed close keeps the exact original reachable. No numeric retry or reconstructed handle.
const retainedReads = new Set<FileHandle>();
const retainedOwners = new Set<
  Readonly<{ filesystem: InstallationFilesystem; jobs: InstallationJobs }>
>();

function requireFact(
  value: unknown,
  code: ConstructorParameters<typeof InstallationFailure>[0]
): asserts value {
  if (!value) throw new InstallationFailure(code);
}
function identity(stat: BigIntStats): FileIdentity {
  requireFact(stat.isFile(), 'INSTALLATION_INVALID');
  return FileIdentitySchema.parse({
    device: String(stat.dev),
    inode: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    type: 'file',
    uid: Number(stat.uid),
    mode: Number(stat.mode),
  });
}
function fixedClock(bounds: AttemptBounds): (final?: boolean) => void {
  let previous = bounds.origin;
  return (final = false) => {
    let value: number;
    try {
      value = Number(process.hrtime.bigint() / 1_000_000n);
    } catch {
      throw new InstallationFailure('CLOCK_UNAVAILABLE');
    }
    requireFact(Number.isFinite(value) && value >= previous, 'CLOCK_UNAVAILABLE');
    previous = value;
    requireFact(
      value < (final ? bounds.finalEnd : bounds.workEnd),
      final ? 'FINAL_EXPIRED' : 'WORK_EXPIRED'
    );
  };
}

/** Parse the exact branded stdout observed from the pinned Darwin arm64 download. */
export function parsePinnedVersionOutput(
  bytes: Uint8Array
): typeof INSTALLATION_TARGET.observedVersion {
  requireFact(bytes.byteLength <= INSTALLATION_LIMITS.replyBytes, 'RETENTION_EXCEEDED');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new InstallationFailure('VERSION_MISMATCH');
  }
  requireFact(text === 'Google Chrome for Testing 153.0.8010.12 \n', 'VERSION_MISMATCH');
  return INSTALLATION_TARGET.observedVersion;
}

/** Post-probe read uses a new real original; F's independent admission supplies its expected identity. */
async function recheckExecutable(expected: FileSnapshot, check: () => void): Promise<void> {
  check();
  const named = await lstat(expected.path, { bigint: true });
  requireFact(
    named.isFile() &&
      !named.isSymbolicLink() &&
      sameFileIdentity(identity(named), expected.identity) &&
      (await realpath(expected.path)) === expected.path,
    'ROOT_CHANGED'
  );
  requireFact(named.size <= BigInt(INSTALLATION_LIMITS.executableBytes), 'RETENTION_EXCEEDED');
  const original = await open(
    expected.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  retainedReads.add(original);
  let primary: unknown;
  let failed = false;
  try {
    requireFact(
      sameFileIdentity(identity(await original.stat({ bigint: true })), expected.identity),
      'ROOT_CHANGED'
    );
    const digest = createHash('sha256');
    const buffer = new Uint8Array(INSTALLATION_LIMITS.bufferBytes);
    const header = new Uint8Array(8);
    let bytes = 0;
    while (true) {
      check();
      const read = await original.read(
        buffer,
        0,
        Math.min(buffer.byteLength, INSTALLATION_LIMITS.executableBytes + 1 - bytes),
        null
      );
      if (!read.bytesRead) break;
      if (bytes < header.length)
        header.set(buffer.subarray(0, Math.min(read.bytesRead, header.length - bytes)), bytes);
      bytes += read.bytesRead;
      requireFact(bytes <= INSTALLATION_LIMITS.executableBytes, 'RETENTION_EXCEEDED');
      digest.update(buffer.subarray(0, read.bytesRead));
    }
    requireFact(
      bytes === expected.bytes && digest.digest('hex') === expected.sha256,
      'HASH_MISMATCH'
    );
    const view = new DataView(header.buffer);
    requireFact(
      bytes >= header.length &&
        view.getUint32(0, true) === 0xfeedfacf &&
        view.getUint32(4, true) === 16777228,
      'INSTALLATION_INVALID'
    );
    requireFact(
      sameFileIdentity(identity(await original.stat({ bigint: true })), expected.identity) &&
        sameFileIdentity(
          identity(await lstat(expected.path, { bigint: true })),
          expected.identity
        ) &&
        (await realpath(expected.path)) === expected.path,
      'ROOT_CHANGED'
    );
    check();
  } catch (error) {
    primary = error;
    failed = true;
  }
  try {
    await original.close();
    retainedReads.delete(original);
  } catch {
    // The failure flag preserves even undefined/null/falsy primary exceptions.
    if (!failed) primary = new InstallationFailure('CUSTODY_UNCERTAIN');
    failed = true;
  }
  if (failed) throw primary;
}

/** Actual fresh-process composition; no arbitrary filesystem/jobs issuer is accepted here. */
export async function verifyFreshRequest(input: FreshVerifierRequest): Promise<FreshVerifierReply> {
  const request = FreshVerifierRequestSchema.parse(input);
  return verifyRequest(request, fixedClock(request.bounds));
}

async function verifyRequest(
  request: FreshVerifierRequest,
  check: (final?: boolean) => void
): Promise<FreshVerifierReply> {
  // Keep this same exact object through F admission and probe-sink lookup.
  Object.freeze(request.binding);
  Object.freeze(request.bounds);
  Object.freeze(request.sourceVintage);
  Object.freeze(request.executableIdentity);
  Object.freeze(request.attemptIdentity);
  Object.freeze(request);
  const configuration = InstallationConfigurationSchema.parse({
    cacheRoot: request.cacheRoot,
    libraryRoot: request.libraryRoot,
    nodeExecutable: request.nodeExecutable,
    nodeExecutableSHA256: request.nodeExecutableSHA256,
    nodeRuntime: request.nodeRuntime,
    electronFramework: request.electronFramework,
    controllerEntry: request.controllerEntry,
    verifierEntry: request.verifierEntry,
    sourceManifestPath: request.sourceManifestPath,
    sourceVintage: request.sourceVintage,
    platform: request.platform,
    arch: request.arch,
    workMilliseconds: request.bounds.workEnd - request.bounds.origin,
    finalMilliseconds: request.bounds.finalEnd - request.bounds.origin,
  });
  check();
  requireFact(
    process.platform === INSTALLATION_TARGET.platform && process.arch === INSTALLATION_TARGET.arch,
    'PLATFORM_UNSUPPORTED'
  );
  requireFact(
    resolve(process.execPath) === request.nodeExecutable &&
      (request.nodeRuntime === 'electron-node'
        ? !!process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1'
        : !process.versions.electron) &&
      !!process.argv[1] &&
      resolve(process.argv[1]) === request.verifierEntry,
    'SOURCE_MISMATCH'
  );
  const filesystem = createInstallationFilesystem(configuration);
  const jobs = createInstallationJobs(configuration, {
    ownerKind: 'fresh-verifier',
  });
  const owner = Object.freeze({ filesystem, jobs });
  retainedOwners.add(owner);
  const admitted = await filesystem.inspectFreshRequest(request);
  check();
  const run = await jobs.runVersionProbe({
    binding: request.binding,
    bounds: request.bounds,
    executable: admitted.candidate.executable,
    cwd: request.attemptRoot,
    sink: filesystem.createProbeSink(request),
  });
  // Only J's retained original handle can authorize return; serialized facts are correspondence.
  const facts = jobs.requireReturned(run.handle);
  requireFact(
    canonicalDigest(facts) === canonicalDigest(run.facts) &&
      facts.role === 'version-probe' &&
      facts.jobId === run.handle.jobId &&
      sameBinding(facts.binding, request.binding),
    'BINDING_MISMATCH'
  );
  const birth = facts.birth;
  requireFact(
    birth &&
      sameBinding(birth.binding, request.binding) &&
      birth.jobId === facts.jobId &&
      birth.role === 'version-probe' &&
      canonicalDigest(birth.bounds) === canonicalDigest(request.bounds) &&
      birth.executable === admitted.candidate.executable.path &&
      birth.cwd === request.attemptRoot &&
      canonicalDigest(birth.argv) === canonicalDigest(['--version']) &&
      Number.isSafeInteger(birth.pid) &&
      birth.pid > 0,
    'BINDING_MISMATCH'
  );
  requireFact(
    facts.exitObserved &&
      facts.closeObserved &&
      facts.exitCode === 0 &&
      facts.signal === null &&
      !facts.stopRequested &&
      facts.firstCause === null &&
      facts.cleanupCauses.length === 0 &&
      facts.descendantDisposition === 'not-applicable',
    facts.firstCause ?? 'PROBE_FAILED'
  );
  for (const [stream, bytes] of [
    [facts.stdout, run.stdout],
    [facts.stderr, run.stderr],
  ] as const) {
    requireFact(
      stream.eof &&
        stream.closed &&
        stream.rawFlushedClosed &&
        !stream.overflow &&
        Number.isSafeInteger(stream.observedBytes) &&
        stream.observedBytes === stream.retainedBytes &&
        stream.retainedBytes === bytes.byteLength &&
        bytes.byteLength <= INSTALLATION_LIMITS.streamBytes,
      'CUSTODY_UNCERTAIN'
    );
  }
  check();
  const observedVersion = parsePinnedVersionOutput(run.stdout);
  await recheckExecutable(admitted.candidate.executable, check);
  const libraryAfter = await filesystem.validateLibrary();
  requireFact(
    canonicalDigest(libraryAfter) === canonicalDigest(admitted.library),
    'LIBRARY_MISMATCH'
  );
  const afterAttempt = await lstat(request.attemptRoot, { bigint: true });
  requireFact(
    afterAttempt.isDirectory() &&
      !afterAttempt.isSymbolicLink() &&
      String(afterAttempt.dev) === request.attemptIdentity.device &&
      String(afterAttempt.ino) === request.attemptIdentity.inode &&
      String(afterAttempt.size) === request.attemptIdentity.size &&
      String(afterAttempt.mtimeNs) === request.attemptIdentity.mtimeNs &&
      String(afterAttempt.ctimeNs) === request.attemptIdentity.ctimeNs &&
      Number(afterAttempt.uid) === request.attemptIdentity.uid &&
      Number(afterAttempt.mode) === request.attemptIdentity.mode,
    'ROOT_CHANGED'
  );
  check(true);
  const fileCustody = filesystem.custody();
  const jobCustody = jobs.custody();
  requireFact(
    fileCustody.pendingOperations === 0 &&
      fileCustody.unresolvedHandles === 0 &&
      fileCustody.firstCause === null &&
      fileCustody.reservation === 'released' &&
      jobCustody.pending === 0 &&
      jobCustody.firstCause === null &&
      retainedReads.size === 0,
    'CUSTODY_UNCERTAIN'
  );
  const reply = FreshVerifierReplySchema.parse({
    schemaVersion: 1,
    binding: request.binding,
    executableSHA256: admitted.candidate.executable.sha256,
    executableIdentity: admitted.candidate.executable.identity,
    libraryDistributionSHA256: admitted.library.distributionSHA256,
    sourceManifestSHA256: request.sourceVintage.sourceManifestSHA256,
    observedVersion,
    chromiumRevision: INSTALLATION_TARGET.chromiumRevision,
    platform: INSTALLATION_TARGET.platform,
    arch: INSTALLATION_TARGET.arch,
    machOCPU: admitted.candidate.machOCPU,
    probeReceiptDigest: canonicalDigest(facts),
  });
  recordBytes(reply, INSTALLATION_LIMITS.replyBytes);
  check(true);
  retainedOwners.delete(owner); // Actual F/J originals returned; no failure path clears this bank.
  return Object.freeze(reply);
}

/** Parent J owns the original stdin and sends this bounded request after durable birth. */
async function readRequest(): Promise<FreshVerifierRequest> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  for await (const value of process.stdin) {
    const chunk = typeof value === 'string' ? Buffer.from(value) : (value as Uint8Array);
    requireFact(Number.isSafeInteger(bytes + chunk.byteLength), 'RETENTION_EXCEEDED');
    bytes += chunk.byteLength;
    if (bytes > INSTALLATION_LIMITS.replyBytes) overflow = true;
    if (!overflow) chunks.push(Uint8Array.from(chunk));
    // Continue draining without retention on overflow; no new stdin or native child is created.
  }
  requireFact(!overflow && bytes > 0, overflow ? 'RETENTION_EXCEEDED' : 'INSTALLATION_INVALID');
  return parseRecord(
    Buffer.concat(chunks),
    FreshVerifierRequestSchema,
    INSTALLATION_LIMITS.replyBytes
  );
}

/** Dedicated packaged entry. Never process.exit() while an attributable original remains pending. */
export async function runFreshVerifierEntry(): Promise<void> {
  try {
    const request = await readRequest();
    const check = fixedClock(request.bounds);
    const reply = await verifyRequest(request, check);
    check(true);
    const bytes = recordBytes(reply, INSTALLATION_LIMITS.replyBytes);
    await new Promise<void>((done, reject) => {
      process.stdout.once('error', reject);
      process.stdout.end(bytes, () => {
        process.stdout.removeListener('error', reject);
        done();
      });
    });
    check(true);
  } catch (error) {
    process.exitCode = 1;
    // Closed code only. J retains original stderr/exit/close; this is not a success reply.
    process.stderr.write(failureCode(error) + '\n');
  }
}

// The future bundled verifier entry keeps this direct-entry guard; importing has no native effect.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runFreshVerifierEntry();
}

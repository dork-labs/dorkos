import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Dir } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { scanJSON } from '../inspection/scanner.js';
import {
  AttemptBindingSchema,
  AttemptBoundsSchema,
  FreshVerifierRequestSchema,
  InstallationConfigurationSchema,
  InstallationFailure,
  INSTALLATION_LIMITS as LIMIT,
  INSTALLATION_TARGET as TARGET,
  JobBirthSchema,
  JobIntentSchema,
  OwnerRecordSchema,
  ManifestSchema,
  PointerSchema,
  VerificationRecordSchema,
  ReuseRecordSchema,
  FreshVerifierReplySchema,
  SourceManifestSchema,
  READINESS_UNAVAILABLE,
  FailureCodeSchema,
  canonicalDigest,
  failureCode,
  parseRecord,
  recordBytes,
  relativePath,
  sameBinding,
  sameFileIdentity,
  sha256,
  type AttemptBinding,
  type AttemptBounds,
  type AttemptHandle,
  type CandidateHandle,
  type CandidateSnapshot,
  type CurrentObservation,
  type ExistingInspection,
  type ExistingInstallation,
  type FileIdentity,
  type FileSnapshot,
  type FilesystemCustody,
  type FreshVerifierRequest,
  type InspectOptions,
  type InstallationConfiguration,
  type InstallationFilesystem,
  type InstallationJobSink,
  type JobBirth,
  type JobFacts,
  type JobIntent,
  type JobOutput,
  type LibrarySnapshot,
  type Manifest,
  type OwnerRecord,
  type PublicationFacts,
  type RawWriter,
  type ReservationHandle,
  type ReuseRecord,
  type RuntimeInstallationStatus,
  type VerificationRecord,
  type FailureCode,
} from './contracts.js';

// Hash-only regular files use a fixed private pool. Sixteen lazy 1MiB buffers bound
// additional allocated backing stores to 16MiB per process; saturation uses existing 64KiB.
// Slots stay charged until the original read and independent descriptor close have returned.
const LARGE_HASH_BUFFER_BYTES = 1_048_576;
const LARGE_HASH_BUFFER_SLOTS = 16;
type LargeHashBufferSlot = { inUse: boolean; buffer?: Buffer };
const largeHashBuffers: LargeHashBufferSlot[] = [];
function takeLargeHashBuffer(size: string, retain: number): LargeHashBufferSlot | undefined {
  if (retain !== 0 || BigInt(size) < BigInt(LARGE_HASH_BUFFER_BYTES)) return undefined;
  let slot = largeHashBuffers.find((value) => !value.inUse);
  if (!slot && largeHashBuffers.length < LARGE_HASH_BUFFER_SLOTS) {
    slot = { inUse: false };
    largeHashBuffers.push(slot);
  }
  if (slot) slot.inUse = true; // Charge synchronously before allocation or any original await.
  return slot;
}

type Duty = {
  path: string;
  original: FileHandle | Dir | null;
  state: 'acquiring' | 'open' | 'closing' | 'closed' | 'uncertain';
  lease: boolean;
};
type DirectoryLease = {
  path: string;
  identity: FileIdentity;
  duty: Duty;
  handle: FileHandle;
};
type Reservation = {
  handle: ReservationHandle;
  bounds: AttemptBounds;
  root: DirectoryLease;
  directory: DirectoryLease;
  state: 'held' | 'released' | 'uncertain';
  owner: OwnerRecord;
  ownerFile: FileSnapshot | null;
  attempt: AttemptHandle | null;
  jobs: Map<string, SinkJob>;
  diagnosticBudget: { bytes: number; reserved: number };
  candidate: CandidateHandle | null;
};
type Attempt = {
  reservation: Reservation;
  handle: AttemptHandle;
  diagnostics: string;
};
type Candidate = {
  handle: CandidateHandle;
  reservation: Reservation;
  attempt: Attempt;
  durable: CandidateSnapshot | null;
};
type ReadResult = { file: FileSnapshot; bytes: Uint8Array; prefix: Uint8Array };
type Tree = {
  rows: Record<string, unknown>[];
  files: FileSnapshot[];
  directories: { path: string; identity: FileIdentity }[];
  entries: number;
  bytes: number;
};
type WriterState = {
  writer: RawWriter;
  duty: Duty;
  finished: boolean;
  finalSnapshot: FileSnapshot | null;
  checkFinal(): Promise<FileSnapshot>;
};
type SinkJob = {
  intent: JobIntent;
  prefix: string;
  output: JobOutput | null;
  writers: WriterState[];
  birth: JobBirth | null;
  receipt: JobFacts | null;
};
type FreshAdmission = {
  request: FreshVerifierRequest;
  digest: string;
  attempt: FileIdentity;
  sink: InstallationJobSink | null;
};

const streamSchema = z.strictObject({
  observedBytes: z.number().int().nonnegative(),
  retainedBytes: z.number().int().nonnegative(),
  overflow: z.boolean(),
  eof: z.boolean(),
  closed: z.boolean(),
  rawFlushedClosed: z.boolean(),
});
const factsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.string(),
  role: z.enum(['official-install', 'fresh-verifier', 'version-probe']),
  binding: AttemptBindingSchema,
  birth: JobBirthSchema.nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  exitObserved: z.boolean(),
  closeObserved: z.boolean(),
  stdout: streamSchema,
  stderr: streamSchema,
  stopRequested: z.boolean(),
  firstCause: FailureCodeSchema.nullable(),
  cleanupCauses: z.array(FailureCodeSchema).max(32),
  descendantDisposition: z.enum(['trusted-installer-return', 'not-applicable', 'unknown']),
});

function requireFact(value: unknown, code: FailureCode): asserts value {
  if (!value) throw new InstallationFailure(code);
}
function isMissing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function isExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST';
}
function identity(stat: BigIntStats): FileIdentity {
  requireFact(stat.isFile() || stat.isDirectory(), 'ROOT_CHANGED');
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode),
    type: stat.isFile() ? 'file' : 'directory',
  });
}
function directoryIdentity(a: FileIdentity, b: FileIdentity): boolean {
  // Entry changes caused by this transaction legitimately change directory timestamps.
  return (
    a.type === 'directory' &&
    b.type === 'directory' &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.uid === b.uid &&
    a.mode === b.mode
  );
}
function compareCurrent(a: CurrentObservation, b: CurrentObservation): boolean {
  if (a.state !== b.state || a.state === 'unknown') return false;
  if (a.state === 'absent') return true;
  if (b.state !== 'present' && b.state !== 'invalid') return false;
  return sameFileIdentity(a.file.identity, b.file.identity) && a.file.sha256 === b.file.sha256;
}
function sameSnapshot(a: CandidateSnapshot, b: CandidateSnapshot): boolean {
  return (
    a.installationId === b.installationId &&
    a.candidateRoot === b.candidateRoot &&
    a.payloadRoot === b.payloadRoot &&
    a.inventoryDigest === b.inventoryDigest &&
    a.entries === b.entries &&
    a.bytes === b.bytes &&
    a.machOCPU === b.machOCPU &&
    a.executable.sha256 === b.executable.sha256 &&
    sameFileIdentity(a.executable.identity, b.executable.identity)
  );
}
function now(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

class NodeInstallationFilesystem implements InstallationFilesystem {
  private readonly reservations = new WeakMap<ReservationHandle, Reservation>();
  private readonly attempts = new WeakMap<AttemptHandle, Attempt>();
  private readonly candidates = new WeakMap<CandidateHandle, Candidate>();
  private readonly existing = new WeakSet<ExistingInstallation>();
  private readonly fresh = new WeakMap<FreshVerifierRequest, FreshAdmission>();
  private freshAdmissionStarted = false;
  private readonly duties = new Set<Duty>();
  private pending = 0;
  private firstCause: FailureCode | null = null;
  private active: Reservation | null = null;
  private readonly configuration: InstallationConfiguration;

  constructor(configuration: InstallationConfiguration) {
    const parsed = InstallationConfigurationSchema.safeParse(configuration);
    if (!parsed.success) throw new InstallationFailure('INVALID_INSTALL_CONFIGURATION');
    this.configuration = Object.freeze({
      ...parsed.data,
      sourceVintage: Object.freeze(parsed.data.sourceVintage),
      electronFramework: parsed.data.electronFramework
        ? Object.freeze(parsed.data.electronFramework)
        : undefined,
    });
  }

  private fault(error: unknown): void {
    this.firstCause ??= failureCode(error);
  }
  private async operation<T>(body: () => Promise<T>): Promise<T> {
    this.pending++;
    try {
      return await body();
    } finally {
      this.pending--;
    }
  }
  private supported(): void {
    requireFact(
      this.configuration.platform === 'darwin' && this.configuration.arch === 'arm64',
      'PLATFORM_UNSUPPORTED'
    );
  }
  private directorySecure(stat: BigIntStats): void {
    requireFact(stat.isDirectory() && !stat.isSymbolicLink(), 'ROOT_CHANGED');
    const mode = Number(stat.mode),
      uid = Number(stat.uid),
      own = process.getuid?.();
    requireFact(uid === 0 || uid === own, 'OWNERSHIP_UNCERTAIN');
    // A root-owned sticky temporary ancestor is allowed; owned descendants remain private.
    requireFact(
      (mode & 0o022) === 0 || (uid === 0 && (mode & 0o1000) !== 0),
      'OWNERSHIP_UNCERTAIN'
    );
  }
  private async ancestors(
    name: string,
    missing = false
  ): Promise<{ path: string; identity: FileIdentity }[]> {
    requireFact(
      path.isAbsolute(name) && path.normalize(name) === name,
      'INVALID_INSTALL_CONFIGURATION'
    );
    const result: { path: string; identity: FileIdentity }[] = [];
    let current = path.parse(name).root;
    const parts = path.relative(current, name).split(path.sep).filter(Boolean);
    for (const part of ['', ...parts]) {
      if (part) current = path.join(current, part);
      try {
        const stat = await fs.lstat(current, { bigint: true });
        this.directorySecure(stat);
        result.push({ path: current, identity: identity(stat) });
      } catch (error) {
        if (missing && isMissing(error)) break;
        throw error;
      }
    }
    return result;
  }
  private async recheckParents(
    parents: readonly { path: string; identity: FileIdentity }[]
  ): Promise<void> {
    for (const parent of parents) {
      const stat = await fs.lstat(parent.path, { bigint: true });
      this.directorySecure(stat);
      requireFact(directoryIdentity(parent.identity, identity(stat)), 'ROOT_CHANGED');
    }
  }
  private async acquire(name: string, flags: number, lease = false, mode = 0o600): Promise<Duty> {
    const duty: Duty = {
      path: name,
      original: null,
      state: 'acquiring',
      lease,
    };
    this.duties.add(duty);
    try {
      duty.original = await fs.open(name, flags, mode);
      duty.state = 'open';
      return duty;
    } catch (error) {
      duty.state = 'uncertain';
      this.fault(error);
      throw error;
    }
  }
  private async close(duty: Duty): Promise<void> {
    requireFact(duty.state === 'open' && duty.original !== null, 'CUSTODY_UNCERTAIN');
    duty.state = 'closing';
    try {
      await duty.original.close();
      duty.state = 'closed';
      this.duties.delete(duty);
    } catch (error) {
      duty.state = 'uncertain';
      this.fault(error);
      throw error;
    }
  }
  private async closeAfter<T>(duties: readonly Duty[], operation: () => Promise<T>): Promise<T> {
    let result!: T,
      failed = false,
      primary: unknown;
    try {
      result = await operation();
    } catch (error) {
      failed = true;
      primary = error;
      this.fault(error);
    }
    for (const duty of duties) {
      if (duty.state !== 'open') continue;
      try {
        await this.close(duty);
      } catch (error) {
        if (!failed) {
          failed = true;
          primary = error;
        }
      }
    }
    if (failed) throw primary;
    return result;
  }
  private async directory(name: string, lease = false): Promise<DirectoryLease> {
    const parents = await this.ancestors(name);
    const duty = await this.acquire(
      name,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      lease
    );
    const handle = duty.original as FileHandle;
    try {
      const observed = identity(await handle.stat({ bigint: true }));
      requireFact(directoryIdentity(parents.at(-1)!.identity, observed), 'ROOT_CHANGED');
      await this.recheckParents(parents);
      return { path: name, identity: observed, duty, handle };
    } catch (error) {
      this.fault(error);
      try {
        await this.close(duty);
      } catch {
        /* Exact close uncertainty remains in duties. */
      }
      throw error;
    }
  }
  private async checkDirectory(directory: DirectoryLease): Promise<void> {
    const named = identity(await fs.lstat(directory.path, { bigint: true }));
    const held = identity(await directory.handle.stat({ bigint: true }));
    requireFact(
      directoryIdentity(directory.identity, named) && directoryIdentity(named, held),
      'ROOT_CHANGED'
    );
  }
  private async syncDirectory(name: string): Promise<void> {
    const directory = await this.directory(name);
    await this.closeAfter([directory.duty], async () => {
      await this.checkDirectory(directory);
      await directory.handle.sync();
      await this.checkDirectory(directory);
    });
  }
  private async ensureDirectories(name: string): Promise<void> {
    let current = path.parse(name).root;
    for (const part of path.relative(current, name).split(path.sep).filter(Boolean)) {
      const parent = current;
      current = path.join(current, part);
      try {
        this.directorySecure(await fs.lstat(current, { bigint: true }));
      } catch (error) {
        if (!isMissing(error)) throw error;
        await this.ancestors(parent);
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!isExists(mkdirError)) throw mkdirError;
        }
        this.directorySecure(await fs.lstat(current, { bigint: true }));
        await this.syncDirectory(current);
        await this.syncDirectory(parent);
      }
    }
  }
  private async exclusiveDirectory(name: string): Promise<void> {
    await this.ancestors(path.dirname(name));
    await fs.mkdir(name, { mode: 0o700 });
    const stat = await fs.lstat(name, { bigint: true });
    this.directorySecure(stat);
    requireFact(
      Number(stat.uid) === process.getuid?.() && (Number(stat.mode) & 0o077) === 0,
      'OWNERSHIP_UNCERTAIN'
    );
    await this.syncDirectory(name);
    await this.syncDirectory(path.dirname(name));
  }

  private async read(name: string, cap: number, retain = 0): Promise<ReadResult> {
    const parents = await this.ancestors(path.dirname(name));
    const named = identity(await fs.lstat(name, { bigint: true }));
    requireFact(named.type === 'file' && BigInt(named.size) <= BigInt(cap), 'INSTALLATION_INVALID');
    const duty = await this.acquire(
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const handle = duty.original as FileHandle;
    const allocation: { slot?: LargeHashBufferSlot } = {};
    try {
      return await this.closeAfter([duty], async () => {
        const acquired = identity(await handle.stat({ bigint: true }));
        requireFact(sameFileIdentity(named, acquired), 'ROOT_CHANGED');
        const hash = createHash('sha256'),
          chunks: Uint8Array[] = [];
        allocation.slot = takeLargeHashBuffer(named.size, retain);
        const buffer = allocation.slot
          ? (allocation.slot.buffer ??= Buffer.alloc(LARGE_HASH_BUFFER_BYTES))
          : Buffer.alloc(LIMIT.bufferBytes);
        let bytes = 0,
          retained = 0;
        let prefix = new Uint8Array();
        while (true) {
          const value = await handle.read(
            buffer,
            0,
            Math.min(buffer.length, cap + 1 - bytes),
            bytes
          );
          if (!value.bytesRead) break;
          const chunk = buffer.subarray(0, value.bytesRead);
          bytes += value.bytesRead;
          requireFact(bytes <= cap, 'RETENTION_EXCEEDED');
          hash.update(chunk);
          if (prefix.length < 8)
            prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
          if (retained < retain) {
            const copy = Uint8Array.from(chunk.subarray(0, retain - retained));
            chunks.push(copy);
            retained += copy.length;
          }
        }
        requireFact(
          bytes === Number(acquired.size) &&
            sameFileIdentity(acquired, identity(await handle.stat({ bigint: true }))) &&
            sameFileIdentity(acquired, identity(await fs.lstat(name, { bigint: true }))),
          'ROOT_CHANGED'
        );
        await this.recheckParents(parents);
        return {
          file: Object.freeze({
            path: name,
            identity: acquired,
            bytes,
            sha256: hash.digest('hex'),
          }),
          bytes: Buffer.concat(chunks),
          prefix,
        };
      });
    } finally {
      // Allocation/read/body/stat/ancestor/close rejection cannot retain a pool admission.
      if (allocation.slot) allocation.slot.inUse = false;
    }
  }
  private async names(name: string, cap: number): Promise<string[]> {
    const directory = await this.directory(name),
      duty: Duty = {
        path: name,
        original: null,
        state: 'acquiring',
        lease: false,
      };
    this.duties.add(duty);
    return this.closeAfter([duty, directory.duty], async () => {
      try {
        duty.original = await fs.opendir(name, { bufferSize: 1 });
        duty.state = 'open';
      } catch (error) {
        duty.state = 'uncertain';
        throw error;
      }
      const result: string[] = [];
      while (true) {
        const entry = await (duty.original as Dir).read();
        if (entry === null) break;
        requireFact(
          relativePath.safeParse(entry.name).success &&
            !entry.name.includes('/') &&
            !result.includes(entry.name),
          'INSTALLATION_INVALID'
        );
        result.push(entry.name);
        requireFact(result.length <= cap, 'RETENTION_EXCEEDED');
      }
      await this.checkDirectory(directory);
      return result.sort();
    });
  }
  private async libraryBinMetadata(root: string, directory: string): Promise<void> {
    // Package managers may add this self-bin shim after unpacking the official
    // package. We invoke the hashed cli.js directly, never this metadata shim.
    // No module-resolvable dependency or other generated subtree is admitted.
    const parents = await this.ancestors(directory),
      bins = path.join(directory, '.bin');
    const before = identity(await fs.lstat(directory, { bigint: true }));
    requireFact(
      (await this.names(directory, LIMIT.libraryEntries)).join(',') === '.bin',
      'LIBRARY_MISMATCH'
    );
    const binParents = await this.ancestors(bins),
      binBefore = identity(await fs.lstat(bins, { bigint: true }));
    requireFact(
      (await this.names(bins, LIMIT.libraryEntries)).join(',') === 'playwright-core',
      'LIBRARY_MISMATCH'
    );
    const shim = path.join(bins, 'playwright-core'),
      stat = await fs.lstat(shim, { bigint: true });
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(shim);
      requireFact(
        Buffer.byteLength(link) <= LIMIT.bufferBytes &&
          (await fs.realpath(shim)) === path.join(root, 'cli.js'),
        'LIBRARY_MISMATCH'
      );
      const after = await fs.lstat(shim, { bigint: true });
      requireFact(
        after.isSymbolicLink() &&
          stat.dev === after.dev &&
          stat.ino === after.ino &&
          stat.size === after.size &&
          stat.mode === after.mode &&
          stat.uid === after.uid &&
          stat.mtimeNs === after.mtimeNs &&
          stat.ctimeNs === after.ctimeNs &&
          link === (await fs.readlink(shim)),
        'ROOT_CHANGED'
      );
    } else {
      requireFact(stat.isFile(), 'LIBRARY_MISMATCH');
      const read = await this.read(shim, LIMIT.bufferBytes);
      requireFact(sameFileIdentity(identity(stat), read.file.identity), 'ROOT_CHANGED');
    }
    requireFact(
      sameFileIdentity(before, identity(await fs.lstat(directory, { bigint: true }))) &&
        sameFileIdentity(binBefore, identity(await fs.lstat(bins, { bigint: true }))),
      'ROOT_CHANGED'
    );
    await this.recheckParents(binParents);
    await this.recheckParents(parents);
  }
  private async tree(root: string, library = false): Promise<Tree> {
    const parents = await this.ancestors(root);
    const result: Tree = {
      rows: [],
      files: [],
      directories: [],
      entries: 0,
      bytes: 0,
    };
    const entryLimit = library ? LIMIT.libraryEntries : LIMIT.payloadEntries;
    const totalLimit = library ? LIMIT.libraryBytes : LIMIT.payloadBytes;
    let first: Readonly<{ value: unknown }> | undefined;
    const checkFailure = (): void => {
      if (first) throw first.value;
    };
    const pending: {
      relative: string;
      original: Promise<Awaited<ReturnType<NodeInstallationFilesystem['read']>>> | null;
    }[] = [];
    const flush = async (): Promise<void> => {
      const batch = pending.splice(0);
      const joined = await Promise.allSettled(batch.map((job) => job.original!));
      checkFailure();
      // Commit in sorted traversal order, independent of I/O completion order.
      for (let index = 0; index < joined.length; index++) {
        const settled = joined[index]!;
        if (settled.status === 'rejected') throw settled.reason;
        const read = settled.value;
        result.bytes += read.file.bytes;
        requireFact(result.bytes <= totalLimit, 'RETENTION_EXCEEDED');
        result.files.push(read.file);
        result.rows.push({
          path: batch[index]!.relative,
          type: 'file',
          identity: read.file.identity,
          sha256: read.file.sha256,
        });
      }
    };
    const visit = async (directory: string, depth: number): Promise<void> => {
      requireFact(depth <= LIMIT.payloadDepth, 'RETENTION_EXCEEDED');
      const dirIdentity = identity(await fs.lstat(directory, { bigint: true }));
      requireFact(dirIdentity.type === 'directory', 'ROOT_CHANGED');
      result.directories.push({ path: directory, identity: dirIdentity });
      result.rows.push({
        path: path.relative(root, directory).split(path.sep).join('/'),
        type: 'directory',
        identity: dirIdentity,
      });
      checkFailure();
      for (const name of await this.names(directory, entryLimit)) {
        checkFailure();
        requireFact(++result.entries <= entryLimit, 'RETENTION_EXCEEDED');
        const absolute = path.join(directory, name),
          relative = path.relative(root, absolute).split(path.sep).join('/');
        requireFact(relativePath.safeParse(relative).success, 'INSTALLATION_INVALID');
        const stat = await fs.lstat(absolute, { bigint: true });
        checkFailure();
        if (library && relative === 'node_modules') {
          requireFact(stat.isDirectory() && !stat.isSymbolicLink(), 'LIBRARY_MISMATCH');
          await this.libraryBinMetadata(root, absolute);
          continue;
        }
        if (stat.isSymbolicLink()) {
          requireFact(!library, 'LIBRARY_MISMATCH');
          const link = await fs.readlink(absolute),
            resolved = await fs.realpath(absolute);
          requireFact(resolved.startsWith(root + path.sep), 'ROOT_CHANGED');
          const target = await fs.stat(resolved, { bigint: true });
          requireFact(target.isFile() || target.isDirectory(), 'ROOT_CHANGED');
          const after = await fs.lstat(absolute, { bigint: true });
          requireFact(
            stat.dev === after.dev &&
              stat.ino === after.ino &&
              stat.mtimeNs === after.mtimeNs &&
              stat.ctimeNs === after.ctimeNs &&
              link === (await fs.readlink(absolute)),
            'ROOT_CHANGED'
          );
          result.rows.push({
            path: relative,
            type: 'symlink',
            target: link,
            device: stat.dev.toString(),
            inode: stat.ino.toString(),
            mtimeNs: stat.mtimeNs.toString(),
            ctimeNs: stat.ctimeNs.toString(),
            mode: Number(stat.mode),
            uid: Number(stat.uid),
          });
        } else if (stat.isDirectory()) {
          await visit(absolute, depth + 1);
        } else {
          requireFact(stat.isFile(), 'INSTALLATION_INVALID');
          // Bank the task before its first I/O. Each read retains its original
          // descriptor custody and ancestry checks; no attestation is reused.
          const job: {
            relative: string;
            original: Promise<Awaited<ReturnType<NodeInstallationFilesystem['read']>>> | null;
          } = { relative, original: null };
          pending.push(job);
          job.original = Promise.resolve().then(() => {
            checkFailure();
            return this.read(absolute, library ? LIMIT.libraryFileBytes : LIMIT.payloadBytes);
          });
          void job.original.catch((value: unknown) => {
            first ??= { value };
          });
          if (pending.length === LARGE_HASH_BUFFER_SLOTS) await flush();
        }
      }
    };
    try {
      await visit(root, 0);
      await flush();
    } catch (value) {
      first ??= { value };
    } finally {
      // The single tree bank spans directories, including one-file locales.
      // Metadata and read failures drain every original before returning.
      await Promise.allSettled(pending.map((job) => job.original!));
    }
    checkFailure();
    // Each captured directory is revalidated only after its entire subtree's
    // original reads have settled; no child can escape a failed observation.
    for (const directory of [...result.directories].reverse())
      requireFact(
        sameFileIdentity(
          directory.identity,
          identity(await fs.lstat(directory.path, { bigint: true }))
        ),
        'ROOT_CHANGED'
      );
    await this.recheckParents(parents);
    result.rows.sort((a, b) =>
      String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0
    );
    return result;
  }

  private async assets(): Promise<void> {
    const c = this.configuration;
    const node = await this.read(c.nodeExecutable, LIMIT.executableBytes);
    requireFact(
      node.file.sha256 === c.nodeExecutableSHA256 && (node.file.identity.mode & 0o111) !== 0,
      'SOURCE_MISMATCH'
    );
    if (c.electronFramework) {
      const framework = await this.read(c.electronFramework.path, LIMIT.executableBytes);
      requireFact(
        framework.file.sha256 === c.electronFramework.sha256 &&
          (framework.file.identity.mode & 0o111) !== 0,
        'SOURCE_MISMATCH'
      );
    }
    const controller = await this.read(c.controllerEntry, LIMIT.controllerBytes);
    const verifier = await this.read(c.verifierEntry, LIMIT.libraryFileBytes);
    const vintage = await this.read(c.sourceManifestPath, LIMIT.manifestBytes, LIMIT.manifestBytes);
    const source = parseRecord(vintage.bytes, SourceManifestSchema, LIMIT.manifestBytes);
    requireFact(
      controller.file.sha256 === c.sourceVintage.controllerSHA256 &&
        verifier.file.sha256 === c.sourceVintage.verifierSHA256 &&
        vintage.file.sha256 === c.sourceVintage.sourceManifestSHA256 &&
        source.controllerSHA256 === controller.file.sha256 &&
        source.verifierSHA256 === verifier.file.sha256,
      'SOURCE_MISMATCH'
    );
  }
  async validateLibrary(): Promise<LibrarySnapshot> {
    return this.operation(async () => {
      this.supported();
      const tree = await this.tree(this.configuration.libraryRoot, true);
      requireFact(tree.files.length === 114, 'LIBRARY_MISMATCH');
      const distribution = createHash('sha256');
      for (const file of [...tree.files].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
      ))
        distribution.update(
          path.relative(this.configuration.libraryRoot, file.path).split(path.sep).join('/') +
            '\0' +
            file.sha256 +
            '\n'
        );
      const distributionSHA256 = distribution.digest('hex');
      requireFact(distributionSHA256 === TARGET.libraryDistributionSHA256, 'LIBRARY_MISMATCH');
      const find = (name: string): FileSnapshot => {
        const file = tree.files.find(
          (f) => f.path === path.join(this.configuration.libraryRoot, name)
        );
        requireFact(file, 'LIBRARY_MISMATCH');
        return file;
      };
      const pkg = await this.read(
        find('package.json').path,
        LIMIT.manifestBytes,
        LIMIT.manifestBytes
      );
      const browsers = await this.read(
        find('browsers.json').path,
        LIMIT.manifestBytes,
        LIMIT.manifestBytes
      );
      requireFact(
        pkg.file.sha256 === find('package.json').sha256 &&
          browsers.file.sha256 === find('browsers.json').sha256,
        'ROOT_CHANGED'
      );
      const packageJSON = scanJSON(pkg.bytes) as {
        name?: unknown;
        version?: unknown;
      };
      const browsersJSON = scanJSON(browsers.bytes) as { browsers?: unknown };
      requireFact(
        packageJSON?.name === TARGET.packageName &&
          packageJSON.version === TARGET.packageVersion &&
          Array.isArray(browsersJSON?.browsers),
        'LIBRARY_MISMATCH'
      );
      requireFact(
        browsersJSON.browsers.some(
          (b: unknown) =>
            !!b &&
            typeof b === 'object' &&
            'name' in b &&
            b.name === 'chromium' &&
            'revision' in b &&
            b.revision === TARGET.chromiumRevision &&
            'browserVersion' in b &&
            b.browserVersion === TARGET.observedVersion
        ),
        'LIBRARY_MISMATCH'
      );
      await this.assets();
      return Object.freeze({
        distributionSHA256,
        files: Object.freeze(tree.files),
        cli: find('cli.js'),
        browsersManifest: find('browsers.json'),
      });
    });
  }

  private reservation(handle: ReservationHandle): Reservation {
    const reservation = this.reservations.get(handle);
    requireFact(
      reservation &&
        reservation.state === 'held' &&
        sameBinding(reservation.handle.binding, handle.binding),
      'OWNERSHIP_UNCERTAIN'
    );
    requireFact(this.firstCause === null, 'CUSTODY_UNCERTAIN');
    return reservation;
  }
  private attempt(reservation: Reservation, handle: AttemptHandle): Attempt {
    const attempt = this.attempts.get(handle);
    requireFact(
      attempt &&
        attempt.reservation === reservation &&
        sameBinding(handle.binding, reservation.handle.binding),
      'BINDING_MISMATCH'
    );
    return attempt;
  }
  private candidate(handle: CandidateHandle): Candidate {
    const candidate = this.candidates.get(handle);
    requireFact(
      candidate && candidate.handle === handle && candidate.reservation.state === 'held',
      'OWNERSHIP_UNCERTAIN'
    );
    return candidate;
  }
  private async checkReservation(reservation: Reservation): Promise<void> {
    requireFact(reservation.state === 'held' && this.firstCause === null, 'CUSTODY_UNCERTAIN');
    await this.checkDirectory(reservation.root);
    await this.checkDirectory(reservation.directory);
  }
  private checkEnd(reservation: Reservation): void {
    requireFact(now() < reservation.bounds.finalEnd, 'FINAL_EXPIRED');
  }
  async acquireReservation(
    binding: AttemptBinding,
    bounds: AttemptBounds
  ): Promise<ReservationHandle> {
    return this.operation(async () => {
      this.supported();
      const parsedBinding = AttemptBindingSchema.parse(binding),
        parsedBounds = AttemptBoundsSchema.parse(bounds);
      requireFact(now() < parsedBounds.workEnd, 'WORK_EXPIRED');
      requireFact(!this.active || this.active.state === 'released', 'PUBLICATION_BUSY');
      await this.ensureDirectories(this.configuration.cacheRoot);
      // A held directory is unresolved until an actual reservation owns the lease.
      const root = await this.directory(this.configuration.cacheRoot);
      const name = path.join(root.path, 'reservation');
      try {
        await this.exclusiveDirectory(name);
      } catch (error) {
        try {
          await this.close(root.duty);
        } catch {
          /* Retain this exact root close fault. */
        }
        if (isExists(error)) throw new InstallationFailure('PUBLICATION_BUSY');
        throw error;
      }
      let directory: DirectoryLease;
      try {
        directory = await this.directory(name);
      } catch (error) {
        this.fault(error);
        try {
          await this.close(root.duty);
        } catch {
          /* Retain original. */
        }
        throw error;
      }
      const handle: ReservationHandle = Object.freeze({
        kind: 'installation-reservation',
        binding: Object.freeze(parsedBinding),
      });
      const owner: OwnerRecord = {
        schemaVersion: 1,
        binding: handle.binding,
        bounds: parsedBounds,
        phase: 'reserved',
        sourceVintage: this.configuration.sourceVintage,
      };
      const reservation: Reservation = {
        handle,
        bounds: parsedBounds,
        root,
        directory,
        state: 'held',
        owner,
        ownerFile: null,
        attempt: null,
        jobs: new Map(),
        diagnosticBudget: { bytes: 0, reserved: 0 },
        candidate: null,
      };
      this.reservations.set(handle, reservation);
      this.active = reservation;
      root.duty.lease = true;
      directory.duty.lease = true;
      try {
        reservation.ownerFile = await this.atomicRecord(
          path.join(name, 'owner.json'),
          owner,
          LIMIT.journalBytes,
          false
        );
        await this.syncDirectory(root.path);
        return handle;
      } catch (error) {
        reservation.state = 'uncertain';
        this.fault(error);
        throw error;
      }
    });
  }
  async createAttempt(handle: ReservationHandle): Promise<AttemptHandle> {
    return this.operation(async () => {
      const reservation = this.reservation(handle);
      await this.checkReservation(reservation);
      this.checkEnd(reservation);
      requireFact(reservation.attempt === null, 'BINDING_MISMATCH');
      const parent = path.join(this.configuration.cacheRoot, 'attempts');
      await this.ensureDirectories(parent);
      const root = path.join(parent, handle.binding.attemptId);
      await this.exclusiveDirectory(root);
      for (const child of ['home', 'tmp', 'diagnostics'])
        await this.exclusiveDirectory(path.join(root, child));
      await this.syncDirectory(root);
      await this.syncDirectory(parent);
      const stat = identity(await fs.lstat(root, { bigint: true }));
      const attempt: AttemptHandle = Object.freeze({
        kind: 'installation-attempt',
        binding: handle.binding,
        attemptRoot: root,
        homeRoot: path.join(root, 'home'),
        temporaryRoot: path.join(root, 'tmp'),
        identity: stat,
      });
      this.attempts.set(attempt, {
        reservation,
        handle: attempt,
        diagnostics: path.join(root, 'diagnostics'),
      });
      reservation.attempt = attempt;
      return attempt;
    });
  }
  private async atomicRecord(
    name: string,
    record: unknown,
    cap: number,
    replace: boolean
  ): Promise<FileSnapshot> {
    const bytes = recordBytes(record, cap),
      parent = path.dirname(name),
      parents = await this.ancestors(parent);
    if (!replace) {
      try {
        await fs.lstat(name);
        throw new InstallationFailure('RECORD_FAILED');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    const temporary = path.join(parent, '.installation-' + randomUUID() + '.tmp');
    const duty = await this.acquire(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    );
    const handle = duty.original as FileHandle;
    await this.closeAfter([duty], async () => {
      const stat = await handle.stat({ bigint: true });
      requireFact(stat.isFile() && Number(stat.uid) === process.getuid?.(), 'OWNERSHIP_UNCERTAIN');
      let written = 0;
      while (written < bytes.length) {
        const value = await handle.write(bytes, written, bytes.length - written, written);
        requireFact(value.bytesWritten > 0, 'IO_FAILED');
        written += value.bytesWritten;
      }
      await handle.sync();
      requireFact(
        sameFileIdentity(
          identity(await handle.stat({ bigint: true })),
          identity(await fs.lstat(temporary, { bigint: true }))
        ),
        'ROOT_CHANGED'
      );
      await this.recheckParents(parents);
    });
    if (!replace) {
      try {
        await fs.lstat(name);
        throw new InstallationFailure('RECORD_FAILED');
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    await this.recheckParents(parents);
    await fs.rename(temporary, name);
    await this.syncDirectory(parent);
    const result = await this.read(name, cap, cap);
    requireFact(result.file.sha256 === sha256(bytes), 'RECORD_FAILED');
    return result.file;
  }
  async writeOwner(
    reservationHandle: ReservationHandle,
    attemptHandle: AttemptHandle,
    record: OwnerRecord
  ): Promise<void> {
    return this.operation(async () => {
      const reservation = this.reservation(reservationHandle);
      this.attempt(reservation, attemptHandle);
      const parsed = OwnerRecordSchema.parse(record);
      requireFact(
        sameBinding(parsed.binding, reservationHandle.binding) &&
          canonicalDigest(parsed.bounds) === canonicalDigest(reservation.bounds) &&
          canonicalDigest(parsed.sourceVintage) ===
            canonicalDigest(this.configuration.sourceVintage),
        'BINDING_MISMATCH'
      );
      if (parsed.births)
        requireFact(
          parsed.births.every((birth) => {
            const job = reservation.jobs.get(birth.jobId);
            return job?.birth && canonicalDigest(job.birth) === canonicalDigest(birth);
          }),
          'BINDING_MISMATCH'
        );
      await this.checkReservation(reservation);
      this.checkEnd(reservation);
      const old = await this.read(
        path.join(reservation.directory.path, 'owner.json'),
        LIMIT.journalBytes,
        LIMIT.journalBytes
      );
      requireFact(
        reservation.ownerFile &&
          old.file.sha256 === reservation.ownerFile.sha256 &&
          sameFileIdentity(old.file.identity, reservation.ownerFile.identity),
        'ROOT_CHANGED'
      );
      reservation.ownerFile = await this.atomicRecord(
        old.file.path,
        parsed,
        LIMIT.journalBytes,
        true
      );
      reservation.owner = parsed;
    });
  }
  async stageCandidate(
    handle: ReservationHandle,
    attemptHandle: AttemptHandle
  ): Promise<CandidateHandle> {
    return this.operation(async () => {
      const reservation = this.reservation(handle),
        attempt = this.attempt(reservation, attemptHandle);
      requireFact(reservation.candidate === null, 'BINDING_MISMATCH');
      await this.checkReservation(reservation);
      this.checkEnd(reservation);
      const parent = path.join(this.configuration.cacheRoot, 'candidates');
      await this.ensureDirectories(parent);
      const candidateRoot = path.join(parent, handle.binding.installationId);
      await this.exclusiveDirectory(candidateRoot);
      const payloadRoot = path.join(candidateRoot, 'payload');
      await this.exclusiveDirectory(payloadRoot);
      const candidate: CandidateHandle = Object.freeze({
        kind: 'installation-candidate',
        binding: handle.binding,
        candidateRoot,
        payloadRoot,
        reuse: false,
      });
      this.candidates.set(candidate, {
        handle: candidate,
        reservation,
        attempt,
        durable: null,
      });
      reservation.candidate = candidate;
      return candidate;
    });
  }
  async bindExistingCandidate(
    handle: ReservationHandle,
    attemptHandle: AttemptHandle,
    installation: ExistingInstallation
  ): Promise<CandidateHandle> {
    return this.operation(async () => {
      const reservation = this.reservation(handle),
        attempt = this.attempt(reservation, attemptHandle);
      requireFact(reservation.candidate === null, 'BINDING_MISMATCH');
      requireFact(
        this.existing.has(installation) &&
          installation.manifest.installationId === handle.binding.installationId,
        'BINDING_MISMATCH'
      );
      await this.checkReservation(reservation);
      requireFact(compareCurrent(installation.current, await this.current()), 'ROOT_CHANGED');
      const candidate: CandidateHandle = Object.freeze({
        kind: 'installation-candidate',
        binding: handle.binding,
        candidateRoot: installation.candidate.candidateRoot,
        payloadRoot: installation.candidate.payloadRoot,
        reuse: true,
      });
      this.candidates.set(candidate, {
        handle: candidate,
        reservation,
        attempt,
        durable: null,
      });
      await this.revalidateCandidate(candidate, installation.candidate);
      reservation.candidate = candidate;
      return candidate;
    });
  }
  private async snapshot(
    installationId: string,
    candidateRoot: string
  ): Promise<CandidateSnapshot> {
    const payloadRoot = path.join(candidateRoot, 'payload'),
      tree = await this.tree(payloadRoot);
    const executablePath = path.join(candidateRoot, TARGET.executablePath);
    const executable = await this.read(executablePath, LIMIT.executableBytes);
    const observed = tree.files.find((file) => file.path === executablePath);
    requireFact(
      observed &&
        observed.sha256 === executable.file.sha256 &&
        sameFileIdentity(observed.identity, executable.file.identity),
      'ROOT_CHANGED'
    );
    requireFact(
      (executable.file.identity.mode & 0o111) !== 0 &&
        executable.prefix.length >= 8 &&
        Buffer.from(executable.prefix).readUInt32LE(0) === 0xfeedfacf &&
        Buffer.from(executable.prefix).readUInt32LE(4) === 16777228,
      'INSTALLATION_INVALID'
    );
    return Object.freeze({
      installationId,
      candidateRoot,
      payloadRoot,
      executable: executable.file,
      machOCPU: 16777228,
      inventoryDigest: canonicalDigest(tree.rows),
      entries: tree.entries,
      bytes: tree.bytes,
    });
  }
  async observeCandidate(handle: CandidateHandle): Promise<CandidateSnapshot> {
    return this.operation(async () => {
      const candidate = this.candidate(handle);
      await this.checkReservation(candidate.reservation);
      return this.snapshot(handle.binding.installationId, handle.candidateRoot);
    });
  }
  async revalidateCandidate(handle: CandidateHandle, expected: CandidateSnapshot): Promise<void> {
    return this.operation(async () => {
      requireFact(sameSnapshot(expected, await this.observeCandidate(handle)), 'ROOT_CHANGED');
    });
  }

  private async current(): Promise<CurrentObservation> {
    try {
      const value = await this.read(
        path.join(this.configuration.cacheRoot, 'current.json'),
        LIMIT.pointerBytes,
        LIMIT.pointerBytes
      );
      try {
        return {
          state: 'present',
          file: value.file,
          pointer: parseRecord(value.bytes, PointerSchema, LIMIT.pointerBytes),
        };
      } catch {
        return { state: 'invalid', file: value.file };
      }
    } catch (error) {
      if (isMissing(error)) return { state: 'absent' };
      throw error;
    }
  }
  async inspectExisting(options?: InspectOptions): Promise<ExistingInspection> {
    return this.operation(async () => {
      const common = {
        schemaVersion: 1 as const,
        pinnedPackageVersion: TARGET.packageVersion,
        chromiumRevision: TARGET.chromiumRevision,
        platform: this.configuration.platform,
        arch: this.configuration.arch,
        observation: 'files-only' as const,
        readiness: READINESS_UNAVAILABLE,
      };
      let current: CurrentObservation = { state: 'unknown' };
      if (this.configuration.platform !== 'darwin' || this.configuration.arch !== 'arm64')
        return {
          status: {
            ...common,
            state: 'unsupported',
            cause: 'PLATFORM_UNSUPPORTED',
          },
          current,
          installation: null,
        };
      try {
        requireFact(!options?.signal?.aborted, 'ABORTED');
        current = await this.current();
        if (current.state === 'absent')
          return {
            status: { ...common, state: 'missing', cause: null },
            current,
            installation: null,
          };
        requireFact(current.state === 'present', 'INSTALLATION_INVALID');
        const root = path.join(
          this.configuration.cacheRoot,
          'candidates',
          current.pointer.installationId
        );
        const manifestRead = await this.read(
          path.join(root, 'manifest.json'),
          LIMIT.manifestBytes,
          LIMIT.manifestBytes
        );
        requireFact(
          manifestRead.file.sha256 === current.pointer.manifestDigest,
          'INSTALLATION_INVALID'
        );
        const manifest = parseRecord(manifestRead.bytes, ManifestSchema, LIMIT.manifestBytes);
        const verificationRead = await this.read(
          path.join(root, 'verification.json'),
          LIMIT.journalBytes,
          LIMIT.journalBytes
        );
        const verification = parseRecord(
          verificationRead.bytes,
          VerificationRecordSchema,
          LIMIT.journalBytes
        );
        const candidate = await this.snapshot(manifest.installationId, root);
        await this.validateLibrary();
        requireFact(
          manifest.installationId === current.pointer.installationId &&
            manifest.executablePath === TARGET.executablePath &&
            manifest.libraryDistributionSHA256 === TARGET.libraryDistributionSHA256 &&
            manifest.chromiumRevision === TARGET.chromiumRevision &&
            manifest.observedVersion === TARGET.observedVersion &&
            manifest.platform === 'darwin' &&
            manifest.arch === 'arm64' &&
            manifest.executableSHA256 === candidate.executable.sha256 &&
            manifest.verifierEvidence.evidenceDigest === canonicalDigest(verification) &&
            manifest.verifierEvidence.attemptId === verification.binding.attemptId &&
            manifest.verifierEvidence.generation === verification.binding.generation &&
            verification.binding.installationId === manifest.installationId &&
            sameBinding(verification.binding, verification.reply.binding) &&
            verification.candidateInventoryDigest === candidate.inventoryDigest &&
            verification.libraryDistributionSHA256 === TARGET.libraryDistributionSHA256 &&
            verification.sourceManifestSHA256 === verification.reply.sourceManifestSHA256 &&
            verification.reply.libraryDistributionSHA256 === TARGET.libraryDistributionSHA256 &&
            verification.reply.executableSHA256 === candidate.executable.sha256 &&
            sameFileIdentity(verification.reply.executableIdentity, candidate.executable.identity),
          'INSTALLATION_INVALID'
        );
        requireFact(compareCurrent(current, await this.current()), 'ROOT_CHANGED');
        const installation: ExistingInstallation = Object.freeze({
          current,
          manifest,
          manifestFile: manifestRead.file,
          verification,
          verificationFile: verificationRead.file,
          candidate,
        });
        this.existing.add(installation);
        const status: RuntimeInstallationStatus = {
          ...common,
          state: 'installed-files',
          cause: null,
          installationId: manifest.installationId,
          executableSHA256: candidate.executable.sha256,
          currentManifestDigest: current.pointer.manifestDigest,
          lastFreshVerifiedVersion: manifest.observedVersion,
          historicalAttemptId: manifest.verifierEvidence.attemptId,
          historicalGeneration: manifest.verifierEvidence.generation,
          verificationDigest: verificationRead.file.sha256,
        };
        return { status, current, installation };
      } catch (error) {
        const code = failureCode(error),
          invalid =
            isMissing(error) ||
            [
              'INSTALLATION_INVALID',
              'LIBRARY_MISMATCH',
              'HASH_MISMATCH',
              'VERSION_MISMATCH',
              'RETENTION_EXCEEDED',
            ].includes(code);
        return {
          status: invalid
            ? { ...common, state: 'invalid', cause: 'INSTALLATION_INVALID' }
            : {
                ...common,
                state: 'unverified',
                cause: 'VERIFICATION_UNAVAILABLE',
              },
          current,
          installation: null,
        };
      }
    });
  }

  async makeCandidateDurable(handle: CandidateHandle, expected: CandidateSnapshot): Promise<void> {
    return this.operation(async () => {
      const candidate = this.candidate(handle);
      requireFact(!handle.reuse, 'BINDING_MISMATCH');
      await this.checkReservation(candidate.reservation);
      this.checkEnd(candidate.reservation);
      await this.revalidateCandidate(handle, expected);
      const tree = await this.tree(handle.payloadRoot);
      requireFact(canonicalDigest(tree.rows) === expected.inventoryDigest, 'ROOT_CHANGED');
      for (const file of tree.files) {
        const duty = await this.acquire(
          file.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const original = duty.original as FileHandle;
        await this.closeAfter([duty], async () => {
          requireFact(
            sameFileIdentity(file.identity, identity(await original.stat({ bigint: true }))),
            'ROOT_CHANGED'
          );
          await original.sync();
          requireFact(
            sameFileIdentity(file.identity, identity(await original.stat({ bigint: true }))) &&
              sameFileIdentity(
                file.identity,
                identity(await fs.lstat(file.path, { bigint: true }))
              ),
            'ROOT_CHANGED'
          );
        });
        this.checkEnd(candidate.reservation);
      }
      for (const directory of [...tree.directories].reverse())
        await this.syncDirectory(directory.path);
      await this.syncDirectory(handle.candidateRoot);
      await this.syncDirectory(path.dirname(handle.candidateRoot));
      await this.syncDirectory(this.configuration.cacheRoot);
      await this.revalidateCandidate(handle, expected);
      candidate.durable = await this.observeCandidate(handle);
    });
  }
  private async verifyLocalRecord(
    reservation: Reservation,
    candidate: CandidateSnapshot,
    record: VerificationRecord,
    installerInvoked: boolean
  ): Promise<void> {
    requireFact(
      record.libraryDistributionSHA256 === TARGET.libraryDistributionSHA256 &&
        record.reply.libraryDistributionSHA256 === TARGET.libraryDistributionSHA256 &&
        record.sourceManifestSHA256 === this.configuration.sourceVintage.sourceManifestSHA256 &&
        record.reply.sourceManifestSHA256 === record.sourceManifestSHA256 &&
        record.reply.executableSHA256 === candidate.executable.sha256 &&
        sameFileIdentity(record.reply.executableIdentity, candidate.executable.identity) &&
        record.candidateInventoryDigest === candidate.inventoryDigest,
      'BINDING_MISMATCH'
    );
    const returned = (id: string, role: JobIntent['role'], digest: string): SinkJob => {
      const job = reservation.jobs.get(id),
        facts = job?.receipt;
      requireFact(
        job &&
          facts &&
          job.birth &&
          facts.role === role &&
          job.intent.role === role &&
          sameBinding(facts.binding, reservation.handle.binding) &&
          canonicalDigest(facts) === digest &&
          facts.exitObserved &&
          facts.closeObserved &&
          facts.exitCode === 0 &&
          facts.signal === null &&
          facts.firstCause === null &&
          facts.cleanupCauses.length === 0 &&
          !facts.stopRequested &&
          [facts.stdout, facts.stderr].every(
            (s) => s.eof && s.closed && s.rawFlushedClosed && !s.overflow
          ) &&
          job.writers.every((w) => w.finished),
        'CUSTODY_UNCERTAIN'
      );
      return job;
    };
    const verifier = returned(
      record.verifier.jobId,
      'fresh-verifier',
      record.verifier.receiptDigest
    );
    for (const job of reservation.jobs.values())
      for (const writer of job.writers) await writer.checkFinal();
    const reply = await this.read(
      verifier.prefix + '.stdout.raw',
      LIMIT.replyBytes,
      LIMIT.replyBytes
    );
    requireFact(
      verifier.writers[0]?.finalSnapshot &&
        sameFileIdentity(reply.file.identity, verifier.writers[0].finalSnapshot.identity) &&
        reply.file.sha256 === verifier.writers[0].finalSnapshot.sha256 &&
        reply.file.sha256 === record.verifier.replyDigest &&
        canonicalDigest(parseRecord(reply.bytes, FreshVerifierReplySchema, LIMIT.replyBytes)) ===
          canonicalDigest(record.reply),
      'BINDING_MISMATCH'
    );
    if (installerInvoked) {
      requireFact(record.installer.kind === 'invoked', 'BINDING_MISMATCH');
      returned(record.installer.jobId, 'official-install', record.installer.receiptDigest);
    } else requireFact(record.installer.kind === 'not-invoked', 'BINDING_MISMATCH');
    requireFact(reservation.jobs.size === (installerInvoked ? 2 : 1), 'BINDING_MISMATCH');
    // This validates this producer's diagnostics and correspondence. J still owns child-return authority.
  }
  async publish(
    reservationHandle: ReservationHandle,
    candidateHandle: CandidateHandle,
    manifest: Manifest,
    verification: VerificationRecord,
    before: CurrentObservation
  ): Promise<PublicationFacts> {
    return this.operation(async () => {
      const reservation = this.reservation(reservationHandle),
        candidate = this.candidate(candidateHandle);
      requireFact(
        candidate.reservation === reservation && !candidateHandle.reuse && candidate.durable,
        'CUSTODY_UNCERTAIN'
      );
      const parsedManifest = ManifestSchema.parse(manifest),
        parsedVerification = VerificationRecordSchema.parse(verification);
      requireFact(
        sameBinding(parsedVerification.binding, reservationHandle.binding) &&
          sameBinding(parsedVerification.reply.binding, reservationHandle.binding) &&
          parsedManifest.installationId === reservationHandle.binding.installationId &&
          parsedManifest.executablePath === TARGET.executablePath &&
          parsedManifest.executableSHA256 === candidate.durable.executable.sha256 &&
          parsedManifest.verifierEvidence.evidenceDigest === canonicalDigest(parsedVerification) &&
          parsedManifest.verifierEvidence.attemptId === reservationHandle.binding.attemptId &&
          parsedManifest.verifierEvidence.generation === reservationHandle.binding.generation &&
          parsedVerification.candidateInventoryDigest === candidate.durable.inventoryDigest &&
          parsedManifest.packageName === TARGET.packageName &&
          parsedManifest.packageVersion === TARGET.packageVersion &&
          parsedManifest.libraryDistributionSHA256 === TARGET.libraryDistributionSHA256 &&
          parsedManifest.chromiumRevision === TARGET.chromiumRevision &&
          parsedManifest.observedVersion === TARGET.observedVersion &&
          parsedManifest.platform === TARGET.platform &&
          parsedManifest.arch === TARGET.arch,
        'BINDING_MISMATCH'
      );
      try {
        await this.verifyLocalRecord(reservation, candidate.durable, parsedVerification, true);
      } catch (error) {
        this.fault(error);
        throw error;
      }
      const manifestBytes = recordBytes(parsedManifest, LIMIT.manifestBytes),
        verificationBytes = recordBytes(parsedVerification, LIMIT.journalBytes);
      const manifestDigest = sha256(manifestBytes),
        verificationDigest = sha256(verificationBytes);
      let pointerReplaced = false,
        replacementAttempted = false,
        after: CurrentObservation = { state: 'unknown' };
      try {
        await this.checkReservation(reservation);
        this.checkEnd(reservation);
        await this.revalidateCandidate(candidateHandle, candidate.durable);
        requireFact(compareCurrent(before, await this.current()), 'ROOT_CHANGED');
        await this.atomicRecord(
          path.join(candidateHandle.candidateRoot, 'verification.json'),
          parsedVerification,
          LIMIT.journalBytes,
          false
        );
        await this.atomicRecord(
          path.join(candidateHandle.candidateRoot, 'manifest.json'),
          parsedManifest,
          LIMIT.manifestBytes,
          false
        );
        await this.syncDirectory(path.dirname(candidateHandle.candidateRoot));
        await this.revalidateCandidate(candidateHandle, candidate.durable);
        requireFact(compareCurrent(before, await this.current()), 'ROOT_CHANGED');
        this.checkEnd(reservation);
        const pointer = recordBytes(
          {
            schemaVersion: 1,
            installationId: parsedManifest.installationId,
            manifestDigest,
          },
          LIMIT.pointerBytes
        );
        const temporary = path.join(
          this.configuration.cacheRoot,
          '.current-' + randomUUID() + '.json'
        );
        const file = await this.atomicRecord(
          temporary,
          parseRecord(pointer, PointerSchema, LIMIT.pointerBytes),
          LIMIT.pointerBytes,
          false
        );
        requireFact(file.sha256 === sha256(pointer), 'RECORD_FAILED');
        await this.checkReservation(reservation);
        requireFact(compareCurrent(before, await this.current()), 'ROOT_CHANGED');
        this.checkEnd(reservation);
        replacementAttempted = true;
        await fs.rename(temporary, path.join(this.configuration.cacheRoot, 'current.json'));
        pointerReplaced = true;
        await this.syncDirectory(this.configuration.cacheRoot);
        after = await this.current();
        requireFact(
          after.state === 'present' &&
            after.pointer.manifestDigest === manifestDigest &&
            after.pointer.installationId === parsedManifest.installationId,
          'PUBLICATION_UNCERTAIN'
        );
        await this.revalidateCandidate(candidateHandle, candidate.durable);
        this.checkEnd(reservation);
        return {
          state: 'durable',
          pointerReplaced,
          currentBefore: before,
          currentAfter: after,
          manifestDigest,
          verificationDigest,
          firstCause: null,
        };
      } catch (error) {
        this.fault(error);
        reservation.state = 'uncertain';
        try {
          after = await this.current();
        } catch {
          /* Unknown remains explicit. */
        }
        if (replacementAttempted && !pointerReplaced && !compareCurrent(before, after))
          throw new InstallationFailure('PUBLICATION_UNCERTAIN', true);
        return {
          state: 'uncertain',
          pointerReplaced,
          currentBefore: before,
          currentAfter: after,
          manifestDigest,
          verificationDigest,
          firstCause: pointerReplaced ? 'PUBLICATION_UNCERTAIN' : failureCode(error),
        };
      }
    });
  }
  async writeReuseJournal(
    handle: ReservationHandle,
    attemptHandle: AttemptHandle,
    record: ReuseRecord
  ): Promise<FileSnapshot> {
    return this.operation(async () => {
      const reservation = this.reservation(handle),
        attempt = this.attempt(reservation, attemptHandle),
        parsed = ReuseRecordSchema.parse(record);
      requireFact(
        sameBinding(parsed.binding, handle.binding) &&
          sameBinding(parsed.freshVerification.binding, handle.binding) &&
          sameBinding(parsed.freshVerification.reply.binding, handle.binding) &&
          parsed.freshVerification.installer.kind === 'not-invoked',
        'BINDING_MISMATCH'
      );
      await this.checkReservation(reservation);
      this.checkEnd(reservation);
      const current = await this.current();
      requireFact(
        current.state === 'present' &&
          current.pointer.installationId === handle.binding.installationId &&
          current.pointer.manifestDigest === parsed.currentManifestDigest,
        'ROOT_CHANGED'
      );
      requireFact(reservation.candidate?.reuse, 'BINDING_MISMATCH');
      try {
        await this.verifyLocalRecord(
          reservation,
          await this.observeCandidate(reservation.candidate),
          parsed.freshVerification,
          false
        );
      } catch (error) {
        this.fault(error);
        throw error;
      }
      const oldVerification = await this.read(
        path.join(
          this.configuration.cacheRoot,
          'candidates',
          handle.binding.installationId,
          'verification.json'
        ),
        LIMIT.journalBytes
      );
      requireFact(
        oldVerification.file.sha256 === parsed.historicalVerificationDigest,
        'BINDING_MISMATCH'
      );
      const file = await this.atomicRecord(
        path.join(attempt.handle.attemptRoot, 'reuse.json'),
        parsed,
        LIMIT.journalBytes,
        false
      );
      await this.syncDirectory(path.dirname(attempt.handle.attemptRoot));
      requireFact(compareCurrent(current, await this.current()), 'ROOT_CHANGED');
      return file;
    });
  }

  private async writer(
    name: string,
    reservation: Reservation | null,
    diagnosticBudget: { bytes: number; reserved: number }
  ): Promise<WriterState> {
    const parents = await this.ancestors(path.dirname(name));
    const duty = await this.acquire(
      name,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    );
    const original = duty.original as FileHandle;
    let bytes = 0,
      reserved = 0,
      queue: Promise<void> = Promise.resolve(),
      finish: Promise<void> | null = null;
    const state = {} as WriterState;
    let expected: FileIdentity;
    let hash: ReturnType<typeof createHash>;
    const observe = async (size: number, growth = false): Promise<FileIdentity> => {
      const held = identity(await original.stat({ bigint: true })),
        named = identity(await fs.lstat(name, { bigint: true }));
      requireFact(
        held.type === 'file' && held.size === String(size) && sameFileIdentity(held, named),
        'ROOT_CHANGED'
      );
      requireFact(
        growth
          ? held.device === expected.device &&
              held.inode === expected.inode &&
              held.uid === expected.uid &&
              held.mode === expected.mode &&
              held.type === expected.type
          : sameFileIdentity(held, expected),
        'ROOT_CHANGED'
      );
      await this.recheckParents(parents);
      return held;
    };
    try {
      const stat = await original.stat({ bigint: true });
      requireFact(
        stat.isFile() && Number(stat.uid) === process.getuid?.() && stat.size === 0n,
        'OWNERSHIP_UNCERTAIN'
      );
      expected = identity(stat);
      hash = createHash('sha256');
      await observe(0);
      await original.sync();
      await observe(0);
    } catch (error) {
      this.fault(error);
      try {
        await this.close(duty);
      } catch {
        /* Preserve original close ambiguity. */
      }
      throw error;
    }
    const writer: RawWriter = Object.freeze({
      write: (chunk: Uint8Array): Promise<void> => {
        if (finish) return Promise.reject(new InstallationFailure('CUSTODY_UNCERTAIN'));
        if (
          chunk.byteLength > LIMIT.bufferBytes ||
          reserved + chunk.byteLength > LIMIT.streamBytes ||
          diagnosticBudget.reserved + chunk.byteLength > LIMIT.diagnosticBytes
        ) {
          const error = new InstallationFailure('RETENTION_EXCEEDED');
          this.fault(error);
          return Promise.reject(error);
        }
        reserved += chunk.byteLength;
        diagnosticBudget.reserved += chunk.byteLength;
        const copy = Uint8Array.from(chunk);
        const next = queue.then(() =>
          this.operation(async () => {
            requireFact(
              copy.byteLength <= LIMIT.bufferBytes && bytes + copy.byteLength <= LIMIT.streamBytes,
              'RETENTION_EXCEEDED'
            );
            requireFact(
              diagnosticBudget.bytes + copy.byteLength <= LIMIT.diagnosticBytes,
              'RETENTION_EXCEEDED'
            );
            if (reservation) await this.checkReservation(reservation);
            await observe(bytes);
            let written = 0;
            while (written < copy.byteLength) {
              const value = await original.write(
                copy,
                written,
                copy.byteLength - written,
                bytes + written
              );
              requireFact(value.bytesWritten > 0, 'IO_FAILED');
              written += value.bytesWritten;
            }
            bytes += written;
            diagnosticBudget.bytes += written;
            hash.update(copy);
            expected = await observe(bytes, true);
          })
        );
        queue = next;
        void next.catch((error) => this.fault(error));
        return next;
      },
      finish: (): Promise<void> => {
        finish ??= this.operation(async () => {
          let first: unknown;
          try {
            await queue;
          } catch (error) {
            first = error;
            this.fault(error);
          }
          try {
            await observe(bytes);
          } catch (error) {
            first ??= error;
            this.fault(error);
          }
          try {
            await original.sync();
          } catch (error) {
            first ??= error;
            this.fault(error);
          }
          try {
            await observe(bytes);
          } catch (error) {
            first ??= error;
            this.fault(error);
          }
          try {
            await this.close(duty);
            state.finished = true;
          } catch (error) {
            first ??= error;
          }
          try {
            await this.syncDirectory(path.dirname(name));
          } catch (error) {
            first ??= error;
            this.fault(error);
          }
          if (first === undefined) {
            try {
              const final = await this.read(name, LIMIT.streamBytes);
              requireFact(
                sameFileIdentity(expected, final.file.identity) &&
                  final.file.bytes === bytes &&
                  final.file.sha256 === hash.digest('hex'),
                'ROOT_CHANGED'
              );
              state.finalSnapshot = final.file;
            } catch (error) {
              first = error;
              this.fault(error);
            }
          }
          if (first !== undefined) throw first;
        });
        return finish;
      },
    });
    Object.assign(state, {
      writer,
      duty,
      finished: false,
      finalSnapshot: null,
      checkFinal: async (): Promise<FileSnapshot> => {
        try {
          requireFact(state.finished && state.finalSnapshot, 'CUSTODY_UNCERTAIN');
          const current = await this.read(name, LIMIT.streamBytes);
          requireFact(
            sameFileIdentity(current.file.identity, state.finalSnapshot.identity) &&
              current.file.sha256 === state.finalSnapshot.sha256 &&
              current.file.bytes === state.finalSnapshot.bytes,
            'ROOT_CHANGED'
          );
          await this.recheckParents(parents);
          return current.file;
        } catch (error) {
          this.fault(error);
          throw error;
        }
      },
    });
    return state;
  }
  private sink(
    attempt: AttemptHandle,
    reservation: Reservation | null,
    probe: FreshAdmission | null
  ): InstallationJobSink {
    const jobs = reservation?.jobs ?? new Map<string, SinkJob>(),
      budget = reservation?.diagnosticBudget ?? { bytes: 0, reserved: 0 };
    const diagnostics = path.join(attempt.attemptRoot, 'diagnostics');
    const reobserve = async (): Promise<void> => {
      if (reservation) await this.checkReservation(reservation);
      requireFact(
        sameFileIdentity(
          attempt.identity,
          identity(await fs.lstat(attempt.attemptRoot, { bigint: true }))
        ),
        'ROOT_CHANGED'
      );
      await this.ancestors(diagnostics);
      if (probe) requireFact(canonicalDigest(probe.request) === probe.digest, 'BINDING_MISMATCH');
    };
    return Object.freeze({
      prepare: (intent: JobIntent): Promise<JobOutput> =>
        this.operation(async () => {
          const parsed = JobIntentSchema.parse(intent);
          requireFact(
            sameBinding(parsed.binding, attempt.binding) &&
              canonicalDigest(parsed.bounds) ===
                canonicalDigest(reservation?.bounds ?? probe!.request.bounds),
            'BINDING_MISMATCH'
          );
          requireFact(
            probe
              ? parsed.role === 'version-probe' && jobs.size === 0
              : parsed.role !== 'version-probe' && jobs.size < 2,
            'BINDING_MISMATCH'
          );
          requireFact(!jobs.has(parsed.jobId), 'BINDING_MISMATCH');
          await reobserve();
          const prefix = path.join(diagnostics, (probe ? 'probe_' : '') + parsed.jobId);
          const job: SinkJob = {
            intent: parsed,
            prefix,
            output: null,
            writers: [],
            birth: null,
            receipt: null,
          };
          jobs.set(parsed.jobId, job);
          try {
            job.writers.push(await this.writer(prefix + '.stdout.raw', reservation, budget));
            job.writers.push(await this.writer(prefix + '.stderr.raw', reservation, budget));
            await this.atomicRecord(prefix + '.intent.json', parsed, LIMIT.journalBytes, false);
            await this.syncDirectory(diagnostics);
            await reobserve();
            job.output = Object.freeze({
              stdout: job.writers[0]!.writer,
              stderr: job.writers[1]!.writer,
            });
            return job.output;
          } catch (error) {
            this.fault(error);
            for (const writer of job.writers) {
              try {
                await writer.writer.finish();
              } catch {
                /* Peer original still receives its finish attempt. */
              }
            }
            throw error;
          }
        }),
      birth: (facts: JobBirth): Promise<void> =>
        this.operation(async () => {
          const parsed = JobBirthSchema.parse(facts),
            job = jobs.get(parsed.jobId);
          requireFact(job && job.output && !job.birth, 'BINDING_MISMATCH');
          const { pid: _pid, ...intent } = parsed;
          requireFact(canonicalDigest(intent) === canonicalDigest(job.intent), 'BINDING_MISMATCH');
          await reobserve();
          await this.atomicRecord(job.prefix + '.birth.json', parsed, LIMIT.journalBytes, false);
          job.birth = parsed;
          if (reservation) {
            const births = [...reservation.jobs.values()].flatMap((item) =>
              item.birth ? [item.birth] : []
            );
            await this.writeOwner(reservation.handle, attempt, {
              ...reservation.owner,
              births,
            });
          }
        }),
      receipt: (facts: JobFacts): Promise<void> =>
        this.operation(async () => {
          const parsed = factsSchema.parse(facts),
            job = jobs.get(parsed.jobId);
          requireFact(
            job &&
              !job.receipt &&
              sameBinding(parsed.binding, job.intent.binding) &&
              parsed.role === job.intent.role &&
              canonicalDigest(parsed.birth) === canonicalDigest(job.birth),
            'BINDING_MISMATCH'
          );
          requireFact(
            job.writers.every((writer) => writer.finished),
            'CUSTODY_UNCERTAIN'
          );
          await reobserve();
          const streams = [parsed.stdout, parsed.stderr];
          for (const [index, writer] of job.writers.entries()) {
            const file = await writer.checkFinal(),
              stream = streams[index]!;
            requireFact(
              stream.retainedBytes === file.bytes && stream.observedBytes >= stream.retainedBytes,
              'BINDING_MISMATCH'
            );
          }
          await this.atomicRecord(job.prefix + '.receipt.json', parsed, LIMIT.journalBytes, false);
          job.receipt = parsed;
        }),
    });
  }
  createJobSink(handle: ReservationHandle, attemptHandle: AttemptHandle): InstallationJobSink {
    const reservation = this.reservation(handle);
    this.attempt(reservation, attemptHandle);
    return this.sink(attemptHandle, reservation, null);
  }
  async inspectFreshRequest(
    request: FreshVerifierRequest
  ): Promise<Readonly<{ candidate: CandidateSnapshot; library: LibrarySnapshot }>> {
    return this.operation(async () => {
      const parsed = FreshVerifierRequestSchema.parse(request),
        c = this.configuration;
      requireFact(
        process.platform === 'darwin' && process.arch === 'arm64',
        'PLATFORM_UNSUPPORTED'
      );
      requireFact(!this.freshAdmissionStarted, 'BINDING_MISMATCH');
      this.freshAdmissionStarted = true;
      requireFact(
        parsed.cacheRoot === c.cacheRoot &&
          parsed.libraryRoot === c.libraryRoot &&
          parsed.nodeExecutable === c.nodeExecutable &&
          parsed.nodeExecutableSHA256 === c.nodeExecutableSHA256 &&
          parsed.verifierEntry === c.verifierEntry &&
          parsed.controllerEntry === c.controllerEntry &&
          parsed.sourceManifestPath === c.sourceManifestPath &&
          canonicalDigest(parsed.sourceVintage) === canonicalDigest(c.sourceVintage) &&
          path.resolve(process.execPath) === c.nodeExecutable &&
          process.argv[1] &&
          path.resolve(process.argv[1]) === c.verifierEntry,
        'SOURCE_MISMATCH'
      );
      requireFact(
        parsed.attemptRoot === path.join(c.cacheRoot, 'attempts', parsed.binding.attemptId) &&
          parsed.candidateRoot ===
            path.join(c.cacheRoot, 'candidates', parsed.binding.installationId) &&
          parsed.executablePath === TARGET.executablePath,
        'BINDING_MISMATCH'
      );
      const attempt = identity(await fs.lstat(parsed.attemptRoot, { bigint: true }));
      requireFact(sameFileIdentity(attempt, parsed.attemptIdentity), 'ROOT_CHANGED');
      await this.ancestors(parsed.attemptRoot);
      const ownerRead = await this.read(
        path.join(c.cacheRoot, 'reservation', 'owner.json'),
        LIMIT.journalBytes,
        LIMIT.journalBytes
      );
      const owner = parseRecord(ownerRead.bytes, OwnerRecordSchema, LIMIT.journalBytes);
      requireFact(
        sameBinding(owner.binding, parsed.binding) &&
          canonicalDigest(owner.bounds) === canonicalDigest(parsed.bounds) &&
          canonicalDigest(owner.sourceVintage) === canonicalDigest(parsed.sourceVintage) &&
          owner.phase === 'verifying',
        'BINDING_MISMATCH'
      );
      const birth = owner.births?.find(
        (entry) => entry.role === 'fresh-verifier' && entry.pid === process.pid
      );
      requireFact(
        birth && birth.executable === c.nodeExecutable && birth.argv.includes(c.verifierEntry),
        'BINDING_MISMATCH'
      );
      const prefix = path.join(parsed.attemptRoot, 'diagnostics', birth.jobId);
      const intentRead = await this.read(
        prefix + '.intent.json',
        LIMIT.journalBytes,
        LIMIT.journalBytes
      );
      const birthRead = await this.read(
        prefix + '.birth.json',
        LIMIT.journalBytes,
        LIMIT.journalBytes
      );
      const intent = parseRecord(intentRead.bytes, JobIntentSchema, LIMIT.journalBytes);
      const actualBirth = parseRecord(birthRead.bytes, JobBirthSchema, LIMIT.journalBytes);
      const { pid: _pid, ...birthIntent } = actualBirth;
      requireFact(
        canonicalDigest(birth) === canonicalDigest(actualBirth) &&
          canonicalDigest(intent) === canonicalDigest(birthIntent),
        'BINDING_MISMATCH'
      );
      requireFact(now() < parsed.bounds.workEnd, 'WORK_EXPIRED');
      const library = await this.validateLibrary();
      const candidate = await this.snapshot(parsed.binding.installationId, parsed.candidateRoot);
      requireFact(
        candidate.executable.sha256 === parsed.executableSHA256 &&
          sameFileIdentity(candidate.executable.identity, parsed.executableIdentity) &&
          library.distributionSHA256 === parsed.libraryDistributionSHA256,
        'HASH_MISMATCH'
      );
      requireFact(
        sameFileIdentity(attempt, identity(await fs.lstat(parsed.attemptRoot, { bigint: true }))),
        'ROOT_CHANGED'
      );
      this.fresh.set(request, {
        request: Object.freeze(parsed),
        digest: canonicalDigest(request),
        attempt,
        sink: null,
      });
      return Object.freeze({ candidate, library });
    });
  }
  createProbeSink(request: FreshVerifierRequest): InstallationJobSink {
    const admitted = this.fresh.get(request);
    requireFact(admitted && admitted.digest === canonicalDigest(request), 'OWNERSHIP_UNCERTAIN');
    const attempt: AttemptHandle = Object.freeze({
      kind: 'installation-attempt',
      binding: admitted.request.binding,
      attemptRoot: admitted.request.attemptRoot,
      homeRoot: path.join(admitted.request.attemptRoot, 'home'),
      temporaryRoot: path.join(admitted.request.attemptRoot, 'tmp'),
      identity: admitted.attempt,
    });
    admitted.sink ??= this.sink(attempt, null, admitted);
    return admitted.sink;
  }
  async releaseReservation(handle: ReservationHandle): Promise<void> {
    return this.operation(async () => {
      const reservation = this.reservation(handle);
      await this.checkReservation(reservation);
      requireFact(
        this.pending === 1 &&
          [...this.duties].every((duty) => duty.lease && duty.state === 'open') &&
          [...reservation.jobs.values()].every(
            (job) => job.receipt && job.writers.every((writer) => writer.finished)
          ),
        'CUSTODY_UNCERTAIN'
      );
      const owner = await this.read(
        path.join(reservation.directory.path, 'owner.json'),
        LIMIT.journalBytes
      );
      requireFact(
        reservation.ownerFile &&
          owner.file.sha256 === reservation.ownerFile.sha256 &&
          sameFileIdentity(owner.file.identity, reservation.ownerFile.identity),
        'ROOT_CHANGED'
      );
      requireFact(
        (await this.names(reservation.directory.path, 2)).join(',') === 'owner.json',
        'OWNERSHIP_UNCERTAIN'
      );
      try {
        await fs.unlink(owner.file.path);
        await reservation.directory.handle.sync();
        await this.checkDirectory(reservation.directory);
        await this.close(reservation.directory.duty);
        await fs.rmdir(reservation.directory.path);
        await reservation.root.handle.sync();
        await this.checkDirectory(reservation.root);
        await this.close(reservation.root.duty);
        reservation.state = 'released';
      } catch (error) {
        this.fault(error);
        reservation.state = 'uncertain';
        throw error;
      }
    });
  }
  custody(handle?: ReservationHandle): FilesystemCustody {
    const reservation = handle ? this.reservations.get(handle) : this.active;
    return Object.freeze({
      pendingOperations: this.pending,
      unresolvedHandles: [...this.duties].filter(
        (duty) =>
          !(
            duty.lease &&
            duty.state === 'open' &&
            reservation?.state === 'held' &&
            this.firstCause === null &&
            (duty === reservation.root.duty || duty === reservation.directory.duty)
          )
      ).length,
      firstCause: this.firstCause,
      reservation: reservation?.state ?? (handle ? 'uncertain' : 'released'),
    });
  }
}

/** Genuine fs producer; local memberships are never reconstructed from JSON or matching IDs. */
export function createInstallationFilesystem(
  configuration: InstallationConfiguration
): InstallationFilesystem {
  return new NodeInstallationFilesystem(configuration);
}

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import type { Readable } from 'node:stream';
import {
  AttemptBindingSchema,
  AttemptBoundsSchema,
  FileIdentitySchema,
  FreshVerifierRequestSchema,
  InstallationConfigurationSchema,
  InstallationFailure,
  INSTALLATION_LIMITS,
  INSTALLATION_TARGET,
  JobIntentSchema,
  JobBirthSchema,
  SourceManifestSchema,
  canonicalDigest,
  failureCode,
  parseRecord,
  recordBytes,
  sameBinding,
  sameFileIdentity,
  type AttemptBinding,
  type AttemptBounds,
  type FailureCode,
  type FileIdentity,
  type InstallationConfiguration,
  type InstallationJobs,
  type InstallerRequest,
  type JobBirth,
  type JobFacts,
  type JobHandle,
  type JobIntent,
  type JobRole,
  type JobRun,
  type JobsOptions,
  type RawWriter,
  type StreamFacts,
  type VerifierRequest,
  type VersionProbeRequest,
} from './contracts.js';

interface StreamState {
  observedBytes: number;
  retainedBytes: number;
  overflow: boolean;
  eof: boolean;
  closed: boolean;
  rawFlushedClosed: boolean;
  chunks: Uint8Array[];
}
interface Slot {
  readonly handle: JobHandle;
  readonly binding: AttemptBinding;
  readonly bounds: AttemptBounds;
  child: ChildProcess | null;
  birth: JobBirth | null;
  birthDurable: boolean;
  receiptDurable: boolean;
  exitCode: number | null;
  signal: string | null;
  exitObserved: boolean;
  closeObserved: boolean;
  stopRequested: boolean;
  stdinReturned: boolean;
  stdinClosed: boolean;
  settled: boolean;
  firstCause: FailureCode | null;
  cleanupCauses: FailureCode[];
  stdout: StreamState;
  stderr: StreamState;
}
const streamState = (): StreamState => ({
  observedBytes: 0,
  retainedBytes: 0,
  overflow: false,
  eof: false,
  closed: false,
  rawFlushedClosed: false,
  chunks: [],
});
function requireFact(value: unknown, code: FailureCode): asserts value {
  if (!value) throw new InstallationFailure(code);
}
function identity(s: BigIntStats): FileIdentity {
  return FileIdentitySchema.parse({
    device: String(s.dev),
    inode: String(s.ino),
    size: String(s.size),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
    uid: Number(s.uid),
    mode: Number(s.mode),
    type: s.isFile() ? 'file' : 'directory',
  });
}
function within(root: string, path: string): boolean {
  const name = relative(root, path);
  return name !== '' && !name.startsWith('..' + '/') && name !== '..' && !isAbsolute(name);
}
function streamFacts(s: StreamState): StreamFacts {
  return Object.freeze({
    observedBytes: s.observedBytes,
    retainedBytes: s.retainedBytes,
    overflow: s.overflow,
    eof: s.eof,
    closed: s.closed,
    rawFlushedClosed: s.rawFlushedClosed,
  });
}
function retained(s: StreamState): Uint8Array {
  const bytes = new Uint8Array(s.retainedBytes);
  let offset = 0;
  for (const chunk of s.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Real original-child producer. Serializable facts never admit a foreign handle or PID. */
export function createInstallationJobs(
  configuration: InstallationConfiguration,
  options: JobsOptions = { ownerKind: 'controller' }
): InstallationJobs {
  const parsed = InstallationConfigurationSchema.safeParse(configuration);
  requireFact(parsed.success, 'INVALID_INSTALL_CONFIGURATION');
  const config = Object.freeze({
    ...parsed.data,
    sourceVintage: Object.freeze(parsed.data.sourceVintage),
  });
  const ownerKind = options.ownerKind ?? 'controller';
  requireFact(
    ownerKind === 'controller' || ownerKind === 'fresh-verifier',
    'INVALID_INSTALL_CONFIGURATION'
  );
  const now = options.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  const members = new WeakMap<JobHandle, Slot>();
  const originals: Slot[] = [];
  const roles = new Set<JobRole>();
  // Acquired read originals whose close failed remain reachable, with no second close attempt.
  const heldReads = new Set<Awaited<ReturnType<typeof open>>>();
  let firstCause: FailureCode | null = null;
  let lastTime = -1;
  let attemptBinding: AttemptBinding | null = null;
  let attemptBounds: AttemptBounds | null = null;

  function note(slot: Slot, error: unknown, cleanup = false): void {
    const code = failureCode(error);
    slot.firstCause ??= code;
    firstCause ??= code;
    if (cleanup && slot.cleanupCauses.length < 16) slot.cleanupCauses.push(code);
  }
  function time(bounds: AttemptBounds, final = false): number {
    let value: number;
    try {
      value = now();
    } catch {
      throw new InstallationFailure('CLOCK_UNAVAILABLE');
    }
    requireFact(
      Number.isFinite(value) && value >= bounds.origin && value >= lastTime,
      'CLOCK_UNAVAILABLE'
    );
    lastTime = value;
    requireFact(
      value < (final ? bounds.finalEnd : bounds.workEnd),
      final ? 'FINAL_EXPIRED' : 'WORK_EXPIRED'
    );
    return value;
  }
  function check(slot: Slot, signal?: AbortSignal, final = false): number {
    requireFact(!signal?.aborted, 'ABORTED');
    return time(slot.bounds, final);
  }
  function facts(slot: Slot): JobFacts {
    const healthy =
      slot.birthDurable &&
      slot.exitObserved &&
      slot.closeObserved &&
      slot.exitCode === 0 &&
      slot.signal === null &&
      !slot.stopRequested &&
      slot.firstCause === null &&
      slot.stdinReturned &&
      slot.stdinClosed &&
      slot.stdout.eof &&
      slot.stderr.eof &&
      slot.stdout.closed &&
      slot.stderr.closed &&
      slot.stdout.rawFlushedClosed &&
      slot.stderr.rawFlushedClosed;
    return Object.freeze({
      schemaVersion: 1,
      jobId: slot.handle.jobId,
      role: slot.handle.role,
      binding: slot.binding,
      birth: slot.birth,
      exitCode: slot.exitCode,
      signal: slot.signal,
      exitObserved: slot.exitObserved,
      closeObserved: slot.closeObserved,
      stdout: streamFacts(slot.stdout),
      stderr: streamFacts(slot.stderr),
      stopRequested: slot.stopRequested,
      firstCause: slot.firstCause,
      cleanupCauses: Object.freeze([...slot.cleanupCauses]),
      descendantDisposition: healthy
        ? slot.handle.role === 'official-install'
          ? 'trusted-installer-return'
          : 'not-applicable'
        : 'unknown',
    });
  }
  function register(role: JobRole, bindingInput: AttemptBinding, boundsInput: AttemptBounds): Slot {
    requireFact(
      firstCause === null && originals.every((s) => s.settled),
      firstCause ?? 'CUSTODY_UNCERTAIN'
    );
    requireFact(!roles.has(role), 'CUSTODY_UNCERTAIN');
    requireFact(
      ownerKind === 'controller' ? role !== 'version-probe' : role === 'version-probe',
      'BINDING_MISMATCH'
    );
    requireFact(role !== 'official-install' || !roles.has('fresh-verifier'), 'BINDING_MISMATCH');
    const binding = Object.freeze(AttemptBindingSchema.parse(bindingInput));
    const bounds = Object.freeze(AttemptBoundsSchema.parse(boundsInput));
    requireFact(
      bounds.workEnd - bounds.origin === config.workMilliseconds &&
        bounds.finalEnd - bounds.origin === config.finalMilliseconds,
      'BINDING_MISMATCH'
    );
    requireFact(!attemptBinding || sameBinding(attemptBinding, binding), 'BINDING_MISMATCH');
    requireFact(
      !attemptBounds || canonicalDigest(attemptBounds) === canonicalDigest(bounds),
      'BINDING_MISMATCH'
    );
    attemptBinding ??= binding;
    attemptBounds ??= bounds;
    const handle: JobHandle = Object.freeze({
      kind: 'installation-job',
      role,
      jobId: randomBytes(16).toString('hex'),
    });
    const slot: Slot = {
      handle,
      binding,
      bounds,
      child: null,
      birth: null,
      birthDurable: false,
      receiptDurable: false,
      exitCode: null,
      signal: null,
      exitObserved: false,
      closeObserved: false,
      stopRequested: false,
      stdinReturned: role !== 'fresh-verifier',
      stdinClosed: role !== 'fresh-verifier',
      settled: false,
      firstCause: null,
      cleanupCauses: [],
      stdout: streamState(),
      stderr: streamState(),
    };
    // A failed prepare or spawn consumes its slot. It cannot be retried as a new original.
    roles.add(role);
    members.set(handle, slot);
    originals.push(slot);
    return slot;
  }
  async function assertDirectory(path: string, expected?: FileIdentity): Promise<void> {
    requireFact(isAbsolute(path) && resolve(path) === path, 'ROOT_CHANGED');
    const s = await lstat(path, { bigint: true });
    requireFact(
      s.isDirectory() && !s.isSymbolicLink() && (await realpath(path)) === path,
      'ROOT_CHANGED'
    );
    requireFact(!expected || sameFileIdentity(identity(s), expected), 'ROOT_CHANGED');
  }
  async function readPinned(
    slot: Slot,
    path: string,
    digest: string,
    cap: number,
    expected?: FileIdentity,
    keep = false
  ): Promise<Uint8Array> {
    const before = await lstat(path, { bigint: true });
    requireFact(
      before.isFile() && !before.isSymbolicLink() && before.size <= BigInt(cap),
      'SOURCE_MISMATCH'
    );
    requireFact((await realpath(path)) === path, 'ROOT_CHANGED');
    const beforeIdentity = identity(before);
    requireFact(!expected || sameFileIdentity(beforeIdentity, expected), 'HASH_MISMATCH');
    const original = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    heldReads.add(original);
    const hash = createHash('sha256');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let failed = false;
    let primary: unknown;
    try {
      requireFact(
        sameFileIdentity(beforeIdentity, identity(await original.stat({ bigint: true }))),
        'ROOT_CHANGED'
      );
      const buffer = new Uint8Array(INSTALLATION_LIMITS.bufferBytes);
      while (true) {
        const result = await original.read(
          buffer,
          0,
          Math.min(buffer.byteLength, cap + 1 - bytes),
          null
        );
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
        requireFact(bytes <= cap, 'RETENTION_EXCEEDED');
        hash.update(buffer.subarray(0, result.bytesRead));
        if (keep) chunks.push(buffer.slice(0, result.bytesRead));
      }
      requireFact(
        sameFileIdentity(beforeIdentity, identity(await original.stat({ bigint: true }))) &&
          sameFileIdentity(beforeIdentity, identity(await lstat(path, { bigint: true }))),
        'ROOT_CHANGED'
      );
      requireFact(hash.digest('hex') === digest && bytes === Number(before.size), 'HASH_MISMATCH');
    } catch (error) {
      failed = true;
      primary = error;
      note(slot, error);
    }
    // Attempt this original close once; ambiguity retains its local custody obligation.
    try {
      await original.close();
      heldReads.delete(original);
    } catch (error) {
      note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'), true);
      if (!failed) {
        failed = true;
        primary = error;
      }
    }
    if (failed) throw primary;
    const result = new Uint8Array(keep ? bytes : 0);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  async function sourceIntake(slot: Slot): Promise<void> {
    requireFact(
      config.platform === INSTALLATION_TARGET.platform &&
        config.arch === INSTALLATION_TARGET.arch &&
        process.platform === config.platform &&
        process.arch === config.arch,
      'PLATFORM_UNSUPPORTED'
    );
    await readPinned(
      slot,
      config.nodeExecutable,
      config.nodeExecutableSHA256,
      INSTALLATION_LIMITS.executableBytes
    );
    await readPinned(
      slot,
      config.controllerEntry,
      config.sourceVintage.controllerSHA256,
      INSTALLATION_LIMITS.controllerBytes
    );
    await readPinned(
      slot,
      config.verifierEntry,
      config.sourceVintage.verifierSHA256,
      INSTALLATION_LIMITS.libraryFileBytes
    );
    const bytes = await readPinned(
      slot,
      config.sourceManifestPath,
      config.sourceVintage.sourceManifestSHA256,
      INSTALLATION_LIMITS.manifestBytes,
      undefined,
      true
    );
    const manifest = parseRecord(bytes, SourceManifestSchema, INSTALLATION_LIMITS.manifestBytes);
    requireFact(
      manifest.controllerSHA256 === config.sourceVintage.controllerSHA256 &&
        manifest.verifierSHA256 === config.sourceVintage.verifierSHA256,
      'SOURCE_MISMATCH'
    );
  }
  async function installerIntake(slot: Slot, request: InstallerRequest): Promise<void> {
    requireFact(
      sameBinding(request.attempt.binding, slot.binding) &&
        sameBinding(request.candidate.binding, slot.binding),
      'BINDING_MISMATCH'
    );
    const attempt = join(config.cacheRoot, 'attempts', slot.binding.attemptId);
    const candidate = join(config.cacheRoot, 'candidates', slot.binding.installationId);
    requireFact(
      request.attempt.attemptRoot === attempt &&
        request.attempt.homeRoot === join(attempt, 'home') &&
        request.attempt.temporaryRoot === join(attempt, 'tmp') &&
        request.candidate.candidateRoot === candidate &&
        request.candidate.payloadRoot === join(candidate, 'payload'),
      'BINDING_MISMATCH'
    );
    await assertDirectory(attempt, request.attempt.identity);
    await assertDirectory(request.attempt.homeRoot);
    await assertDirectory(request.attempt.temporaryRoot);
    await assertDirectory(request.candidate.payloadRoot);
    await assertDirectory(config.libraryRoot);
    requireFact(
      request.library.distributionSHA256 === INSTALLATION_TARGET.libraryDistributionSHA256 &&
        request.library.cli.path === join(config.libraryRoot, 'cli.js') &&
        request.library.browsersManifest.path === join(config.libraryRoot, 'browsers.json') &&
        request.library.files.length > 0 &&
        request.library.files.length <= INSTALLATION_LIMITS.libraryEntries,
      'LIBRARY_MISMATCH'
    );
    const paths = new Set<string>();
    let bytes = 0;
    for (const file of request.library.files) {
      requireFact(
        within(config.libraryRoot, file.path) &&
          !paths.has(file.path) &&
          file.bytes >= 0 &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes === Number(file.identity.size) &&
          file.bytes <= INSTALLATION_LIMITS.libraryFileBytes,
        'LIBRARY_MISMATCH'
      );
      paths.add(file.path);
      bytes += file.bytes;
      requireFact(bytes <= INSTALLATION_LIMITS.libraryBytes, 'RETENTION_EXCEEDED');
      await readPinned(
        slot,
        file.path,
        file.sha256,
        INSTALLATION_LIMITS.libraryFileBytes,
        file.identity
      );
    }
    for (const named of [request.library.cli, request.library.browsersManifest]) {
      const corresponding = request.library.files.find((f) => f.path === named.path);
      requireFact(
        corresponding && canonicalDigest(corresponding) === canonicalDigest(named),
        'LIBRARY_MISMATCH'
      );
    }
    await sourceIntake(slot);
  }
  function environment(
    home: string,
    temporary: string,
    payload?: string
  ): Readonly<Record<string, string>> {
    return Object.freeze({
      PATH: dirname(config.nodeExecutable) + ':/usr/bin:/bin',
      HOME: home,
      TMPDIR: temporary,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      NODE_DISABLE_COMPILE_CACHE: '1',
      ...(payload ? { PLAYWRIGHT_BROWSERS_PATH: payload } : {}),
      LC_ALL: 'C',
      LANG: 'C',
    });
  }
  function stop(slot: Slot, error: unknown): void {
    note(slot, error);
    if (!slot.child || slot.stopRequested || slot.exitObserved || !slot.birth) return;
    slot.stopRequested = true;
    try {
      requireFact(slot.child.kill('SIGTERM'), 'CUSTODY_UNCERTAIN');
    } catch (cause) {
      note(slot, cause, true);
    }
  }
  async function pump(
    slot: Slot,
    original: Readable,
    state: StreamState,
    writer: RawWriter
  ): Promise<void> {
    const write = writer.write.bind(writer);
    const finish = writer.finish.bind(writer);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });
    original.once('end', () => {
      state.eof = true;
    });
    original.once('close', () => {
      state.closed = true;
      resolveClosed();
    });
    original.on('error', () => {
      note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
    });
    let writeFailed = false;
    try {
      for await (const data of original) {
        const chunk = typeof data === 'string' ? Buffer.from(data) : (data as Uint8Array);
        requireFact(
          Number.isSafeInteger(state.observedBytes + chunk.byteLength),
          'RETENTION_EXCEEDED'
        );
        state.observedBytes += chunk.byteLength;
        const length = Math.min(
          chunk.byteLength,
          INSTALLATION_LIMITS.streamBytes - state.retainedBytes
        );
        if (length !== chunk.byteLength) {
          state.overflow = true;
          note(slot, new InstallationFailure('RETENTION_EXCEEDED'));
        }
        if (length && !writeFailed) {
          // Copy only the retained prefix; a Buffer view must not keep a larger source slab alive.
          const saved = Uint8Array.from(chunk.subarray(0, length));
          state.chunks.push(saved);
          state.retainedBytes += saved.byteLength;
          try {
            // Readable iteration can coalesce pipe reads. F accepts at most one buffer per write.
            for (
              let offset = 0;
              offset < saved.byteLength;
              offset += INSTALLATION_LIMITS.bufferBytes
            )
              await write(saved.subarray(offset, offset + INSTALLATION_LIMITS.bufferBytes));
          } catch (error) {
            writeFailed = true;
            note(slot, error);
          }
        }
      }
    } catch (error) {
      note(slot, error);
    }
    // Stream close and raw finish are independent original obligations, even after a peer failure.
    await closed;
    if (!state.eof) note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
    try {
      await finish();
      state.rawFlushedClosed = true;
    } catch (error) {
      note(slot, error, true);
    }
  }
  async function execute(
    slot: Slot,
    request: InstallerRequest | VersionProbeRequest,
    executable: string,
    argv: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
    intake: () => Promise<void>,
    stdinBytes?: Uint8Array
  ): Promise<JobRun> {
    // Capture the real sink receiver before fallible acquisition, not a later mutable property lookup.
    const prepare = request.sink.prepare.bind(request.sink);
    const birthSink = request.sink.birth.bind(request.sink);
    const receiptSink = request.sink.receipt.bind(request.sink);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const pumps: Promise<void>[] = [];
    let prepared: Awaited<ReturnType<typeof prepare>> | null = null;
    const pumping = { stdout: false, stderr: false };
    let childClosed: Promise<void> | null = null;
    const parsedIntent = JobIntentSchema.parse({
      schemaVersion: 1,
      jobId: slot.handle.jobId,
      role: slot.handle.role,
      binding: slot.binding,
      bounds: slot.bounds,
      executable,
      argv: [...argv],
      cwd,
      environmentDigest: canonicalDigest(env),
    });
    const intent: JobIntent = Object.freeze({
      ...parsedIntent,
      binding: slot.binding,
      bounds: slot.bounds,
      argv: Object.freeze([...parsedIntent.argv]),
    });
    try {
      check(slot, request.signal);
      await intake();
      check(slot, request.signal);
      const output = await prepare(intent);
      prepared = output;
      check(slot, request.signal);
      // Pre-register observer promises/listeners immediately on the retained original spawn result.
      const child = spawn(executable, [...argv], {
        cwd,
        env: { ...env },
        shell: false,
        detached: false,
        stdio: [stdinBytes ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      slot.child = child;
      let spawnDone!: () => void;
      const spawned = new Promise<void>((done) => {
        spawnDone = done;
      });
      childClosed = new Promise<void>((done) => {
        child.once('exit', (code, signal) => {
          slot.exitObserved = true;
          slot.exitCode = code;
          slot.signal = signal;
          // Preserve the observed role failure now, before later pipe/raw/receipt cleanup can fail.
          if (code !== 0 || signal !== null)
            note(
              slot,
              new InstallationFailure(
                slot.handle.role === 'official-install'
                  ? 'INSTALLER_FAILED'
                  : slot.handle.role === 'fresh-verifier'
                    ? 'VERIFIER_FAILED'
                    : 'PROBE_FAILED'
              )
            );
        });
        child.once('close', (code, signal) => {
          slot.closeObserved = true;
          if (!slot.exitObserved) {
            slot.exitCode = code;
            slot.signal = signal;
          }
          done();
          spawnDone();
        });
      });
      child.on('error', () => {
        note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
        spawnDone();
      });
      child.once('spawn', () => {
        if (Number.isSafeInteger(child.pid) && child.pid! > 0) {
          const parsedBirth = JobBirthSchema.parse({ ...intent, pid: child.pid });
          slot.birth = Object.freeze({
            ...parsedBirth,
            binding: slot.binding,
            bounds: slot.bounds,
            argv: intent.argv,
          });
        } else note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
        try {
          check(slot, request.signal);
        } catch (error) {
          stop(slot, error);
        }
        spawnDone();
      });
      // Both pumps begin before the first await on birth persistence or spawn notification.
      // A returned failed-spawn object can lack either pipe. Keep it, drain each actual
      // surviving original, and finish both already-prepared raw writers independently.
      if (child.stdout) {
        pumping.stdout = true;
        pumps.push(pump(slot, child.stdout, slot.stdout, output.stdout));
      } else note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
      if (child.stderr) {
        pumping.stderr = true;
        pumps.push(pump(slot, child.stderr, slot.stderr, output.stderr));
      } else note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
      if (child.stdin) {
        child.stdin.on('error', () => {
          note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
        });
        child.stdin.once('finish', () => {
          slot.stdinReturned = true;
        });
        child.stdin.once('close', () => {
          slot.stdinClosed = true;
          if (!slot.stdinReturned) note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
        });
      }
      abort = () => stop(slot, new InstallationFailure('ABORTED'));
      request.signal?.addEventListener('abort', abort, { once: true });
      const expiry = (): void => {
        try {
          const current = time(slot.bounds);
          timer = setTimeout(expiry, Math.max(1, Math.ceil(slot.bounds.workEnd - current)));
        } catch (error) {
          stop(slot, error);
        }
      };
      timer = setTimeout(
        expiry,
        Math.max(1, Math.ceil(slot.bounds.workEnd - check(slot, request.signal)))
      );
      await spawned;
      requireFact(slot.birth, 'CUSTODY_UNCERTAIN');
      // An abort during the spawn event gap now stops the actual retained original once.
      if (request.signal?.aborted) abort();
      await birthSink(slot.birth);
      slot.birthDurable = true;
      check(slot, request.signal);
      if (stdinBytes) {
        requireFact(child.stdin, 'CUSTODY_UNCERTAIN');
        child.stdin.end(stdinBytes);
      }
    } catch (error) {
      note(slot, error);
      // A verifier must never receive request bytes before durable birth. Close that original
      // write end on failure, allowing its EOF refusal; no replacement child or stdin is created.
      try {
        if (slot.child?.stdin && !slot.child.stdin.writableEnded) slot.child.stdin.end();
      } catch (cause) {
        note(slot, cause, true);
      }
      if (request.signal?.aborted) stop(slot, new InstallationFailure('ABORTED'));
      else if (failureCode(error) === 'WORK_EXPIRED' || failureCode(error) === 'CLOCK_UNAVAILABLE')
        stop(slot, error);
    } finally {
      // Classification ends never substitute for original exit/close, pipe EOF or raw close.
      if (childClosed) await childClosed;
      await Promise.all(pumps);
      if (prepared) {
        // Prepare acquired two raw originals even if spawn returned a child with missing pipes.
        await Promise.all(
          (
            [
              ['stdout', prepared.stdout],
              ['stderr', prepared.stderr],
            ] as const
          ).map(async ([name, writer]) => {
            if (pumping[name]) return; // That exact pump owns its single raw finish attempt.
            try {
              await writer.finish();
              slot[name].rawFlushedClosed = true;
            } catch (error) {
              note(slot, error, true);
            }
          })
        );
      }
      if (timer) clearTimeout(timer);
      if (abort) request.signal?.removeEventListener('abort', abort);
      if (slot.child) {
        if (
          !slot.exitObserved ||
          !slot.closeObserved ||
          !slot.birthDurable ||
          !slot.stdinReturned ||
          !slot.stdinClosed
        )
          note(slot, new InstallationFailure('CUSTODY_UNCERTAIN'));
        if (slot.exitCode !== 0 || slot.signal !== null)
          note(
            slot,
            new InstallationFailure(
              slot.handle.role === 'official-install'
                ? 'INSTALLER_FAILED'
                : slot.handle.role === 'fresh-verifier'
                  ? 'VERIFIER_FAILED'
                  : 'PROBE_FAILED'
            )
          );
      }
      try {
        check(slot, request.signal, true);
      } catch (error) {
        note(slot, error);
      }
      try {
        await receiptSink(facts(slot));
        slot.receiptDurable = true;
      } catch (error) {
        note(slot, error, true);
      }
      // A receipt finish that crosses the same final end cannot earn a renewed budget.
      try {
        check(slot, request.signal, true);
      } catch (error) {
        note(slot, error);
      }
      slot.settled =
        !!slot.child &&
        slot.closeObserved &&
        slot.exitObserved &&
        slot.birthDurable &&
        slot.receiptDurable &&
        slot.stdinReturned &&
        slot.stdinClosed &&
        slot.stdout.eof &&
        slot.stderr.eof &&
        slot.stdout.closed &&
        slot.stderr.closed &&
        slot.stdout.rawFlushedClosed &&
        slot.stderr.rawFlushedClosed &&
        heldReads.size === 0;
    }
    return Object.freeze({
      handle: slot.handle,
      facts: facts(slot),
      stdout: retained(slot.stdout),
      stderr: retained(slot.stderr),
    });
  }

  return Object.freeze({
    async runInstaller(request: InstallerRequest): Promise<JobRun> {
      const slot = register('official-install', request.binding, request.bounds);
      return execute(
        slot,
        request,
        config.nodeExecutable,
        [request.library.cli.path, 'install', 'chromium', '--no-shell', '--no-remove'],
        request.attempt.attemptRoot,
        environment(
          request.attempt.homeRoot,
          request.attempt.temporaryRoot,
          request.candidate.payloadRoot
        ),
        async () => {
          requireFact(!request.candidate.reuse, 'BINDING_MISMATCH');
          await installerIntake(slot, request);
        }
      );
    },
    async runVerifier(input: VerifierRequest): Promise<JobRun> {
      const slot = register('fresh-verifier', input.binding, input.bounds);
      let request: ReturnType<typeof FreshVerifierRequestSchema.parse>;
      let bytes: Uint8Array;
      try {
        const parsedRequest = FreshVerifierRequestSchema.safeParse(input.request);
        requireFact(parsedRequest.success, 'BINDING_MISMATCH');
        request = parsedRequest.data;
        bytes = recordBytes(request, INSTALLATION_LIMITS.replyBytes);
      } catch (error) {
        note(slot, error);
        throw error;
      }
      return execute(
        slot,
        input,
        config.nodeExecutable,
        [config.verifierEntry],
        input.attempt.attemptRoot,
        environment(
          input.attempt.homeRoot,
          input.attempt.temporaryRoot,
          input.candidate.payloadRoot
        ),
        async () => {
          requireFact(
            sameBinding(request.binding, slot.binding) &&
              canonicalDigest(request.bounds) === canonicalDigest(slot.bounds) &&
              request.cacheRoot === config.cacheRoot &&
              request.candidateRoot === input.candidate.candidateRoot &&
              request.attemptRoot === input.attempt.attemptRoot &&
              sameFileIdentity(request.attemptIdentity, input.attempt.identity) &&
              request.libraryRoot === config.libraryRoot &&
              request.nodeExecutable === config.nodeExecutable &&
              request.nodeExecutableSHA256 === config.nodeExecutableSHA256 &&
              request.controllerEntry === config.controllerEntry &&
              request.verifierEntry === config.verifierEntry &&
              request.sourceManifestPath === config.sourceManifestPath &&
              canonicalDigest(request.sourceVintage) === canonicalDigest(config.sourceVintage) &&
              request.libraryDistributionSHA256 === INSTALLATION_TARGET.libraryDistributionSHA256 &&
              request.executablePath === INSTALLATION_TARGET.executablePath,
            'BINDING_MISMATCH'
          );
          await installerIntake(slot, input);
        },
        bytes
      );
    },
    async runVersionProbe(request: VersionProbeRequest): Promise<JobRun> {
      const slot = register('version-probe', request.binding, request.bounds);
      const attempt = join(config.cacheRoot, 'attempts', slot.binding.attemptId);
      return execute(
        slot,
        request,
        request.executable.path,
        ['--version'],
        request.cwd,
        environment(join(attempt, 'home'), join(attempt, 'tmp')),
        async () => {
          requireFact(
            request.cwd === attempt &&
              request.executable.path ===
                join(
                  config.cacheRoot,
                  'candidates',
                  slot.binding.installationId,
                  INSTALLATION_TARGET.executablePath
                ),
            'BINDING_MISMATCH'
          );
          await assertDirectory(attempt);
          await assertDirectory(join(attempt, 'home'));
          await assertDirectory(join(attempt, 'tmp'));
          await sourceIntake(slot);
          await readPinned(
            slot,
            request.executable.path,
            request.executable.sha256,
            INSTALLATION_LIMITS.executableBytes,
            request.executable.identity
          );
        }
      );
    },
    requireReturned(handle: JobHandle): JobFacts {
      const slot = members.get(handle);
      requireFact(slot && slot.settled && slot.receiptDurable, 'CUSTODY_UNCERTAIN');
      requireFact(
        slot.firstCause === null && !slot.stopRequested && slot.cleanupCauses.length === 0,
        slot.firstCause ?? 'CUSTODY_UNCERTAIN'
      );
      return facts(slot);
    },
    custody() {
      return Object.freeze({
        pending: originals.filter((s) => !s.settled).length + heldReads.size,
        firstCause,
      });
    },
  });
}

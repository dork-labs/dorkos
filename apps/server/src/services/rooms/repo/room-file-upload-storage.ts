/** Original Editor-selected upload storage. Namespace exclusion is not filesystem ownership. */
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Request } from 'express';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { InstallationRoomMutationContext } from '../../canvas/doc-channel/writes/installation-room-writes.js';
import multer from 'multer';
import {
  requireRoomFileEditorUploadStorageOwner,
  readRoomFileEditorUploadLimit,
  checkRoomFileEditorUploadCurrent,
  requireRoomFileEditorUploadCurrent,
  checkRoomFileEditorUploadCleanup,
  requireRoomFileEditorUploadCleanup,
  requireRoomFileEditorUploadSourceContext,
  type RoomFileEditor,
} from './room-file-editor.js';
interface Identity {
  dev: bigint;
  ino: bigint;
}
interface AcquiredFile {
  path: string;
  filename: string;
  file: Express.Multer.File;
  request: Request;
  identity?: Identity;
  handle?: FileHandle;
  size: number;
  cancelled: boolean;
  removed: boolean;
  done: Promise<void>;
  removing?: Promise<void>;
  reads: Set<Promise<void>>;
  readers: Set<Readable>;
}
interface StorageCommands {
  complete(error: unknown): Promise<void>;
  retire(): Promise<void>;
  issueSources(
    request: Request,
    files: readonly Express.Multer.File[]
  ): Promise<readonly Readonly<{ upload: object; size: number }>[]>;
  restoreCause(cause: unknown): unknown;
}
const engines = new WeakMap<object, StorageCommands>();
const sources = new WeakMap<
  object,
  { size: number; open(context: InstallationRoomMutationContext): Promise<Readable> }
>();
function actual(storage: multer.StorageEngine): StorageCommands {
  const engine = engines.get(storage);
  if (!engine) throw new Error('Unknown original Room upload storage.');
  return engine;
}
/** Only the constructor-private Editor minting turn can create its selected storage. */
export function createRoomFileUploadStorage(
  editor: RoomFileEditor,
  operation: object,
  directory: string
): multer.StorageEngine {
  return new RoomFileUploadStorage(editor, operation, directory);
}
/** Multer's truthy protocol sentinel is resolved to the separately captured original cause. */
export function completeRoomFileUploadStorage(
  storage: multer.StorageEngine,
  error: unknown
): Promise<void> {
  return actual(storage).complete(error);
}
/** Retire the original Room file upload storage custody. */
export function retireRoomFileUploadStorage(storage: multer.StorageEngine): Promise<void> {
  return actual(storage).retire();
}
/** Issue upload source handles from the original owned upload operation. */
export function issueRoomFileUploadSources(
  storage: multer.StorageEngine,
  request: Request,
  files: readonly Express.Multer.File[]
): Promise<readonly Readonly<{ upload: object; size: number }>[]> {
  return actual(storage).issueSources(request, files);
}
/** Restore the original cause retained by a Room file upload. */
export function restoreRoomFileUploadCause(storage: multer.StorageEngine, cause: unknown): unknown {
  return actual(storage).restoreCause(cause);
}
/** Open the original owned Room file upload source. */
export function openRoomFileUploadSource(
  source: object,
  context: InstallationRoomMutationContext,
  size: number
): Promise<Readable> {
  const acquired = sources.get(source);
  if (!acquired || !Number.isSafeInteger(size) || size !== acquired.size)
    return Promise.reject(new Error('Unknown or mismatched acquired upload source.'));
  return acquired.open(context);
}
class RoomFileUploadStorage implements multer.StorageEngine {
  readonly #editor: RoomFileEditor;
  readonly #operation: object;
  readonly #directory: string;
  readonly #records = new Set<AcquiredFile>();
  readonly #files = new Map<string, AcquiredFile>();
  readonly #pending = new Set<Promise<void>>();
  readonly #sourceStreams = new Set<Readable>();
  readonly #protocolErrors = new Set<Error>();
  #failed = false;
  #cause: unknown;
  #closed = false;
  #retiring?: Promise<void>;
  constructor(editor: RoomFileEditor, operation: object, directory: string) {
    requireRoomFileEditorUploadStorageOwner(editor, operation, directory);
    this.#editor = editor;
    this.#operation = operation;
    this.#directory = directory;
    engines.set(
      this,
      Object.freeze({
        complete: (error: unknown) => this.#complete(error),
        retire: () => this.#retire(),
        issueSources: (request: Request, files: readonly Express.Multer.File[]) =>
          this.#issueSources(request, files),
        restoreCause: (cause: unknown) =>
          this.#protocolErrors.has(cause as Error) && this.#failed ? this.#cause : cause,
      })
    );
    // Multer receives immutable own operations backed by native private execution.
    Object.defineProperties(this, {
      _handleFile: {
        value: (
          req: Request,
          file: Express.Multer.File,
          callback: (error?: any, info?: Partial<Express.Multer.File>) => void
        ) => this.#handle(req, file, callback),
      },
      _removeFile: {
        value: (req: Request, file: Express.Multer.File, callback: (error: Error | null) => void) =>
          this.#remove(req, file, callback),
      },
    });
  }
  _handleFile(
    _req: Request,
    _file: Express.Multer.File,
    _callback: (error?: any, info?: Partial<Express.Multer.File>) => void
  ): void {
    throw new Error('Uncaptured storage call.');
  }
  _removeFile(
    _req: Request,
    _file: Express.Multer.File,
    _callback: (error: Error | null) => void
  ): void {
    throw new Error('Uncaptured storage call.');
  }
  #failure(cause: unknown): void {
    if (!this.#failed) {
      this.#failed = true;
      this.#cause = cause;
    }
  }
  #sentinel(): Error {
    const error = new Error('Room upload storage failed.');
    this.#protocolErrors.add(error);
    return error;
  }
  #track(operation: Promise<void>): void {
    this.#pending.add(operation);
    void operation.then(
      () => this.#pending.delete(operation),
      (cause: unknown) => {
        this.#failure(cause);
        this.#pending.delete(operation);
      }
    );
  }
  #cancel(): void {
    this.#closed = true;
    // Includes naming/open turns before any path/FD was acquired.
    for (const record of this.#records) {
      record.cancelled = true;
      try {
        record.file.stream.destroy();
      } catch (cause) {
        this.#failure(cause);
      }
    }
    for (const stream of this.#sourceStreams) {
      try {
        stream.destroy();
      } catch (cause) {
        this.#failure(cause);
      }
    }
  }
  #handle(
    req: Request,
    file: Express.Multer.File,
    callback: (error?: any, info?: Partial<Express.Multer.File>) => void
  ): void {
    try {
      requireRoomFileEditorUploadCurrent(this.#editor, this.#operation, this.#directory, this, req);
    } catch (cause) {
      this.#failure(cause);
      callback(this.#sentinel());
      return;
    }
    if (this.#closed) {
      this.#failure(new Error('Upload storage admission closed.'));
      callback(this.#sentinel());
      return;
    }
    const record: AcquiredFile = {
      path: '',
      filename: '',
      file,
      request: req,
      size: 0,
      cancelled: false,
      removed: false,
      done: Promise.resolve(),
      reads: new Set(),
      readers: new Set(),
    };
    this.#records.add(record);
    record.done = this.#write(record).then(
      () =>
        callback(null, {
          destination: this.#directory,
          filename: record.filename,
          path: record.path,
          size: record.size,
        }),
      (cause: unknown) => {
        if (!record.cancelled) this.#failure(cause);
        callback(this.#sentinel());
      }
    );
    this.#track(record.done);
  }
  #admission(record: AcquiredFile): void {
    requireRoomFileEditorUploadCurrent(
      this.#editor,
      this.#operation,
      this.#directory,
      this,
      record.request
    );
    if (this.#closed || record.cancelled) throw new Error('Upload file admission closed.');
  }
  async #identity(record: AcquiredFile, open: boolean): Promise<void> {
    if (!record.identity) throw new Error('No acquired upload identity.');
    if (open) {
      if (!record.handle) throw new Error('No acquired upload descriptor.');
      const descriptor = await record.handle.stat({ bigint: true });
      if (
        !descriptor.isFile() ||
        descriptor.dev !== record.identity.dev ||
        descriptor.ino !== record.identity.ino
      )
        throw new Error('Upload descriptor identity changed.');
    }
    const entry = await fs.lstat(record.path, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.dev !== record.identity.dev ||
      entry.ino !== record.identity.ino
    )
      throw new Error('Upload file identity changed.');
  }
  async #checkFile(record: AcquiredFile, open: boolean): Promise<void> {
    await checkRoomFileEditorUploadCurrent(
      this.#editor,
      this.#operation,
      this.#directory,
      this,
      record.request
    );
    await this.#identity(record, open);
    await checkRoomFileEditorUploadCurrent(
      this.#editor,
      this.#operation,
      this.#directory,
      this,
      record.request
    );
    await this.#identity(record, open);
    this.#admission(record); // Exact synchronous native policy after observable work.
  }
  async #write(record: AcquiredFile): Promise<void> {
    let failed = false,
      cause: unknown;
    try {
      record.filename = await new Promise<string>((resolve, reject) =>
        randomBytes(16, (error, raw) => (error ? reject(error) : resolve(raw.toString('hex'))))
      );
      record.path = path.join(this.#directory, record.filename);
      await checkRoomFileEditorUploadCurrent(
        this.#editor,
        this.#operation,
        this.#directory,
        this,
        record.request
      );
      this.#admission(record);
      record.handle = await fs.open(
        record.path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      const identity = await record.handle.stat({ bigint: true });
      if (!identity.isFile()) throw new Error('Upload descriptor is not an ordinary file.');
      record.identity = { dev: identity.dev, ino: identity.ino };
      this.#files.set(record.path, record);
      record.file.path = record.path; // Multer's pending raw file and later spread clone refer to this acquired record.
      await this.#checkFile(record, true);
      for await (const part of record.file.stream) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        const limit = readRoomFileEditorUploadLimit(
          this.#editor,
          this.#operation,
          this.#directory,
          this
        );
        if (record.size + bytes.length > limit)
          throw new multer.MulterError('LIMIT_FILE_SIZE', record.file.fieldname);
        let offset = 0;
        while (offset < bytes.length) {
          await this.#checkFile(record, true);
          const written = await record.handle.write(bytes, offset, bytes.length - offset, null);
          if (written.bytesWritten <= 0)
            throw new Error('Upload descriptor made no write progress.');
          offset += written.bytesWritten;
          record.size += written.bytesWritten;
        }
      }
      await this.#checkFile(record, true);
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      // Successful source FD is retained for the later original commit, never pathname-reopened.
      // On failure the genuine returned FD closes regardless of current credential/root state.
      if (failed) {
        try {
          await this.#close(record);
        } catch {
          /* Preserve original body cause including undefined. */
        }
      }
    }
    if (failed) throw cause;
  }
  #remove(req: Request, file: Express.Multer.File, callback: (error: Error | null) => void): void {
    const record = this.#files.get(file.path);
    if (!record || record.request !== req) {
      callback(new Error('Unknown acquired upload file.'));
      return;
    }
    record.cancelled = true;
    try {
      record.file.stream.destroy();
    } catch (cause) {
      this.#failure(cause);
    }
    for (const reader of record.readers) {
      try {
        reader.destroy();
      } catch (cause) {
        this.#failure(cause);
      }
    }
    const removing = this.#removeOwned(record).then(
      () => callback(null),
      (cause: unknown) => {
        this.#failure(cause);
        callback(this.#sentinel());
      }
    );
    this.#track(removing);
  }
  #removeOwned(record: AcquiredFile): Promise<void> {
    if (record.removing) return record.removing;
    record.removing = (async () => {
      let callbackFailed = false,
        callbackCause: unknown;
      try {
        await record.done;
      } catch (cause) {
        callbackFailed = true;
        callbackCause = cause;
      }
      if (record.removed) {
        if (callbackFailed) throw callbackCause;
        return;
      }
      // Late Multer removal joins this file's actual open/read/iterator turns without joining itself.
      while (record.reads.size) await Promise.allSettled([...record.reads]);
      try {
        await this.#close(record);
      } catch (cause) {
        if (callbackFailed) throw callbackCause;
        throw cause;
      } // Unconditional owned FD cleanup precedes guarded pathname cleanup.
      await checkRoomFileEditorUploadCleanup(
        this.#editor,
        this.#operation,
        this.#directory,
        this,
        record.request
      );
      await this.#identity(record, false);
      await checkRoomFileEditorUploadCleanup(
        this.#editor,
        this.#operation,
        this.#directory,
        this,
        record.request
      );
      await this.#identity(record, false);
      requireRoomFileEditorUploadCleanup(
        this.#editor,
        this.#operation,
        this.#directory,
        this,
        record.request
      );
      // No atomic external namespace guarantee: this last identity check and unlink remain separate syscalls.
      await fs.unlink(record.path);
      record.removed = true;
      if (callbackFailed) throw callbackCause;
    })();
    return record.removing;
  }
  async #join(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
  async #complete(error: unknown): Promise<void> {
    const protocolFailed = error !== undefined && error !== null;
    if (protocolFailed) this.#cancel();
    await this.#join();
    // Genuine original Multer LIMIT/abort cause wins over secondary cancellation/cleanup faults.
    if (protocolFailed && !this.#protocolErrors.has(error as Error)) throw error;
    if (this.#failed) throw this.#cause;
    if (protocolFailed) throw error;
  }
  async #close(record: AcquiredFile): Promise<void> {
    if (record.handle) {
      await record.handle.close();
      record.handle = undefined;
    }
  }
  async #issueSources(
    req: Request,
    files: readonly Express.Multer.File[]
  ): Promise<readonly Readonly<{ upload: object; size: number }>[]> {
    await this.#join();
    if (this.#failed) throw this.#cause;
    const seen = new Set<AcquiredFile>(),
      result: Readonly<{ upload: object; size: number }>[] = [];
    for (const file of files) {
      const record = this.#files.get(file.path);
      if (
        !record ||
        record.request !== req ||
        record.removed ||
        seen.has(record) ||
        file.size !== record.size
      )
        throw new Error('Upload result does not match acquired original files.');
      seen.add(record);
      await this.#checkFile(record, true);
      const upload = Object.freeze({});
      sources.set(upload, {
        size: record.size,
        open: (context) => this.#launchSource(record, context),
      });
      result.push(Object.freeze({ upload, size: record.size }));
    }
    if (seen.size !== this.#files.size) throw new Error('Upload result omitted an acquired file.');
    return Object.freeze(result);
  }
  #launchSource(record: AcquiredFile, context: InstallationRoomMutationContext): Promise<Readable> {
    const opening = this.#openSource(record, context);
    // Track metadata awaits from launch, before a source Readable has been returned or consumed.
    const joining = opening.then(
      () => undefined,
      () => undefined
    ); // The original caller observes raw metadata refusal; no stream/resource was issued.
    record.reads.add(joining);
    void joining.then(() => record.reads.delete(joining));
    this.#track(joining);
    return opening;
  }
  async #openSource(
    record: AcquiredFile,
    context: InstallationRoomMutationContext
  ): Promise<Readable> {
    requireRoomFileEditorUploadSourceContext(
      this.#editor,
      this.#operation,
      this.#directory,
      this,
      context
    );
    await this.#checkFile(record, true);
    requireRoomFileEditorUploadSourceContext(
      this.#editor,
      this.#operation,
      this.#directory,
      this,
      context
    );
    if (!record.handle || record.removed) throw new Error('Upload source descriptor unavailable.');
    const descriptor = await record.handle.stat({ bigint: true });
    if (descriptor.size !== BigInt(record.size)) throw new Error('Acquired upload size changed.');
    await this.#checkFile(record, true);
    requireRoomFileEditorUploadSourceContext(
      this.#editor,
      this.#operation,
      this.#directory,
      this,
      context
    );
    this.#admission(record); // Reentry during the last original policy guard cannot create a late reader.
    let iteratorStarted = false,
      iteratorFinished!: () => void;
    const iteratorDone = new Promise<void>((resolve) => {
      iteratorFinished = resolve;
    });
    const stream = Readable.from(
      async function* (this: RoomFileUploadStorage) {
        iteratorStarted = true;
        let count = 0;
        try {
          while (count < record.size) {
            requireRoomFileEditorUploadSourceContext(
              this.#editor,
              this.#operation,
              this.#directory,
              this,
              context
            );
            await this.#checkFile(record, true);
            // Explicit position reads from the exact retained FD, never reopening its pathname.
            const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, record.size - count));
            const read = await record.handle!.read(bytes, 0, bytes.length, count);
            await this.#checkFile(record, true);
            requireRoomFileEditorUploadSourceContext(
              this.#editor,
              this.#operation,
              this.#directory,
              this,
              context
            );
            if (read.bytesRead <= 0)
              throw new Error('Acquired upload source ended before its actual size.');
            count += read.bytesRead;
            yield bytes.subarray(0, read.bytesRead);
          }
          await this.#checkFile(record, true);
          const final = await record.handle!.stat({ bigint: true });
          if (final.size !== BigInt(record.size))
            throw new Error('Acquired upload source size changed.');
          requireRoomFileEditorUploadSourceContext(
            this.#editor,
            this.#operation,
            this.#directory,
            this,
            context
          );
        } catch (cause) {
          if (!record.cancelled) this.#failure(cause);
          throw this.#sentinel(); // Node stream protocol stays truthy; the private original cause is restored later.
        } finally {
          iteratorFinished();
        } // Join the actual pending FD read/iterator return, not merely a stream event.
      }.call(this)
    );
    this.#sourceStreams.add(stream);
    record.readers.add(stream);
    const settling = finished(stream).then(
      async () => {
        if (!iteratorStarted) iteratorFinished();
        await iteratorDone;
        this.#sourceStreams.delete(stream);
        record.readers.delete(stream);
      },
      async (cause: unknown) => {
        if (!iteratorStarted) iteratorFinished();
        await iteratorDone;
        this.#sourceStreams.delete(stream);
        record.readers.delete(stream);
        if (!record.cancelled && !this.#protocolErrors.has(cause as Error)) this.#failure(cause);
      }
    );
    record.reads.add(settling);
    void settling.then(() => record.reads.delete(settling));
    this.#track(settling);
    return stream;
  }
  #retire(): Promise<void> {
    if (this.#retiring) return this.#retiring;
    this.#cancel(); // Admission closes synchronously before the first drain await.
    this.#retiring = (async () => {
      await this.#join();
      let failed = this.#failed,
        cause = this.#cause;
      for (const record of this.#records) {
        // Even an open whose first stat failed owns a returned FD, but no certified unlink identity.
        try {
          await this.#close(record);
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
        if (record.identity) {
          try {
            await this.#removeOwned(record);
          } catch (error) {
            if (!failed) {
              failed = true;
              cause = error;
            }
          }
        }
      }
      if (failed) throw cause;
    })();
    return this.#retiring;
  }
}

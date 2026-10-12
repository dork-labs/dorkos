/**
 * Multipart file uploads on the Hono chain: {@link parseUploads} reads a
 * `multipart/form-data` body off the raw Node request, the way `multer`
 * (2.4) read it for the routes that moved off Express.
 *
 * It is a port of multer's middleware for the shape these routes use (one
 * file field, memory or disk storage, a synchronous type filter), not a new
 * parser: the same `busboy` underneath with the same limits and the same
 * off-by-one correction, the same refusal codes and messages, the same order
 * in which a refusal is decided, the files already written removed before the
 * answer, and the rest of the body drained first so the client is not cut off
 * mid-send. A route answers each refusal exactly as it answered multer's.
 *
 * Nothing on the chain reads a multipart body before the route does: the JSON
 * body stage (`http/request-body.ts`) skips any type it does not parse, as
 * `express.json` did. A request that is not multipart, or has no body, is no
 * files and no error, as multer called `next()` for it.
 *
 * Text fields are checked against the same limits and gathered the way multer
 * gathered them into `req.body` (`http/form-fields.ts`); {@link parseUploadForm}
 * hands them back beside the files, for a route that reads them.
 *
 * @module http/uploads
 */
import type { IncomingMessage } from 'node:http';
import { createWriteStream, type WriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import type { HttpBindings } from '@hono/node-server';
import busboy, { type Busboy } from 'busboy';
import type { Context } from 'hono';
import typeis from 'type-is';
import { appendFormField, emptyFormFields, type FormFields } from './form-fields.js';

/** Why the parser refused a body: multer's `MulterError` codes. */
export type UploadErrorCode =
  | 'LIMIT_PART_COUNT'
  | 'LIMIT_FILE_SIZE'
  | 'LIMIT_FILE_COUNT'
  | 'LIMIT_FIELD_KEY'
  | 'LIMIT_FIELD_VALUE'
  | 'LIMIT_FIELD_COUNT'
  | 'LIMIT_UNEXPECTED_FILE'
  | 'MISSING_FIELD_NAME'
  | 'INVALID_FIELD_NAME'
  | 'STREAM_DESTROYED';

/** multer's message for each code, which routes put on the wire. */
const MESSAGES: Record<UploadErrorCode, string> = {
  LIMIT_PART_COUNT: 'Too many parts',
  LIMIT_FILE_SIZE: 'File too large',
  LIMIT_FILE_COUNT: 'Too many files',
  LIMIT_FIELD_KEY: 'Field name too long',
  LIMIT_FIELD_VALUE: 'Field value too long',
  LIMIT_FIELD_COUNT: 'Too many fields',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field',
  MISSING_FIELD_NAME: 'Field name missing',
  INVALID_FIELD_NAME: 'Invalid field name',
  STREAM_DESTROYED: 'File stream was destroyed',
};

/**
 * A limit or shape the body broke. Anything else {@link parseUploads} rejects
 * with is a plain `Error`: a malformed body (busboy's own words), the type
 * filter's refusal, a storage failure, or the client going away.
 */
export class UploadLimitError extends Error {
  /** Which rule the body broke. */
  readonly code: UploadErrorCode;
  /** The form field the refusal is about, when there is one. */
  readonly field?: string;

  /**
   * A refusal carrying multer's message for its code.
   *
   * @param code - Which rule the body broke.
   * @param field - The form field it is about.
   */
  constructor(code: UploadErrorCode, field?: string) {
    super(MESSAGES[code]);
    this.name = 'UploadLimitError';
    this.code = code;
    if (field) this.field = field;
  }
}

/** What the type filter is shown about a file before any of it is stored. */
export interface UploadFileInfo {
  /** The form field it arrived in. */
  fieldname: string;
  /** The client's name for it, last path segment only. Untrusted. */
  originalname: string;
  /** The part's transfer encoding. */
  encoding: string;
  /** The part's declared type. Untrusted. */
  mimetype: string;
}

/** A stored file. */
export interface UploadedFile extends UploadFileInfo {
  /** Bytes stored. */
  size: number;
  /** The bytes, with memory storage. */
  buffer?: Buffer;
  /** The folder it was written to, with disk storage. */
  destination?: string;
  /** Its name in that folder, with disk storage. */
  filename?: string;
  /** Its full path, with disk storage. */
  path?: string;
}

/** Where files go: kept in memory, unless a folder is named. */
export interface UploadDiskStorage {
  /** The folder, created on demand for each file. */
  directory: string;
  /** The name a file is written under, from the client's name for it. */
  filename: (originalname: string) => string;
}

/** Limits, as multer's `limits` (busboy's defaults for the rest). */
export interface UploadLimits {
  /** The most bytes one file may carry. A file of exactly this size is accepted. */
  fileSize?: number;
  /** The most files in one body. */
  files?: number;
  /** The most text fields in one body. */
  fields?: number;
}

/** Options for {@link parseUploads}. */
export interface ParseUploadsOptions {
  /** The one form field files may arrive in; a file in any other is refused. */
  field: string;
  /** The most files that field may carry (`upload.array(field, n)`, `single` is 1). */
  maxCount?: number;
  /** See {@link UploadLimits}. */
  limits?: UploadLimits;
  /** An error refuses the whole body, as a multer `fileFilter` passing one did. */
  filter?: (file: UploadFileInfo) => Error | undefined;
  /** Disk storage; without it, files are kept in memory. */
  disk?: UploadDiskStorage;
  /**
   * How a filename with no declared charset is decoded: multer's
   * `defParamCharset`, `latin1` unless a route asks for `utf8`.
   */
  paramCharset?: 'latin1' | 'utf8';
}

/** A multipart body read whole: its files and its text fields. */
export interface UploadForm {
  /** The stored files, in the order they arrived. */
  files: UploadedFile[];
  /** The text fields, as multer gathered them into `req.body`. */
  fields: FormFields;
}

/** The Hono environment {@link parseUploads} reads: the raw Node request. */
type UploadEnv = { Bindings: HttpBindings };

/**
 * Read the files in a `multipart/form-data` body.
 *
 * Resolves with the stored files in the order they arrived: none for a
 * request that is not multipart or has no body. Rejects with an
 * {@link UploadLimitError} for a broken limit, or a plain `Error` otherwise,
 * after removing whatever was already stored and draining the rest of the
 * body.
 *
 * Read the body once: the request stream is consumed.
 *
 * @param c - The Hono context.
 * @param options - See {@link ParseUploadsOptions}.
 * @returns The stored files.
 */
export async function parseUploads<E extends UploadEnv>(
  c: Context<E>,
  options: ParseUploadsOptions
): Promise<UploadedFile[]> {
  const req = c.env.incoming;
  if (!typeis(req, ['multipart'])) return [];
  const form = await new Promise<UploadForm>((resolve, reject) =>
    new UploadRead(req, options, false, resolve, reject).start()
  );
  return form.files;
}

/**
 * Read a `multipart/form-data` body: {@link parseUploads}, keeping the text
 * fields too.
 *
 * Resolves `undefined` for a request that is not multipart or has no body,
 * where multer left `req.body` as the JSON stage set it; the route reads that
 * instead. Rejects as {@link parseUploads} does.
 *
 * @param c - The Hono context.
 * @param options - See {@link ParseUploadsOptions}.
 * @returns The files and fields, or `undefined` when the body is not multipart.
 */
export function parseUploadForm<E extends UploadEnv>(
  c: Context<E>,
  options: ParseUploadsOptions
): Promise<UploadForm | undefined> {
  const req = c.env.incoming;
  // `type-is` is multer's own test: a body (a length or chunked encoding) of
  // any `multipart/*` type.
  if (!typeis(req, ['multipart'])) return Promise.resolve(undefined);
  return new Promise((resolve, reject) =>
    new UploadRead(req, options, true, resolve, reject).start()
  );
}

/** A file slot, held from the moment a file is accepted, so order survives storage. */
interface Slot {
  file?: UploadedFile;
}

/** One body being read: multer's `makeMiddleware`, for one request. */
class UploadRead {
  private parser: Busboy | undefined;
  private finished = false;
  private readFinished = false;
  private failed = false;
  private cleanupDone = false;
  private pendingWrites = 0;
  private onIdle: (() => void) | undefined;
  private filesLeft: number;
  private readonly slots: Slot[] = [];
  private readonly stored: UploadedFile[] = [];
  private readonly writing = new Set<UploadedFile>();
  private readonly removedOnAbort = new Set<UploadedFile>();
  private readonly fields = emptyFormFields();

  constructor(
    private readonly req: IncomingMessage,
    private readonly options: ParseUploadsOptions,
    // Only a caller that reads the text fields keeps them; the rest drop each
    // one as it arrives, so a body of text fields holds no memory.
    private readonly keepFields: boolean,
    private readonly resolve: (form: UploadForm) => void,
    private readonly reject: (error: unknown) => void
  ) {
    this.filesLeft = options.maxCount ?? Infinity;
  }

  start(): void {
    const { req } = this;
    try {
      this.parser = busboy({
        headers: req.headers,
        limits: busboyLimits(this.options.limits),
        // multer's default: a filename with no declared charset is latin1.
        defParamCharset: this.options.paramCharset ?? 'latin1',
      });
    } catch (err) {
      // A multipart type with no boundary: refused before a byte is read.
      this.reject(err);
      return;
    }
    req.on('error', (err) => this.requestFailed(err ?? new Error('Request error')));
    req.on('aborted', () => this.requestFailed(new Error('Request aborted')));
    req.on('close', () => {
      if (!req.readableEnded) this.requestFailed(new Error('Request closed'));
    });
    const parser = this.parser;
    parser.on('field', (name, value, info) => this.onField(name, value, info));
    parser.on('file', (name, stream, info) => this.onFile(name, stream, info));
    parser.on('error', (err) => this.abort(err));
    parser.on('partsLimit', () => this.abort(new UploadLimitError('LIMIT_PART_COUNT')));
    parser.on('filesLimit', () => this.abort(new UploadLimitError('LIMIT_FILE_COUNT')));
    parser.on('fieldsLimit', () => this.abort(new UploadLimitError('LIMIT_FIELD_COUNT')));
    parser.on('close', () => {
      this.readFinished = true;
      this.maybeDone();
    });
    req.pipe(parser);
  }

  /** A text field: checked against the limits, then gathered. */
  private onField(
    name: string | null | undefined,
    value: string,
    info: { nameTruncated: boolean; valueTruncated: boolean }
  ): void {
    if (name == null) return this.abort(new UploadLimitError('MISSING_FIELD_NAME'));
    const fieldname = decodeFormDataName(name);
    if (info.nameTruncated) return this.abort(new UploadLimitError('LIMIT_FIELD_KEY'));
    if (info.valueTruncated) {
      return this.abort(new UploadLimitError('LIMIT_FIELD_VALUE', fieldname));
    }
    if (!this.keepFields) return;
    try {
      appendFormField(this.fields, fieldname, value);
    } catch {
      this.abort(new UploadLimitError('INVALID_FIELD_NAME', fieldname));
    }
  }

  private onFile(
    rawField: string | null | undefined,
    stream: Readable & { truncated?: boolean },
    info: { filename?: string; encoding: string; mimeType: string }
  ): void {
    let accepted = false;
    let aborting = false;
    let sizeLimitReached = false;
    let counted = false;
    const settleWrite = () => {
      if (!counted) return;
      counted = false;
      this.writeSettled();
    };

    stream.on('error', (err) => {
      settleWrite();
      this.abort(err);
    });
    stream.on('limit', () => {
      sizeLimitReached = true;
      if (accepted) {
        aborting = true;
        this.abort(new UploadLimitError('LIMIT_FILE_SIZE', fieldname));
      }
    });

    if (rawField == null) return this.abort(new UploadLimitError('MISSING_FIELD_NAME'));
    const fieldname = decodeFormDataName(rawField);
    // A part with a field name and no filename carries no file.
    if (!info.filename) {
      stream.resume();
      return;
    }
    const file: UploadedFile = {
      fieldname,
      originalname: decodeFormDataName(info.filename),
      encoding: info.encoding,
      mimetype: info.mimeType,
      size: 0,
    };

    // multer's wrapped filter: the field and its count first, then the route's.
    let refusal: unknown;
    if (fieldname !== this.options.field || this.filesLeft <= 0) {
      refusal = new UploadLimitError('LIMIT_UNEXPECTED_FILE', fieldname);
    } else {
      this.filesLeft -= 1;
      refusal = this.options.filter?.(file);
      // A refused file does not use up a slot.
      if (refusal) this.filesLeft += 1;
    }
    if (this.failed) {
      stream.resume();
      return;
    }
    if (refusal) return this.abort(refusal);
    if (sizeLimitReached) return this.abort(new UploadLimitError('LIMIT_FILE_SIZE', fieldname));

    accepted = true;
    counted = true;
    this.pendingWrites += 1;
    const slot: Slot = {};
    this.slots.push(slot);
    this.writing.add(file);

    this.store(file, stream, (err) => {
      this.writing.delete(file);
      if (aborting) {
        this.stored.push(file);
        return settleWrite();
      }
      if (err) {
        settleWrite();
        return this.abort(err);
      }
      if (this.cleanupDone) {
        // The abort already removed what it knew of; this file finished after.
        if (this.removedOnAbort.has(file)) return settleWrite();
        return void removeStored(file).finally(settleWrite);
      }
      slot.file = file;
      this.stored.push(file);
      settleWrite();
      this.maybeDone();
    });
  }

  /** Store one accepted file: multer's memory or disk engine. */
  private store(file: UploadedFile, stream: Readable, done: (err?: unknown) => void): void {
    const { disk } = this.options;
    if (!disk) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        file.buffer = Buffer.concat(chunks);
        file.size = file.buffer.length;
        done();
      });
      return;
    }
    fs.mkdir(disk.directory, { recursive: true }).then(
      () => {
        const filename = disk.filename(file.originalname);
        const finalPath = path.join(disk.directory, filename);
        if (stream.destroyed) return done(new UploadLimitError('STREAM_DESTROYED'));
        const out: WriteStream = createWriteStream(finalPath);
        file.path = finalPath;
        pipeline(stream, out, (err) => {
          if (err) {
            // An abort can delete the path before the asynchronous open
            // creates it; remove whatever the open left, once it has settled.
            void fs.rm(finalPath, { force: true }).finally(() => done(err));
            return;
          }
          file.destination = disk.directory;
          file.filename = filename;
          file.size = out.bytesWritten;
          done();
        });
      },
      (err: unknown) => done(err)
    );
  }

  private writeSettled(): void {
    this.pendingWrites -= 1;
    if (this.pendingWrites === 0 && this.onIdle) {
      const idle = this.onIdle;
      this.onIdle = undefined;
      idle();
    }
  }

  private maybeDone(): void {
    if (this.readFinished && this.pendingWrites === 0 && !this.failed) this.finish();
  }

  /** Refuse the body: wait for writes in flight, remove what was stored, then answer. */
  private abort(error: unknown, skipPendingWait = false): void {
    if (this.failed) return;
    this.failed = true;
    const cleanup = () => {
      this.cleanupDone = true;
      const inFlight = [...this.writing].filter((file) => file.path);
      for (const file of inFlight) this.removedOnAbort.add(file);
      const toRemove = [...this.stored, ...inFlight];
      void (async () => {
        for (const file of toRemove) await removeStored(file).catch(() => undefined);
        this.finish(error);
      })();
    };
    if (skipPendingWait || this.pendingWrites === 0) cleanup();
    else this.onIdle = cleanup;
  }

  /** The client went away or the socket failed: stop parsing now. */
  private requestFailed(error: Error): void {
    if (this.finished) return;
    if (this.parser) {
      this.req.unpipe(this.parser);
      this.parser.destroy(error);
    }
    this.abort(error, true);
  }

  /**
   * Answer once. A refusal waits for the rest of the body, so the client is
   * not cut off while it is still sending (an `EPIPE` on its side).
   */
  private finish(error?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    const { req, parser } = this;
    if (parser) {
      req.unpipe(parser);
      setImmediate(() => parser.removeAllListeners());
    }
    req.on('readable', () => {
      while (req.read() !== null) {
        // Discard: the answer no longer depends on it.
      }
    });
    req.resume();
    const settle = () => {
      if (error !== undefined) this.reject(error);
      else {
        const files = this.slots.flatMap((slot) => (slot.file ? [slot.file] : []));
        this.resolve({ files, fields: this.fields });
      }
    };
    if (error !== undefined && req.readable && !req.destroyed) {
      let called = false;
      const once = () => {
        if (called) return;
        called = true;
        settle();
      };
      req.once('end', once);
      req.once('error', once);
      req.once('close', once);
      return;
    }
    settle();
  }
}

/**
 * busboy's limits for multer's: busboy refuses a file that REACHES
 * `fileSize`, so one more is passed and a file of exactly the limit fits.
 */
function busboyLimits(limits: UploadLimits | undefined): busboy.Limits | undefined {
  if (!limits) return undefined;
  const out: busboy.Limits = { ...limits };
  if (typeof limits.fileSize === 'number' && Number.isFinite(limits.fileSize)) {
    out.fileSize = limits.fileSize + 1;
  }
  return out;
}

/** Forget a stored file: delete it from disk, or drop its bytes. */
async function removeStored(file: UploadedFile): Promise<void> {
  if (file.buffer) {
    delete file.buffer;
    return;
  }
  const target = file.path;
  delete file.destination;
  delete file.filename;
  delete file.path;
  if (target) await fs.unlink(target);
}

/**
 * Reverse the three escapes the HTML spec has a browser write into a field
 * name or filename (`%0A`, `%0D`, `%22`), and only those, as multer does: a
 * bare `%` is never escaped, so `50%.pdf` stays `50%.pdf`.
 */
function decodeFormDataName(value: string): string {
  return value.replace(/%0A|%0D|%22/gi, (match) => {
    switch (match.toUpperCase()) {
      case '%0A':
        return '\n';
      case '%0D':
        return '\r';
      default:
        return '"';
    }
  });
}

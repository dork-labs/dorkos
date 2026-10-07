import { constants } from 'node:fs';
import { open, mkdir, realpath, lstat, unlink, rmdir, type FileHandle } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';
import type { OwnedUploadLease } from '@dorkos/browser/server-owner';
import { browserFileRefusal, isOriginalBrowserFileRefusal } from './file-refusal.js';
import { isOriginalBrowserGrantRefusal } from '../grants.js';

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = new Set(['text/plain', 'application/pdf', 'image/png', 'image/jpeg']);
const same = (a: BrowserBinding, b: BrowserBinding) =>
  Object.keys(a).every((key) => a[key as keyof BrowserBinding] === b[key as keyof BrowserBinding]);
type Cell = {
  id: string;
  actor: object;
  owner: string;
  binding: BrowserBinding;
  directory: string;
  path: string;
  name: string;
  mimeType: string;
  length: number;
  hash: string;
  handle?: FileHandle;
  dev?: number;
  ino?: number;
  consumed: boolean;
  native?: Promise<void>;
  closing?: Promise<void>;
};

/** Private owner/browser staging with no caller path input and no attachment-derived authority. */
export class BrowserUploadArtifacts {
  private readonly denials = new WeakSet<object>();
  private readonly cells = new Map<string, Cell>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly ready: Promise<void>;
  private root?: string;
  private rootDev?: number;
  private rootIno?: number;
  private closed = false;
  private first?: Readonly<{ value: unknown }>;
  private closing?: Promise<void>;

  constructor(directory: string, protectedRoots: readonly string[]) {
    if (
      !isAbsolute(directory) ||
      !protectedRoots.length ||
      protectedRoots.some((p) => !isAbsolute(p))
    )
      throw browserFileRefusal('inaccessible');
    const requested = resolve(directory),
      protectedPaths = [...protectedRoots];
    this.ready = this.retain(
      Promise.resolve().then(async () => {
        if (this.closed) return;
        // Root creation is exclusively the trusted server's responsibility; no user-selected path exists.
        const root = await realpath(requested);
        if (this.closed) return;
        if (root !== requested) throw browserFileRefusal('inaccessible');
        const stat = await lstat(root);
        if (this.closed) return;
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
          throw browserFileRefusal('inaccessible');
        for (const protectedPath of protectedPaths) {
          const actual = await realpath(protectedPath);
          if (this.closed) return;
          for (const [a, b] of [
            [root, actual],
            [actual, root],
          ]) {
            const path = relative(a, b);
            if (!path || (!path.startsWith('..') && !isAbsolute(path)))
              throw browserFileRefusal('inaccessible');
          }
        }
        this.root = root;
        this.rootDev = stat.dev;
        this.rootIno = stat.ino;
      })
    );
  }
  private check(): void {
    if (this.first) throw this.first.value;
    if (this.closed) throw this.denial('unavailable');
  }
  /** Only original authority/lifecycle denials are local to one operation. IO uncertainty stays sticky. */
  private denial(reason: Parameters<typeof browserFileRefusal>[0]) {
    const value = browserFileRefusal(reason);
    this.denials.add(value);
    return value;
  }
  private fail(value: unknown): void {
    if (value !== null && typeof value === 'object' && this.denials.has(value)) return;
    this.first ??= Object.freeze({ value });
  }
  private admitted(current: () => boolean): boolean {
    try {
      return current();
    } catch (value) {
      // This port is authority only. Never classify arbitrary producer errors by their class/message.
      if (isOriginalBrowserGrantRefusal(value) || isOriginalBrowserFileRefusal(value))
        this.denials.add(value);
      throw value;
    }
  }
  private retain<T>(
    original: Promise<T>,
    cancellation?: () => Readonly<{ value: unknown }> | undefined
  ): Promise<T> {
    this.work.add(original);
    void original.then(
      () => this.work.delete(original),
      (value) => {
        const cancelled = cancellation?.();
        if (!cancelled || cancelled.value !== value) this.fail(value);
        this.work.delete(original);
      }
    );
    return original;
  }
  private async rootCurrent(): Promise<string> {
    const root = this.root;
    if (!root) throw browserFileRefusal('unavailable');
    const stat = await lstat(root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.rootDev ||
      stat.ino !== this.rootIno
    )
      throw browserFileRefusal('inaccessible');
    return root;
  }
  /** Stage copied bounded bytes only after the host's independent actual artifact grant admission. */
  stage(
    actor: Readonly<{ owner: string; credential: object }>,
    binding: BrowserBinding,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
    current: () => boolean
  ): Promise<
    Readonly<{
      artifactId: string;
      byteLength: number;
      discard: () => Promise<void>;
    }>
  > {
    this.check();
    if (
      !actor ||
      typeof actor.owner !== 'string' ||
      !actor.owner ||
      !actor.credential ||
      !bytes.byteLength ||
      bytes.byteLength > MAX_BYTES ||
      !TYPES.has(mimeType) ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(name) ||
      name === '.' ||
      name === '..'
    )
      throw browserFileRefusal('inaccessible');
    const scoped = [...this.cells.values()].filter(
      (c) =>
        c.owner === actor.owner &&
        c.binding.browserId === binding.browserId &&
        c.binding.browserGeneration === binding.browserGeneration
    );
    if (
      this.cells.size >= 64 ||
      scoped.length >= 8 ||
      scoped.reduce((n, c) => n + c.length, 0) + bytes.byteLength > 8 * MAX_BYTES
    )
      throw browserFileRefusal('unavailable');
    const owned = Buffer.from(bytes);
    const id = randomBytes(24).toString('base64url');
    const cell: Cell = {
      id,
      actor: actor.credential,
      owner: actor.owner,
      binding: Object.freeze({ ...binding }),
      directory: '',
      path: '',
      name,
      mimeType,
      length: owned.length,
      hash: createHash('sha256').update(owned).digest('hex'),
      consumed: false,
    };
    this.cells.set(id, cell); // Reserve bounded custody before any original asynchronous acquisition.
    return this.retain(
      Promise.resolve().then(async () => {
        const admit = () => {
          this.check();
          if (!this.admitted(current)) throw this.denial('inaccessible');
          this.check();
        };
        try {
          await this.ready;
          admit();
          const root = await this.rootCurrent();
          admit();
          cell.directory = join(root, id);
          cell.path = join(cell.directory, cell.name);
          await mkdir(cell.directory, { mode: 0o700 });
          admit();
          if ((await realpath(cell.directory)) !== cell.directory)
            throw browserFileRefusal('inaccessible');
          admit();
          const handle = await open(
            cell.path,
            constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600
          );
          cell.handle = handle; // Retain immediately before any post-open check/getter.
          admit();
          const stat = await handle.stat();
          cell.dev = stat.dev;
          cell.ino = stat.ino;
          admit();
          if (!stat.isFile() || stat.size !== 0 || stat.mode & 0o077)
            throw browserFileRefusal('inaccessible');
          await handle.writeFile(owned);
          admit();
          await handle.sync();
          admit();
          const actual = await handle.stat();
          admit();
          if (actual.size !== cell.length || actual.dev !== cell.dev || actual.ino !== cell.ino)
            throw browserFileRefusal('inaccessible');
          return Object.freeze({
            artifactId: id,
            byteLength: cell.length,
            discard: () => this.release(cell),
          });
        } catch (value) {
          this.fail(value);
          try {
            await this.release(cell);
          } catch (cleanup) {
            this.fail(cleanup);
          }
          throw value;
        } finally {
          owned.fill(0);
        }
      })
    );
  }
  /** Copy one original staged cell under independently refreshed artifact authority; never expose its path. */
  read(
    actor: Readonly<{ owner: string; credential: object }>,
    binding: BrowserBinding,
    artifactId: string,
    current: () => boolean,
    signal: AbortSignal
  ) {
    this.check();
    const cell = this.cells.get(artifactId);
    if (
      !cell ||
      cell.actor !== actor.credential ||
      cell.owner !== actor.owner ||
      !same(cell.binding, binding) ||
      cell.consumed ||
      cell.closing ||
      !cell.handle
    )
      throw browserFileRefusal('inaccessible');
    const handle = cell.handle;
    let cancellation: Readonly<{ value: unknown }> | undefined;
    return this.retain(
      Promise.resolve().then(async () => {
        const admit = () => {
          if (signal.aborted && isOriginalBrowserFileRefusal(signal.reason)) {
            cancellation = { value: signal.reason };
            throw cancellation.value;
          }
          signal.throwIfAborted();
          this.check();
          if (
            !this.admitted(current) ||
            this.cells.get(cell.id) !== cell ||
            cell.consumed ||
            cell.closing
          )
            throw this.denial('inaccessible');
          this.check();
        };
        admit();
        await this.ready;
        admit();
        await this.rootCurrent();
        admit();
        if ((await realpath(cell.directory)) !== cell.directory)
          throw browserFileRefusal('inaccessible');
        admit();
        const pathStat = await lstat(cell.path);
        admit();
        if (
          !pathStat.isFile() ||
          pathStat.isSymbolicLink() ||
          pathStat.dev !== cell.dev ||
          pathStat.ino !== cell.ino
        )
          throw browserFileRefusal('inaccessible');
        const stat = await handle.stat();
        admit();
        if (stat.dev !== cell.dev || stat.ino !== cell.ino || stat.size !== cell.length)
          throw browserFileRefusal('inaccessible');
        const bytes = Buffer.alloc(cell.length);
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset);
            admit();
            if (!result.bytesRead) throw browserFileRefusal('inaccessible');
            offset += result.bytesRead;
          }
          const final = await handle.stat();
          admit();
          const finalPath = await lstat(cell.path);
          admit();
          if (
            final.dev !== cell.dev ||
            final.ino !== cell.ino ||
            final.size !== cell.length ||
            !finalPath.isFile() ||
            finalPath.isSymbolicLink() ||
            finalPath.dev !== cell.dev ||
            finalPath.ino !== cell.ino ||
            createHash('sha256').update(bytes).digest('hex') !== cell.hash
          )
            throw browserFileRefusal('inaccessible');
          return Object.freeze({
            artifactId: cell.id,
            name: cell.name,
            mimeType: cell.mimeType,
            byteLength: cell.length,
            bytes,
          });
        } catch (value) {
          bytes.fill(0);
          throw value;
        }
      }),
      () => cancellation
    );
  }
  /** Claim once for exact original actor/binding; native upload permission is checked separately by the host. */
  claim(
    actor: Readonly<{ owner: string; credential: object }>,
    binding: BrowserBinding,
    artifactId: string,
    current: () => boolean
  ): OwnedUploadLease {
    this.check();
    const cell = this.cells.get(artifactId);
    if (
      !cell ||
      cell.actor !== actor.credential ||
      cell.owner !== actor.owner ||
      !same(cell.binding, binding) ||
      cell.consumed ||
      !cell.handle
    )
      throw browserFileRefusal('inaccessible');
    if (!this.admitted(current)) throw this.denial('inaccessible');
    this.check();
    cell.consumed = true;
    let entered = false;
    return Object.freeze({
      artifactId,
      binding: cell.binding,
      consume: (signal: AbortSignal) => {
        if (entered) throw browserFileRefusal('inaccessible');
        entered = true;
        let cancellation: Readonly<{ value: unknown }> | undefined;
        return this.retain(
          Promise.resolve().then(async () => {
            const admit = () => {
              if (signal.aborted && isOriginalBrowserFileRefusal(signal.reason)) {
                cancellation = { value: signal.reason };
                throw cancellation.value;
              }
              signal.throwIfAborted();
              this.check();
              if (!this.admitted(current)) throw this.denial('inaccessible');
              this.check();
            };
            admit();
            await this.rootCurrent();
            admit();
            if ((await realpath(cell.directory)) !== cell.directory)
              throw browserFileRefusal('inaccessible');
            admit();
            const pathStat = await lstat(cell.path);
            admit();
            if (
              !pathStat.isFile() ||
              pathStat.isSymbolicLink() ||
              pathStat.dev !== cell.dev ||
              pathStat.ino !== cell.ino
            )
              throw browserFileRefusal('inaccessible');
            const handle = cell.handle;
            if (!handle) throw browserFileRefusal('inaccessible');
            const stat = await handle.stat();
            admit();
            if (stat.dev !== cell.dev || stat.ino !== cell.ino || stat.size !== cell.length)
              throw browserFileRefusal('inaccessible');
            const buffer = Buffer.alloc(cell.length);
            let offset = 0;
            try {
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset);
                admit();
                if (!read.bytesRead) throw browserFileRefusal('inaccessible');
                offset += read.bytesRead;
              }
              const final = await handle.stat();
              admit();
              if (
                final.size !== cell.length ||
                final.dev !== cell.dev ||
                final.ino !== cell.ino ||
                createHash('sha256').update(buffer).digest('hex') !== cell.hash
              )
                throw browserFileRefusal('inaccessible');
              buffer.fill(0);
              return Object.freeze({
                path: cell.path,
                byteLength: cell.length,
              });
            } catch (value) {
              buffer.fill(0);
              throw value;
            }
          }),
          () => cancellation
        );
      },
      enter: (effect: () => Promise<void>) => {
        if (cell.native || cell.closing || !entered) throw browserFileRefusal('inaccessible');
        const original = Promise.resolve().then(async () => {
          this.check();
          if (!this.admitted(current)) throw this.denial('inaccessible');
          this.check();
          await this.rootCurrent();
          this.check();
          const stat = await lstat(cell.path);
          this.check();
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.dev !== cell.dev ||
            stat.ino !== cell.ino ||
            stat.size !== cell.length
          )
            throw browserFileRefusal('inaccessible');
          const handle = cell.handle;
          if (!handle) throw browserFileRefusal('inaccessible');
          const bytes = Buffer.alloc(cell.length);
          try {
            let offset = 0;
            while (offset < bytes.length) {
              const read = await handle.read(bytes, offset, bytes.length - offset, offset);
              this.check();
              if (!this.admitted(current)) throw this.denial('inaccessible');
              if (!read.bytesRead) throw browserFileRefusal('inaccessible');
              offset += read.bytesRead;
            }
            if (createHash('sha256').update(bytes).digest('hex') !== cell.hash)
              throw browserFileRefusal('inaccessible');
            this.check();
            if (!this.admitted(current)) throw this.denial('inaccessible');
            if ((await realpath(cell.directory)) !== cell.directory)
              throw browserFileRefusal('inaccessible');
            const final = await lstat(cell.path);
            this.check();
            if (
              !final.isFile() ||
              final.isSymbolicLink() ||
              final.dev !== cell.dev ||
              final.ino !== cell.ino ||
              final.size !== cell.length
            )
              throw browserFileRefusal('inaccessible');
            await effect();
          } finally {
            bytes.fill(0);
          }
        });
        cell.native = this.retain(original);
        return original;
      },
      close: () => this.release(cell),
    });
  }
  private release(cell: Cell): Promise<void> {
    if (cell.closing) return cell.closing;
    cell.closing = this.retain(
      Promise.resolve().then(async () => {
        let failure: Readonly<{ value: unknown }> | undefined;
        try {
          await cell.native;
        } catch (value) {
          failure = { value };
        }
        if (cell.path && cell.handle) {
          try {
            await this.rootCurrent();
            const stat = await lstat(cell.path);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.dev !== cell.dev ||
              stat.ino !== cell.ino
            )
              throw browserFileRefusal('inaccessible');
            await unlink(cell.path);
          } catch (value) {
            this.fail(value);
            failure ??= { value };
          }
        }
        try {
          await cell.handle?.close();
        } catch (value) {
          this.fail(value);
          failure ??= { value };
        }
        if (cell.directory) {
          try {
            await rmdir(cell.directory);
          } catch (value) {
            this.fail(value);
            failure ??= { value };
          }
        }
        if (failure) throw failure.value;
        this.cells.delete(cell.id);
      })
    );
    return cell.closing;
  }
  /** Fence all admission, join original reads/writes, then independently retire every owned file handle. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.work]);
      await Promise.allSettled([...this.cells.values()].map((cell) => this.release(cell)));
      if (this.first) throw this.first.value;
    });
    return this.closing;
  }
}

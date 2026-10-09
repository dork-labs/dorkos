/** Fixed ordinary namespace operations; this provides no document/source permission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { Db } from '@dorkos/db';
import { z } from 'zod';
import {
  CreateEntryRequestSchema,
  DeleteEntryQuerySchema,
  RenameEntryRequestSchema,
  CopyEntryRequestSchema,
} from '@dorkos/shared/schemas';
import { getBoundary } from '../../../../lib/boundary.js';
import { resolveWithinCwd } from '../../../../lib/file-route-guards.js';
import type { DocChannelStore } from '../store.js';
import {
  captureDocHttpFileWriteCaller,
  requireDocHttpFileWriteCurrent,
  retireDocHttpFileWriteCaller,
} from '../http-composition.js';
import {
  InstallationFileWrites,
  requireInstallationFileWritesOwner,
  requireInstallationFileWritesAdmission,
  requireInstallationHttpFileWriter,
  requireInstallationFileWriteAssembly,
} from './installation-file-writes.js';
import {
  withRecognizedInstallationMutation,
  type OwnedMutation,
} from './installation-mutations.js';
import {
  hasRecognizedCheckboxUnresolved,
  CheckboxWriteFencedError,
  CheckboxFenceUnavailableError,
} from './checkbox-fence.js';

type Commands = {
  create: z.infer<typeof CreateEntryRequestSchema>;
  delete: z.infer<typeof DeleteEntryQuerySchema>;
  rename: z.infer<typeof RenameEntryRequestSchema>;
  copy: z.infer<typeof CopyEntryRequestSchema>;
};
export type HttpNamespaceResult = Readonly<{
  status: number;
  body: Readonly<Record<string, unknown>>;
}>;
type Binding = {
  writer: InstallationHttpFileWrites;
  owner: InstallationFileWrites;
  db: Db;
  store: DocChannelStore;
  requireOutside(): void;
  execute<K extends keyof Commands>(
    kind: K,
    req: Request,
    res: Response,
    input: Commands[K]
  ): Promise<HttpNamespaceResult>;
  stop(): Promise<void>;
};
const writers = new WeakMap<object, Binding>();
type Scope = {
  caller: object;
  owned: OwnedMutation;
  active: boolean;
  boundaries: Map<string, { cwd: string; target: string; resolved: string; validatedCwd: string }>;
};
const schemas = {
  create: CreateEntryRequestSchema,
  delete: DeleteEntryQuerySchema,
  rename: RenameEntryRequestSchema,
  copy: CopyEntryRequestSchema,
};
function result(status: number, error: string, code: string): HttpNamespaceResult {
  return { status, body: { error, code } };
}
function code(error: unknown): unknown {
  return error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
}
function recognized(value: unknown): Binding {
  const binding = value && typeof value === 'object' ? writers.get(value) : undefined;
  if (!binding) throw new Error('File namespace writes are not available.');
  requireInstallationHttpFileWriter(binding.owner, binding.db, binding.store, binding.writer);
  return binding;
}
/** Require the installation HTTP writer's exact original assembly. */
export function requireInstallationHttpFileWrites(value: unknown): InstallationHttpFileWrites {
  return recognized(value).writer;
}
/** Create a file through the captured installation HTTP writer. */
export function executeInstallationHttpFileCreate(
  value: unknown,
  req: Request,
  res: Response,
  input: Commands['create']
): Promise<HttpNamespaceResult> {
  return recognized(value).execute('create', req, res, input);
}
/** Delete a file through the captured installation HTTP writer. */
export function executeInstallationHttpFileDelete(
  value: unknown,
  req: Request,
  res: Response,
  input: Commands['delete']
): Promise<HttpNamespaceResult> {
  return recognized(value).execute('delete', req, res, input);
}
/** Rename a file through the captured installation HTTP writer. */
export function executeInstallationHttpFileRename(
  value: unknown,
  req: Request,
  res: Response,
  input: Commands['rename']
): Promise<HttpNamespaceResult> {
  return recognized(value).execute('rename', req, res, input);
}
/** Copy a file through the captured installation HTTP writer. */
export function executeInstallationHttpFileCopy(
  value: unknown,
  req: Request,
  res: Response,
  input: Commands['copy']
): Promise<HttpNamespaceResult> {
  return recognized(value).execute('copy', req, res, input);
}
/** Require installation HTTP shutdown outside an active transaction. */
export function requireInstallationHttpFileStopOutside(value: InstallationHttpFileWrites): void {
  recognized(value).requireOutside();
}
/** Stop the recognized installation HTTP writer through its captured lifetime. */
export function stopRecognizedInstallationHttpFileWrites(
  value: InstallationHttpFileWrites
): Promise<void> {
  return recognized(value).stop();
}

/** Own HTTP file mutations for one original installation. */
export class InstallationHttpFileWrites {
  readonly #owner: InstallationFileWrites;
  readonly #db: Db;
  readonly #store: DocChannelStore;
  readonly #native: Db['$client'];
  readonly #root: string;
  readonly #context = new AsyncLocalStorage<boolean>();
  readonly #active = new Set<Promise<unknown>>();
  #closed = false;
  #draining?: Promise<void>;
  constructor(owner: InstallationFileWrites, db: Db, store: DocChannelStore) {
    requireInstallationFileWritesOwner(owner, db, store);
    this.#owner = owner;
    this.#db = db;
    this.#store = store;
    this.#native = db.$client;
    this.#root = getBoundary();
    this.#outside();
    writers.set(this, {
      writer: this,
      owner,
      db,
      store,
      requireOutside: () => this.#stopOutside(),
      execute: (kind, req, res, input) => this.#admit(kind, req, res, input),
      stop: () => this.#stop(),
    });
  }
  #outside(): void {
    requireInstallationFileWritesOwner(this.#owner, this.#db, this.#store);
    if (this.#db.$client !== this.#native || !this.#native.open || this.#native.inTransaction)
      throw new Error('File mutation requires the original inactive native database.');
  }
  #stopOutside(): void {
    if (this.#context.getStore()) throw new Error('Recursive namespace writer stop.');
  }
  #stop(): Promise<void> {
    this.#stopOutside();
    if (!this.#draining) {
      this.#closed = true;
      this.#draining = Promise.allSettled([...this.#active]).then(() => {});
    }
    return this.#draining;
  }
  #admit<K extends keyof Commands>(
    kind: K,
    req: Request,
    res: Response,
    raw: Commands[K]
  ): Promise<HttpNamespaceResult> {
    if (this.#closed) return Promise.reject(new CheckboxFenceUnavailableError('missing'));
    if (this.#context.getStore())
      return Promise.reject(new Error('Recursive namespace writer operation.'));
    requireInstallationFileWritesAdmission(this.#owner, this.#db, this.#store);
    const input = Object.freeze(schemas[kind].parse(raw)) as Commands[K];
    const caller = captureDocHttpFileWriteCaller(this.#owner, req, res);
    try {
      requireInstallationFileWritesAdmission(this.#owner, this.#db, this.#store);
      if (this.#closed) throw new CheckboxFenceUnavailableError('missing');
    } catch (error) {
      try {
        retireDocHttpFileWriteCaller(this.#owner, caller);
      } catch {
        /* Keep the exact admission cause. */
      }
      throw error;
    }
    const operation = Promise.resolve().then(() =>
      this.#context.run(true, () => this.#run(kind, input, caller))
    );
    this.#active.add(operation);
    void operation.then(
      () => this.#active.delete(operation),
      () => this.#active.delete(operation)
    );
    return operation;
  }
  #current(scope: Scope, cleanup = false): void {
    this.#outside();
    requireInstallationHttpFileWriter(this.#owner, this.#db, this.#store, this);
    if (!scope.active || getBoundary() !== this.#root)
      throw new Error('Inactive namespace operation or changed boundary.');
    scope.owned.assertActive();
    if (!cleanup) requireDocHttpFileWriteCurrent(this.#owner, scope.caller);
    const assembly = requireInstallationFileWriteAssembly(this.#owner, this.#db, this.#store);
    if (hasRecognizedCheckboxUnresolved(assembly.fence, this.#db, this.#store))
      throw new CheckboxWriteFencedError();
    this.#outside();
    scope.owned.assertActive();
  }
  async #check(scope: Scope, cleanup = false): Promise<void> {
    this.#current(scope, cleanup);
    await scope.owned.assertCurrentRoots();
    this.#current(scope, cleanup);
    for (const boundary of scope.boundaries.values()) {
      const actual = await resolveWithinCwd(boundary.cwd, boundary.target);
      this.#current(scope, cleanup);
      if (actual.resolved !== boundary.resolved || actual.validatedCwd !== boundary.validatedCwd)
        throw new Error('Namespace target changed.');
    }
  }
  async #read<T>(scope: Scope, operation: () => Promise<T>): Promise<T> {
    this.#current(scope);
    const value = await operation();
    await this.#check(scope);
    return value;
  }
  async #effect<T>(scope: Scope, operation: () => Promise<T>): Promise<T> {
    await this.#check(scope);
    this.#current(scope);
    return this.#read(scope, operation);
  }
  /** Await root/path work first, then prove owned names immediately before a native effect. */
  async #ownedEffect<T>(
    scope: Scope,
    targets: readonly { path: string; identity: { dev: bigint; ino: bigint } }[],
    operation: () => Promise<T>
  ): Promise<T> {
    await this.#check(scope);
    for (const target of targets) {
      this.#current(scope);
      const actual = await fs.lstat(target.path, { bigint: true });
      this.#current(scope);
      if (actual.dev !== target.identity.dev || actual.ino !== target.identity.ino)
        throw new Error('Owned forward path was replaced.');
    }
    // No awaited scope check follows the last ownership observation before launch.
    this.#current(scope);
    const value = await operation();
    await this.#check(scope);
    return value;
  }
  async #resolve(scope: Scope, cwd: string, target: string) {
    const actual = await this.#read(scope, () => resolveWithinCwd(cwd, target));
    scope.boundaries.set(JSON.stringify([cwd, target]), { cwd, target, ...actual });
    return actual;
  }
  async #missing(scope: Scope, target: string): Promise<boolean> {
    try {
      await this.#read(scope, () => fs.lstat(target));
      return false;
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      await this.#check(scope);
      return true;
    }
  }
  async #run<K extends keyof Commands>(
    kind: K,
    input: Commands[K],
    caller: object
  ): Promise<HttpNamespaceResult> {
    let failed = false;
    let cause: unknown;
    let answer: HttpNamespaceResult | undefined;
    try {
      const assembly = requireInstallationFileWriteAssembly(this.#owner, this.#db, this.#store);
      answer = await withRecognizedInstallationMutation(
        assembly.installation,
        'opaque',
        [{ directory: this.#root }],
        async (owned) => {
          const scope: Scope = { caller, owned, active: true, boundaries: new Map() };
          try {
            await this.#check(scope);
            switch (kind) {
              case 'create':
                return await this.#create(scope, input as Commands['create']);
              case 'delete':
                return await this.#delete(scope, input as Commands['delete']);
              case 'rename':
                return await this.#rename(scope, input as Commands['rename']);
              case 'copy':
                return await this.#copy(scope, input as Commands['copy']);
            }
            throw new Error('Unknown fixed namespace operation.');
          } finally {
            scope.active = false;
          }
        }
      );
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      try {
        retireDocHttpFileWriteCaller(this.#owner, caller);
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
    if (failed) throw cause;
    return answer!;
  }
  async #cleanupOwned(
    scope: Scope,
    target: string,
    identity: { dev: bigint; ino: bigint },
    recursive: boolean,
    children: readonly { path: string; identity: { dev: bigint; ino: bigint } }[] = []
  ): Promise<void> {
    await this.#check(scope, true);
    let actual;
    try {
      actual = await fs.lstat(target, { bigint: true });
    } catch (error) {
      if (code(error) === 'ENOENT') return;
      throw error;
    }
    this.#current(scope, true);
    if (actual.dev !== identity.dev || actual.ino !== identity.ino)
      throw new Error('Owned cleanup path was replaced.');
    for (const child of children) {
      this.#current(scope, true);
      const observed = await fs.lstat(child.path, { bigint: true });
      this.#current(scope, true);
      if (observed.dev !== child.identity.dev || observed.ino !== child.identity.ino)
        throw new Error('Owned cleanup child was replaced.');
    }
    if (children.length) {
      // Child observations awaited; repeat the directory proof as the final native observation.
      const finalRoot = await fs.lstat(target, { bigint: true });
      this.#current(scope, true);
      if (finalRoot.dev !== identity.dev || finalRoot.ino !== identity.ino)
        throw new Error('Owned cleanup root was replaced.');
    }
    this.#current(scope, true);
    await fs.rm(target, { recursive, force: false });
    await this.#check(scope, true);
  }
  async #create(scope: Scope, input: Commands['create']): Promise<HttpNamespaceResult> {
    const { validatedCwd, resolved } = await this.#resolve(scope, input.cwd, input.path);
    if (resolved === validatedCwd)
      return result(400, 'Refusing to create over the working-directory root', 'REFUSE_ROOT');
    if (!(await this.#missing(scope, resolved)))
      return result(409, 'Target already exists', 'CONFLICT');
    await this.#effect(scope, () => fs.mkdir(path.dirname(resolved), { recursive: true }));
    if (input.type === 'dir') {
      await this.#effect(scope, () => fs.mkdir(resolved));
    } else {
      const temp = `${resolved}.${randomBytes(6).toString('hex')}.tmp`;
      let file: FileHandle | undefined;
      let identity: { dev: bigint; ino: bigint } | undefined;
      let failed = false;
      let cause: unknown;
      try {
        await this.#check(scope);
        this.#current(scope);
        file = await fs.open(temp, 'wx');
        this.#outside();
        scope.owned.assertActive();
        identity = await file.stat({ bigint: true });
        await this.#check(scope);
        await this.#effect(scope, () => file!.writeFile(input.content ?? '', 'utf8'));
        await file.close();
        file = undefined;
        await this.#check(scope);
        // Hard-link publication is atomic and refuses an occupied target, including dangling links.
        await this.#ownedEffect(scope, [{ path: temp, identity }], () => fs.link(temp, resolved));
      } catch (error) {
        failed = true;
        cause = error;
      } finally {
        try {
          await file?.close();
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
        try {
          if (identity) await this.#cleanupOwned(scope, temp, identity, false);
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      }
      if (failed) throw cause;
    }
    return {
      status: 201,
      body: { ok: true, path: path.relative(validatedCwd, resolved).split(path.sep).join('/') },
    };
  }
  async #delete(scope: Scope, input: Commands['delete']): Promise<HttpNamespaceResult> {
    const { validatedCwd, resolved } = await this.#resolve(scope, input.cwd, input.path);
    if (resolved === validatedCwd)
      return result(400, 'Refusing to delete the working-directory root', 'REFUSE_ROOT');
    const info = await this.#read(scope, () => fs.lstat(resolved));
    if (
      info.isDirectory() &&
      !input.recursive &&
      (await this.#read(scope, () => fs.readdir(resolved))).length > 0
    )
      return result(409, 'Directory is not empty; pass recursive', 'DIR_NOT_EMPTY');
    await this.#effect(scope, () => fs.rm(resolved, { recursive: input.recursive, force: false }));
    return { status: 200, body: { ok: true } };
  }
  async #pair(scope: Scope, input: Commands['rename']) {
    const from = await this.#resolve(scope, input.cwd, input.from);
    const to = await this.#resolve(scope, input.cwd, input.to);
    return { cwd: from.validatedCwd, from: from.resolved, to: to.resolved };
  }
  async #rename(scope: Scope, input: Commands['rename']): Promise<HttpNamespaceResult> {
    const pair = await this.#pair(scope, input);
    if (pair.from === pair.cwd || pair.to === pair.cwd)
      return result(400, 'Refusing to move the working-directory root', 'REFUSE_ROOT');
    await this.#read(scope, () => fs.lstat(pair.from));
    if (!(await this.#missing(scope, pair.to)))
      return result(409, 'Target already exists', 'CONFLICT');
    await this.#effect(scope, () => fs.mkdir(path.dirname(pair.to), { recursive: true }));
    // Repeat confinement after parent creation; cooperating writers remain excluded.
    await this.#pair(scope, input);
    if (!(await this.#missing(scope, pair.to)))
      return result(409, 'Target already exists', 'CONFLICT');
    await this.#effect(scope, () => fs.rename(pair.from, pair.to));
    return { status: 200, body: { ok: true } };
  }
  async #copy(scope: Scope, input: Commands['copy']): Promise<HttpNamespaceResult> {
    const pair = await this.#pair(scope, input);
    if (pair.from === pair.cwd || pair.to === pair.cwd)
      return result(400, 'Refusing to copy over the working-directory root', 'REFUSE_ROOT');
    const info = await this.#read(scope, () => fs.stat(pair.from));
    if (!(await this.#missing(scope, pair.to)))
      return result(409, 'Target already exists', 'CONFLICT');
    if (info.isDirectory() && (pair.to === pair.from || pair.to.startsWith(pair.from + path.sep)))
      return result(400, 'Refusing to copy a folder into itself', 'COPY_INTO_SELF');
    await this.#effect(scope, () => fs.mkdir(path.dirname(pair.to), { recursive: true }));
    let staging: string | undefined;
    let stageIdentity: { dev: bigint; ino: bigint } | undefined;
    let destinationIdentity: { dev: bigint; ino: bigint } | undefined;
    let stagedIdentity: { dev: bigint; ino: bigint } | undefined;
    let failed = false;
    let cause: unknown;
    try {
      await this.#check(scope);
      this.#current(scope);
      staging = await fs.mkdtemp(`${pair.to}.copy-`);
      this.#outside();
      scope.owned.assertActive();
      stageIdentity = await fs.lstat(staging, { bigint: true });
      await this.#check(scope);
      const staged = path.join(staging, 'entry');
      await this.#ownedEffect(scope, [{ path: staging, identity: stageIdentity }], async () => {
        await fs.cp(pair.from, staged, { recursive: true, errorOnExist: true, force: false });
        this.#outside();
        scope.owned.assertActive();
        stagedIdentity = await fs.lstat(staged, { bigint: true });
      });
      await this.#pair(scope, input);
      if (info.isDirectory()) {
        // Exclusive root reservation establishes ownership before any destination copying.
        await this.#check(scope);
        this.#current(scope);
        await fs.mkdir(pair.to);
        this.#outside();
        scope.owned.assertActive();
        destinationIdentity = await fs.lstat(pair.to, { bigint: true });
        await this.#check(scope);
        await this.#ownedEffect(
          scope,
          [
            { path: staging, identity: stageIdentity },
            { path: staged, identity: stagedIdentity! },
            { path: pair.to, identity: destinationIdentity },
          ],
          () => fs.cp(staged, pair.to, { recursive: true, errorOnExist: true, force: false })
        );
      } else {
        await this.#ownedEffect(
          scope,
          [
            { path: staging, identity: stageIdentity },
            { path: staged, identity: stagedIdentity! },
          ],
          () => fs.link(staged, pair.to)
        );
      }
    } catch (error) {
      failed = true;
      cause = error;
    } finally {
      try {
        if (failed && destinationIdentity)
          await this.#cleanupOwned(scope, pair.to, destinationIdentity, true);
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
      try {
        if (staging && stageIdentity)
          await this.#cleanupOwned(
            scope,
            staging,
            stageIdentity,
            true,
            stagedIdentity ? [{ path: path.join(staging, 'entry'), identity: stagedIdentity }] : []
          );
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
    if (failed) throw cause;
    return { status: 200, body: { ok: true } };
  }
}

import {
  DocumentFileSave,
  type DocumentFileSaveDependencies,
  type DocumentFileSaveCaller,
} from './document-file-save.js';
/** Installation-owned ordinary and checkbox writes share one physical-file gate. */
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Db } from '@dorkos/db';
import { requireDocChannelStoreDatabase, DocChannelStore } from '../store.js';
import { resolveWithinCwd, sha256 } from '../../../../lib/file-route-guards.js';
import {
  CanonicalFileWriteCoordinator,
  CanonicalFileIdentityChangedError,
  type CanonicalFileIdentity,
  type CanonicalWriteLease,
} from './canonical-writer.js';
import { DocCheckboxWriteService } from './checkbox-service.js';
import { CheckboxWriteFence } from './checkbox-fence.js';

interface FileSaveInput {
  cwd: string;
  path: string;
  content: string;
  expectedHash?: string;
  expectedContent?: string;
}

const originalOwners = new WeakMap<
  object,
  { db?: Db; coordinator: CanonicalFileWriteCoordinator; store?: DocChannelStore }
>();
/** Validate constructor identities without revealing the coordinator or accepting a callback. */
export function requireOriginalDocumentFileOwner(
  owner: InstallationFileWrites,
  db: Db,
  store: DocChannelStore,
  coordinator: CanonicalFileWriteCoordinator
): void {
  const own = originalOwners.get(owner);
  if (!own || own.db !== db || own.store !== store || own.coordinator !== coordinator)
    throw new Error('Document file owner mismatch');
  requireDocChannelStoreDatabase(store, db);
}

const originalDocumentSaves = new WeakMap<
  object,
  (raw: unknown, caller: DocumentFileSaveCaller) => ReturnType<DocumentFileSave['save']>
>();
/** Invoke only the constructor-captured original method, never a public callback-shaped replacement. */
export function saveOriginalDocumentFile(
  owner: InstallationFileWrites,
  raw: unknown,
  caller: DocumentFileSaveCaller
) {
  const original = originalDocumentSaves.get(owner);
  if (!original) throw new Error('Document file saves are unavailable');
  return original(raw, caller);
}

/** The coordinator never escapes this owner; callers cannot supply a write callback. */
export class InstallationFileWrites {
  readonly #coordinator: CanonicalFileWriteCoordinator;
  readonly #checkboxes = new Set<DocCheckboxWriteService>();
  #stopped = false;
  readonly #fence?: CheckboxWriteFence;
  readonly #documentSaves?: DocumentFileSave;

  readonly #db?: Db;
  constructor(db?: Db, document?: DocumentFileSaveDependencies) {
    this.#db = db;
    if (db) this.#fence = new CheckboxWriteFence(db, new DocChannelStore(db));
    this.#coordinator = new CanonicalFileWriteCoordinator({
      assertOutsideTransaction: () => {
        if (this.#db?.$client.inTransaction) throw new Error('Filesystem work inside transaction');
      },
      resolve: async (file) => {
        const canonicalPath = await fs.realpath(file);
        const info = await fs.stat(canonicalPath, { bigint: true });
        if (!info.isFile())
          throw Object.assign(new Error('Not a regular file'), { code: 'NOT_A_FILE' });
        return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
      },
    });
    originalOwners.set(this, { db, coordinator: this.#coordinator, store: document?.channels });
    if (document) {
      if (document.db !== db || !this.#fence)
        throw new Error('Document file owner database mismatch');
      this.#documentSaves = new DocumentFileSave(this, document, this.#coordinator, this.#fence);
      const save = this.#documentSaves.save.bind(this.#documentSaves);
      originalDocumentSaves.set(this, save);
    }
  }

  /** Fixed factory retains the existing checkbox authority and completion protocol. */
  createCheckboxService(
    store: ConstructorParameters<typeof DocCheckboxWriteService>[1],
    authority: ConstructorParameters<typeof DocCheckboxWriteService>[3],
    delivery: ConstructorParameters<typeof DocCheckboxWriteService>[4],
    options?: ConstructorParameters<typeof DocCheckboxWriteService>[5]
  ): DocCheckboxWriteService {
    if (this.#stopped || !this.#db) throw new Error('Installation file writes are unavailable');
    const service = new DocCheckboxWriteService(
      this.#db,
      store,
      this.#coordinator,
      authority,
      delivery,
      options
    );
    this.#checkboxes.add(service);
    return service;
  }

  /** Save existing confined content with the baseline check and replacement under one gate. */
  async save(raw: FileSaveInput) {
    const input = { ...raw };
    if (this.#stopped) throw new Error('Installation file writes are stopped');
    const { resolved } = await resolveWithinCwd(input.cwd, input.path);
    return this.#coordinator.withFiles([resolved], async ([identity], lease) => {
      const currentPath = await resolveWithinCwd(input.cwd, input.path);
      if (currentPath.resolved !== identity!.canonicalPath)
        throw new CanonicalFileIdentityChangedError();
      this.#fence?.assertAdmission(identity!);
      const current = await fs.readFile(identity!.canonicalPath, 'utf8');
      const currentHash = sha256(current);
      const expected =
        input.expectedHash ??
        (input.expectedContent !== undefined ? sha256(input.expectedContent) : undefined);
      if (expected !== undefined && expected !== currentHash) {
        return {
          status: 409 as const,
          body: {
            error: 'File changed on disk since it was opened',
            code: 'CONFLICT',
            currentHash,
            currentContent: current,
          },
        };
      }
      const hash = sha256(input.content);
      if (hash === currentHash)
        return { status: 200 as const, body: { ok: true, hash, effect: 'no_op' } };
      await this.replace(input, identity!, lease, currentHash);
      return { status: 200 as const, body: { ok: true, hash, effect: 'changed' } };
    });
  }

  /** Keep temporary-file ownership checks and cleanup in the same replacement operation. */
  private async replace(
    input: FileSaveInput,
    identity: CanonicalFileIdentity,
    lease: CanonicalWriteLease,
    currentHash: string
  ): Promise<void> {
    const temporary = `${identity.canonicalPath}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(temporary, 'wx');
    const owned = await handle.stat({ bigint: true }).catch(async (error: unknown) => {
      await handle.close();
      throw error;
    });
    const sameTemporary = async () => {
      const named = await fs.lstat(temporary, { bigint: true });
      return named.isFile() && named.dev === owned.dev && named.ino === owned.ino;
    };
    try {
      await handle.writeFile(input.content, 'utf8');
      const replacement = await lease.reserveReplacement(temporary);
      if (
        replacement.canonicalPath !== temporary ||
        replacement.device !== String(owned.dev) ||
        replacement.inode !== String(owned.ino) ||
        !(await sameTemporary())
      )
        throw new CanonicalFileIdentityChangedError();
      // External writers do not honor this cooperative gate; refuse observed changes.
      const target = await resolveWithinCwd(input.cwd, input.path);
      const info = await fs.stat(target.resolved, { bigint: true });
      if (
        target.resolved !== identity.canonicalPath ||
        String(info.dev) !== identity.device ||
        String(info.ino) !== identity.inode ||
        sha256(await fs.readFile(target.resolved, 'utf8')) !== currentHash
      )
        throw new CanonicalFileIdentityChangedError();
      this.#fence?.assertAdmission(identity!);
      if (!(await sameTemporary())) throw new CanonicalFileIdentityChangedError();
      await fs.rename(temporary, identity.canonicalPath);
    } catch (error) {
      // Never remove a pathname now occupied by somebody else's replacement.
      if (await sameTemporary().catch(() => false)) await fs.unlink(temporary);
      throw error;
    } finally {
      await handle.close();
    }
  }

  /** Close admission synchronously, then drain admitted ordinary and checkbox writes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const writes = this.#coordinator.stop();
    await Promise.all([
      writes,
      this.#documentSaves?.stop(),
      ...[...this.#checkboxes].map((service) => service.stop()),
    ]);
  }
}

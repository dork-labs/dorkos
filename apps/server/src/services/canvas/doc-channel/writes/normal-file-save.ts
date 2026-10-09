/** Finite ordinary save; it creates no document approval, intent or saved event. */
import { randomBytes } from 'node:crypto';
import { readFile, open, lstat, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Request, Response } from 'express';
import type { Db } from '@dorkos/db';
import type { WriteFileRequest } from '@dorkos/shared/schemas';
import { sha256 } from '../../../../lib/file-route-guards.js';
import type { DocChannelStore } from '../store.js';
import type { CanonicalFileIdentity } from './canonical-writer.js';
import {
  InstallationFileWrites,
  requireInstallationFileWritesOwner,
  runInstallationFileSave,
  readInstallationFileSaveScope,
  requireInstallationFileSaveCurrent,
  checkInstallationFileSaveScope,
  checkInstallationFileSaveCleanup,
  markInstallationFileSaveReplaced,
} from './installation-file-writes.js';

export type NormalFileSaveOutcome =
  | {
      ok: true;
      hash: string;
      effect: 'changed' | 'no_op';
      documentReceipt?: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelEventReceipt;
    }
  | {
      error: 'File changed on disk since it was opened';
      code: 'CONFLICT';
      currentHash: string;
      currentContent: string;
    };

const services = new WeakMap<
  object,
  (req: Request, res: Response, input: WriteFileRequest) => Promise<NormalFileSaveOutcome>
>();
/** Refuse a swapped app.locals shape; only the actual constructed finite facade is accepted. */
export function requireNormalFileSaveService(value: unknown): NormalFileSaveService {
  if (!value || typeof value !== 'object' || !services.has(value))
    throw new Error('File saves are not available.');
  return value as NormalFileSaveService;
}
/** Route invocation uses captured native # execution, never a public saveHttp-shaped callback. */
export function saveRecognizedNormalFileService(
  value: unknown,
  req: Request,
  res: Response,
  input: WriteFileRequest
): Promise<NormalFileSaveOutcome> {
  const service = requireNormalFileSaveService(value);
  return services.get(service)!(req, res, input);
}

/** Original composition exposes only this finite save facade to the route. */
export class NormalFileSaveService {
  readonly #owner: InstallationFileWrites;
  readonly #db: Db;
  readonly #store: DocChannelStore;
  constructor(owner: InstallationFileWrites, db: Db, store: DocChannelStore) {
    requireInstallationFileWritesOwner(owner, db, store);
    this.#owner = owner;
    this.#db = db;
    this.#store = store;
    services.set(this, (req, res, input) => this.#save(req, res, input));
  }
  #save(req: Request, res: Response, input: WriteFileRequest): Promise<NormalFileSaveOutcome> {
    return runInstallationFileSave(this.#owner, this.#db, this.#store, req, res, input);
  }
  saveHttp(req: Request, res: Response, input: WriteFileRequest): Promise<NormalFileSaveOutcome> {
    return this.#save(req, res, input);
  }
}
function matches(info: { dev: bigint; ino: bigint }, expected: CanonicalFileIdentity): boolean {
  return String(info.dev) === expected.device && String(info.ino) === expected.inode;
}

/** Called only under an active constructor-private installation and canonical scope. */
export async function performNormalFileSave(scope: object): Promise<NormalFileSaveOutcome> {
  const { input, identity, lease, forceConflict } = readInstallationFileSaveScope(scope);
  await checkInstallationFileSaveScope(scope);
  requireInstallationFileSaveCurrent(scope);
  const current = await readFile(identity.canonicalPath, 'utf8');
  await checkInstallationFileSaveScope(scope);
  const currentHash = sha256(current);
  const expected =
    input.expectedHash ??
    (input.expectedContent === undefined ? undefined : sha256(input.expectedContent));
  if (forceConflict || (expected !== undefined && expected !== currentHash))
    return {
      error: 'File changed on disk since it was opened',
      code: 'CONFLICT',
      currentHash,
      currentContent: current,
    };
  const newHash = sha256(input.content);
  if (newHash === currentHash) return { ok: true, hash: currentHash, effect: 'no_op' };

  const temp = `${identity.canonicalPath}.${randomBytes(6).toString('hex')}.tmp`;
  let file: FileHandle | undefined;
  let ownedTemp: CanonicalFileIdentity | undefined;
  let renamed = false;
  let failed = false;
  let firstCause: unknown;
  const fail = (error: unknown) => {
    if (!failed) {
      failed = true;
      firstCause = error;
    }
  };
  // Join this scope to its captured cleanup before returning or reporting failure.
  const drainOriginalCleanup = async () => {
    if (file) {
      if (!ownedTemp) {
        try {
          const info = await file.stat({ bigint: true });
          ownedTemp = { canonicalPath: temp, device: String(info.dev), inode: String(info.ino) };
        } catch (error) {
          fail(error);
        }
      }
      try {
        await file.close();
      } catch (error) {
        fail(error);
      }
    }
    if (!renamed && ownedTemp) {
      try {
        await checkInstallationFileSaveCleanup(scope);
        const fresh = await lstat(temp, { bigint: true });
        if (!fresh.isFile() || fresh.isSymbolicLink() || !matches(fresh, ownedTemp))
          throw new Error('Temporary file cleanup ownership changed.');
        await unlink(temp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') fail(error);
      }
    }
  };
  try {
    await checkInstallationFileSaveScope(scope);
    requireInstallationFileSaveCurrent(scope);
    file = await open(temp, 'wx');
    readInstallationFileSaveScope(scope);
    const info = await file.stat({ bigint: true });
    ownedTemp = { canonicalPath: temp, device: String(info.dev), inode: String(info.ino) };
    const reserved = await lease.reserveReplacement(temp);
    if (!matches(info, reserved)) throw new Error('Temporary file identity changed.');
    ownedTemp = reserved;
    await checkInstallationFileSaveScope(scope);
    requireInstallationFileSaveCurrent(scope);
    await file.writeFile(input.content, 'utf8');
    readInstallationFileSaveScope(scope);
    await file.close();
    file = undefined;
    await checkInstallationFileSaveScope(scope);
    readInstallationFileSaveScope(scope);
    const fresh = await lstat(temp, { bigint: true });
    if (!fresh.isFile() || fresh.isSymbolicLink() || !matches(fresh, ownedTemp))
      throw new Error('Temporary file ownership changed.');
    requireInstallationFileSaveCurrent(scope);
    await rename(temp, identity.canonicalPath);
    renamed = true;
    markInstallationFileSaveReplaced(scope, ownedTemp);
    await checkInstallationFileSaveScope(scope);
    requireInstallationFileSaveCurrent(scope);
    const after = await readFile(identity.canonicalPath, 'utf8');
    await checkInstallationFileSaveScope(scope);
    if (sha256(after) !== newHash) throw new Error('File save readback changed.');
  } catch (error) {
    fail(error); // Capture exact first body cause, including undefined, before mandatory cleanup.
  } finally {
    await drainOriginalCleanup();
  }
  if (failed) throw firstCause;
  return { ok: true, hash: newHash, effect: 'changed' };
}

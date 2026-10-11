import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import type {
  CreateEntryRequestSchema,
  DeleteEntryQuerySchema,
  RenameEntryRequestSchema,
  CopyEntryRequestSchema,
} from '@dorkos/shared/schemas';
import type { OwnedMutation } from '../installation-mutations.js';
import { readOriginalHttpCopyFacet } from '../installation-http-file-writes.js';

export type Commands = {
  create: z.infer<typeof CreateEntryRequestSchema>;
  delete: z.infer<typeof DeleteEntryQuerySchema>;
  rename: z.infer<typeof RenameEntryRequestSchema>;
  copy: z.infer<typeof CopyEntryRequestSchema>;
};
export type HttpNamespaceResult = Readonly<{
  status: number;
  body: Readonly<Record<string, unknown>>;
}>;
export type Scope = {
  caller: object;
  owned: OwnedMutation;
  active: boolean;
  boundaries: Map<string, { cwd: string; target: string; resolved: string; validatedCwd: string }>;
};
export interface OriginalHttpCopyFacet {
  check(scope: Scope, cleanup?: boolean): Promise<void>;
  current(scope: Scope, cleanup?: boolean): void;
  pair(scope: Scope, input: Commands['copy']): Promise<{ cwd: string; from: string; to: string }>;
  read<T>(scope: Scope, work: () => Promise<T>): Promise<T>;
  missing(scope: Scope, target: string): Promise<boolean>;
  effect<T>(scope: Scope, work: () => Promise<T>): Promise<T>;
  ownedEffect<T>(
    scope: Scope,
    targets: readonly { path: string; identity: { dev: bigint; ino: bigint } }[],
    work: () => Promise<T>
  ): Promise<T>;
  outside(): void;
}
function result(status: number, error: string, code: string): HttpNamespaceResult {
  return { status, body: { error, code } };
}
function code(error: unknown): unknown {
  return error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
}

/** Clean up only the original acquired namespace resource after exact owner recognition. */
export async function cleanupOwned(
  owner: object,
  scope: Scope,
  target: string,
  identity: { dev: bigint; ino: bigint },
  recursive: boolean,
  children: readonly { path: string; identity: { dev: bigint; ino: bigint } }[] = []
): Promise<void> {
  const own = readOriginalHttpCopyFacet(owner);
  await own.check(scope, true);
  let actual;
  try {
    actual = await fs.lstat(target, { bigint: true });
  } catch (error) {
    if (code(error) === 'ENOENT') return;
    throw error;
  }
  own.current(scope, true);
  if (actual.dev !== identity.dev || actual.ino !== identity.ino)
    throw new Error('Owned cleanup path was replaced.');
  for (const child of children) {
    own.current(scope, true);
    const observed = await fs.lstat(child.path, { bigint: true });
    own.current(scope, true);
    if (observed.dev !== child.identity.dev || observed.ino !== child.identity.ino)
      throw new Error('Owned cleanup child was replaced.');
  }
  if (children.length) {
    // Child observations awaited; repeat the directory proof as the final native observation.
    const finalRoot = await fs.lstat(target, { bigint: true });
    own.current(scope, true);
    if (finalRoot.dev !== identity.dev || finalRoot.ino !== identity.ino)
      throw new Error('Owned cleanup root was replaced.');
  }
  own.current(scope, true);
  await fs.rm(target, { recursive, force: false });
  await own.check(scope, true);
}
/** Copy the original namespace entry under its existing admission and lifetime checks. */
export async function copyNamespaceEntry(
  owner: object,
  scope: Scope,
  input: Commands['copy']
): Promise<HttpNamespaceResult> {
  const own = readOriginalHttpCopyFacet(owner);
  const pair = await own.pair(scope, input);
  if (pair.from === pair.cwd || pair.to === pair.cwd)
    return result(400, 'Refusing to copy over the working-directory root', 'REFUSE_ROOT');
  const info = await own.read(scope, () => fs.stat(pair.from));
  if (!(await own.missing(scope, pair.to))) return result(409, 'Target already exists', 'CONFLICT');
  if (info.isDirectory() && (pair.to === pair.from || pair.to.startsWith(pair.from + path.sep)))
    return result(400, 'Refusing to copy a folder into itself', 'COPY_INTO_SELF');
  await own.effect(scope, () => fs.mkdir(path.dirname(pair.to), { recursive: true }));
  let staging: string | undefined;
  let stageIdentity: { dev: bigint; ino: bigint } | undefined;
  let destinationIdentity: { dev: bigint; ino: bigint } | undefined;
  let stagedIdentity: { dev: bigint; ino: bigint } | undefined;
  let failed = false;
  let cause: unknown;
  try {
    await own.check(scope);
    own.current(scope);
    staging = await fs.mkdtemp(`${pair.to}.copy-`);
    own.outside();
    scope.owned.assertActive();
    stageIdentity = await fs.lstat(staging, { bigint: true });
    await own.check(scope);
    const staged = path.join(staging, 'entry');
    await own.ownedEffect(scope, [{ path: staging, identity: stageIdentity }], async () => {
      await fs.cp(pair.from, staged, { recursive: true, errorOnExist: true, force: false });
      own.outside();
      scope.owned.assertActive();
      stagedIdentity = await fs.lstat(staged, { bigint: true });
    });
    await own.pair(scope, input);
    if (info.isDirectory()) {
      // Exclusive root reservation establishes ownership before any destination copying.
      await own.check(scope);
      own.current(scope);
      await fs.mkdir(pair.to);
      own.outside();
      scope.owned.assertActive();
      destinationIdentity = await fs.lstat(pair.to, { bigint: true });
      await own.check(scope);
      await own.ownedEffect(
        scope,
        [
          { path: staging, identity: stageIdentity },
          { path: staged, identity: stagedIdentity! },
          { path: pair.to, identity: destinationIdentity },
        ],
        () => fs.cp(staged, pair.to, { recursive: true, errorOnExist: true, force: false })
      );
    } else {
      await own.ownedEffect(
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
        await cleanupOwned(owner, scope, pair.to, destinationIdentity, true);
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    }
    try {
      if (staging && stageIdentity)
        await cleanupOwned(
          owner,
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

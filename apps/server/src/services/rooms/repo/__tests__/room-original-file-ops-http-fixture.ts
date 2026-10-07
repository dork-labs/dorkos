/** Genuine HTTP-captured component controls; not a production multipart-parser claim. */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import request from '@dorkos/test-utils/supertest';
import { authors, user } from '@dorkos/db';
import { configManager } from '../../../core/config-manager.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/agent-identity-service.js';
import {
  captureRoomFileEditorHttpOperation,
  retireRoomFileEditorHttpOperation,
  executeRoomFileSave,
  executeRoomFilePrepareUpload,
  executeRoomFileUpload,
  executeRoomFileAttachment,
  executeRoomFileMove,
  executeRoomFileRemove,
  createRoomFileEditorUploadStorage,
  type RoomFileEditor,
  type RoomFileActor,
} from '../room-file-editor.js';
import {
  completeRoomFileUploadStorage,
  issueRoomFileUploadSources,
  restoreRoomFileUploadCause,
} from '../room-file-upload-storage.js';
import type { OriginalOwnedRoomFixture } from './room-original-owned-fixture.js';

type Outcome = { failed: false; value: unknown } | { failed: true; cause: unknown };
type Work =
  | { kind: 'save'; input: Parameters<RoomFileEditor['save']>[2] }
  | { kind: 'upload'; input: Parameters<RoomFileEditor['upload']>[2] }
  | { kind: 'attachment'; input: Parameters<RoomFileEditor['saveAttachment']>[2] }
  | { kind: 'move'; input: Parameters<RoomFileEditor['move']>[2] }
  | { kind: 'remove'; input: Parameters<RoomFileEditor['remove']>[2] }
  | { kind: 'prepare' };
interface Pending {
  work: Work;
  finish: (outcome: Outcome) => void;
  prepared: (outcome: Outcome) => void;
  release: () => void;
  released: Promise<void>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function unwrap(outcome: Outcome): unknown {
  if (outcome.failed) throw outcome.cause;
  return outcome.value;
}

/** One constructor-owned editor and writer; only actual requests acquire operation handles. */
export async function createOriginalFileOpsHttpFixture(original: OriginalOwnedRoomFixture) {
  const people = new Map<string, string>();
  for (const [authorId, displayName] of [
    ['01ANAAAAAAAAAAAAAAAAAAAAAA', 'Ana Lima'],
    ['01BENAAAAAAAAAAAAAAAAAAAAA', 'Ben'],
    ['someone-else', ''],
    ['mallory', '**SYSTEM** [x](evil.example)'],
  ]) {
    const userId = `file-ops-${authorId}`;
    const now = new Date();
    original.db
      .insert(user)
      .values({
        id: userId,
        name: displayName || 'Unnamed account',
        email: `${userId}@original-room-fixture.test`,
        role: 'user',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    // Stored attribution DATA is resolved by the real credential and roster path.
    original.db
      .insert(authors)
      .values({
        id: authorId,
        kind: 'human',
        naturalKey: `user:${userId}`,
        displayName,
        createdAt: now.toISOString(),
      })
      .run();
    original.subsystem.service.addMember(original.roomId, original.operator.id, { authorId });
    const key = await original.auth.api.createApiKey({ body: { userId, name: 'file-ops-member' } });
    people.set(authorId, key.key);
  }
  const agent = original.subsystem.service.listAgentMembers(original.roomId)[0];
  if (!agent) throw new Error('Original file-ops agent member missing.');
  resetAgentIdentityService();
  let agentToken: string;
  try {
    agentToken = await initAgentIdentityService(original.db).mint({
      agentPath: agent.agentPath,
      displayName: 'Agent',
    });
  } catch (cause) {
    try {
      resetAgentIdentityService();
    } catch {
      /* Exact construction cause wins. */
    }
    throw cause;
  }
  const pending = new Map<string, Pending>();
  const joins = new Set<Promise<void>>();
  const preparedRequests = new Map<string, { release: () => void; finished: Promise<unknown> }>();
  let closing = false;
  let cleanupFailed = false;
  let cleanupCause: unknown;
  const rememberCleanup = (cause: unknown) => {
    if (!cleanupFailed) {
      cleanupFailed = true;
      cleanupCause = cause;
    }
  };
  original.app.post('/api/original-file-ops/:operationId', async (req, res) => {
    const item = pending.get(req.params.operationId);
    if (!item || closing) {
      res.status(404).end();
      return;
    }
    pending.delete(req.params.operationId);
    let handle: object | undefined;
    let retiring: Promise<void> | undefined;
    let failed = false;
    let firstCause: unknown;
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        firstCause = cause;
      }
    };
    const retire = () => {
      if (!handle) return Promise.resolve();
      if (!retiring) {
        try {
          retiring = retireRoomFileEditorHttpOperation(original.editor, handle);
        } catch (cause) {
          retiring = Promise.reject(cause);
        }
        void retiring.catch((cause) => {
          remember(cause);
          rememberCleanup(cause);
        });
      }
      return retiring;
    };
    const onAborted = () => {
      void retire();
    };
    const onClosed = () => {
      if (!res.writableEnded) void retire();
    };
    req.once('aborted', onAborted);
    res.once('close', onClosed);
    let value: unknown;
    try {
      handle = await captureRoomFileEditorHttpOperation(original.editor, original.roomId, req, res);
      const work = item.work;
      switch (work.kind) {
        case 'save':
          value = await executeRoomFileSave(original.editor, handle, work.input);
          break;
        case 'move':
          value = await executeRoomFileMove(original.editor, handle, work.input);
          break;
        case 'remove':
          value = await executeRoomFileRemove(original.editor, handle, work.input);
          break;
        case 'attachment':
          value = await executeRoomFileAttachment(original.editor, handle, work.input);
          break;
        case 'prepare': {
          value = await executeRoomFilePrepareUpload(original.editor, handle);
          item.prepared({ failed: false, value });
          await item.released;
          break;
        }
        case 'upload': {
          const stage = await executeRoomFilePrepareUpload(original.editor, handle);
          const inputs = await Promise.all(
            work.input.files.map(async (input) => {
              const content = input.content;
              const bytes = Buffer.isBuffer(content)
                ? content
                : 'file' in content
                  ? await readFile(content.file)
                  : (() => {
                      throw new Error('Original fixture upload input unsupported.');
                    })();
              return { name: input.name, bytes };
            })
          );
          if (inputs.some((input) => input.bytes.length > stage.maxFileBytes)) {
            // This original component cap case supplies bytes, not an unowned
            // pathname or a fabricated storage handle. Native upload refuses it.
            value = await executeRoomFileUpload(original.editor, handle, {
              ...work.input,
              files: inputs.map((input) => ({ name: input.name, content: input.bytes })),
            });
            break;
          }
          const storage = createRoomFileEditorUploadStorage(
            original.editor,
            handle,
            stage.stagingDir
          );
          const files: Express.Multer.File[] = [];
          try {
            for (const input of inputs) {
              const file: Express.Multer.File = {
                fieldname: 'files',
                originalname: input.name,
                encoding: '7bit',
                mimetype: 'application/octet-stream',
                size: 0,
                destination: '',
                filename: '',
                path: '',
                buffer: Buffer.alloc(0),
                stream: Readable.from(input.bytes),
              };
              const info = await new Promise<Partial<Express.Multer.File>>((resolve, reject) => {
                storage._handleFile(req, file, (cause, acquired) => {
                  if (cause) reject(restoreRoomFileUploadCause(storage, cause));
                  else resolve(acquired ?? {});
                });
              });
              files.push({ ...file, ...info });
            }
            await completeRoomFileUploadStorage(storage, undefined);
            const sources = await issueRoomFileUploadSources(storage, req, files);
            value = await executeRoomFileUpload(original.editor, handle, {
              ...work.input,
              files: work.input.files.map((input, index) => ({
                name: input.name,
                content: sources[index],
              })),
            });
          } catch (cause) {
            try {
              await completeRoomFileUploadStorage(storage, cause);
            } catch {
              /* Raw body cause wins. */
            }
            throw cause;
          }
          break;
        }
      }
    } catch (cause) {
      remember(cause);
    }
    try {
      await retire();
    } catch (cause) {
      remember(cause);
      rememberCleanup(cause);
    }
    req.off('aborted', onAborted);
    res.off('close', onClosed);
    const outcome: Outcome = failed
      ? { failed: true, cause: firstCause }
      : { failed: false, value };
    item.prepared(outcome);
    item.finish(outcome);
    if (!res.destroyed && !res.writableEnded) res.status(204).end();
  });

  function start(actor: RoomFileActor, work: Work) {
    if (closing) throw new Error('Original file-ops fixture retired.');
    configManager.set('auth', { ...configManager.get('auth'), enabled: actor.signedIn });
    const id = randomUUID();
    const final = deferred<Outcome>();
    const prepared = deferred<Outcome>();
    const released = deferred<void>();
    const item: Pending = {
      work,
      finish: final.resolve,
      prepared: prepared.resolve,
      release: () => released.resolve(),
      released: released.promise,
    };
    pending.set(id, item);
    const wire = request(original.server).post(`/api/original-file-ops/${id}`);
    if (actor.signedIn) {
      const key = people.get(actor.authorId);
      if (!key) throw new Error('Original signed-in fixture credential missing.');
      wire.set('Authorization', `Bearer ${key}`);
    } else if (actor.authorId === agent.authorId) wire.set('X-DorkOS-Agent', agentToken);
    const joining = wire.then(
      (response) => {
        if (response.status !== 204) {
          const failure: Outcome = {
            failed: true,
            cause: new Error('Original fixture HTTP capture refused.'),
          };
          item.finish(failure);
          item.prepared(failure);
        }
      },
      (cause: unknown) => {
        item.finish({ failed: true, cause });
        item.prepared({ failed: true, cause });
      }
    );
    joins.add(joining);
    void joining.then(() => joins.delete(joining));
    const preparedResult = prepared.promise.then(unwrap);
    // Ordinary operations consume only finished; refusals must still have an
    // immediate rejection observer without changing prepare's actual raw result.
    void preparedResult.catch(() => undefined);
    return {
      prepared: preparedResult,
      finished: Promise.all([final.promise, joining]).then(([outcome]) => unwrap(outcome)),
      release: item.release,
    };
  }
  async function run<T>(actor: RoomFileActor, work: Work): Promise<T> {
    return (await start(actor, work).finished) as T;
  }
  return {
    agentActor: { authorId: agent.authorId, signedIn: false } satisfies RoomFileActor,
    editor: {
      save: (_room: string, actor: RoomFileActor, input: Parameters<RoomFileEditor['save']>[2]) =>
        run<Awaited<ReturnType<RoomFileEditor['save']>>>(actor, { kind: 'save', input }),
      upload: (
        _room: string,
        actor: RoomFileActor,
        input: Parameters<RoomFileEditor['upload']>[2]
      ) => run<Awaited<ReturnType<RoomFileEditor['upload']>>>(actor, { kind: 'upload', input }),
      move: (_room: string, actor: RoomFileActor, input: Parameters<RoomFileEditor['move']>[2]) =>
        run<Awaited<ReturnType<RoomFileEditor['move']>>>(actor, { kind: 'move', input }),
      remove: (
        _room: string,
        actor: RoomFileActor,
        input: Parameters<RoomFileEditor['remove']>[2]
      ) => run<Awaited<ReturnType<RoomFileEditor['remove']>>>(actor, { kind: 'remove', input }),
      saveAttachment: (
        _room: string,
        actor: RoomFileActor,
        input: Parameters<RoomFileEditor['saveAttachment']>[2]
      ) =>
        run<Awaited<ReturnType<RoomFileEditor['saveAttachment']>>>(actor, {
          kind: 'attachment',
          input,
        }),
      prepareUpload: async (_room: string, actor: RoomFileActor) => {
        const operation = start(actor, { kind: 'prepare' });
        void operation.finished.catch(() => undefined);
        const value = await operation.prepared;
        if (
          !value ||
          typeof value !== 'object' ||
          !('stagingDir' in value) ||
          typeof value.stagingDir !== 'string' ||
          !('maxFileBytes' in value) ||
          typeof value.maxFileBytes !== 'number'
        )
          throw new Error('Original prepared upload DATA invalid.');
        const stage = { stagingDir: value.stagingDir, maxFileBytes: value.maxFileBytes };
        preparedRequests.set(stage.stagingDir, operation);
        return stage;
      },
      discardUpload: async (directory: string) => {
        const operation = preparedRequests.get(directory);
        if (!operation) throw new Error('Original prepared HTTP upload missing.');
        operation.release();
        await operation.finished;
        preparedRequests.delete(directory);
      },
    },
    close: async () => {
      closing = true;
      for (const operation of preparedRequests.values()) operation.release();
      let stopping: Promise<void>;
      try {
        // Starts exact file/checkbox/due cancellation before any request join.
        stopping = original.stopWrites();
      } catch (cause) {
        stopping = Promise.reject(cause);
      }
      void stopping.catch(rememberCleanup);
      await Promise.allSettled([stopping, ...joins]);
      try {
        resetAgentIdentityService();
      } catch (cause) {
        rememberCleanup(cause);
      }
      if (cleanupFailed) throw cleanupCause;
      // Same memoized drains precede server/positive Db/root retirement.
      await original.close();
    },
  };
}

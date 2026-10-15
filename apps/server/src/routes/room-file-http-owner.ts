/** Original owning request lifetimes shared by the Hono room-file handlers. */
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { originalDocHonoRequest } from '../http/original-doc-request.js';
import { retireDocHttpRoomRepoCaller } from '../services/canvas/doc-channel/http-composition.js';
import {
  captureRoomRepoHttpOperation,
  executeRoomRepoEnable,
  executeRoomRepoRepair,
  type EnableRoomRepoResult,
  type RoomMainRepair,
  type RoomMainRepairResult,
} from '../services/rooms/repo/room-repo-service.js';
import {
  captureRoomMergeHttpOperation,
  executeRoomHttpMerge,
  type RoomMergeResult,
} from '../services/rooms/repo/room-merge-service.js';
import {
  captureRoomFileEditorHttpOperation,
  retireRoomFileEditorHttpOperation,
} from '../services/rooms/repo/room-file-editor.js';
import {
  getRoomRepoService,
  getRoomMergeService,
  getRoomFileEditor,
} from '../services/rooms/index.js';

/**
 * Execute one repository operation through its original captured request lifetime.
 *
 * @param c - Hono context retaining the exact session admission and raw Node objects.
 * @param roomId - Room selected by the route, rechecked by the original owner.
 * @param operation - Fixed enable, repair, or merge operation.
 * @param input - Validated repair or merge input when the operation requires it.
 * @returns The result after the original retirement has completed.
 */
export function performRoomRepoHttpOperation(
  c: Context<ApiEnv>,
  roomId: string,
  operation: 'enable'
): Promise<EnableRoomRepoResult>;
export function performRoomRepoHttpOperation(
  c: Context<ApiEnv>,
  roomId: string,
  operation: 'repair',
  input: RoomMainRepair
): Promise<RoomMainRepairResult>;
export function performRoomRepoHttpOperation(
  c: Context<ApiEnv>,
  roomId: string,
  operation: 'merge',
  input: { summary: string; worktree?: string }
): Promise<RoomMergeResult>;
export async function performRoomRepoHttpOperation(
  c: Context<ApiEnv>,
  roomId: string,
  operation: 'enable' | 'repair' | 'merge',
  input?: RoomMainRepair | { summary: string; worktree?: string }
): Promise<EnableRoomRepoResult | RoomMainRepairResult | RoomMergeResult> {
  const { req, res } = originalDocHonoRequest(c);
  const repo = operation === 'merge' ? undefined : getRoomRepoService();
  const merge = operation === 'merge' ? getRoomMergeService() : undefined;
  const handle = merge
    ? await captureRoomMergeHttpOperation(merge, req, res, roomId)
    : await captureRoomRepoHttpOperation(repo!, req, res, roomId, operation as 'enable' | 'repair');
  let retirement: Promise<void> | undefined;
  const retire = (): Promise<void> => (retirement ??= retireDocHttpRoomRepoCaller(handle));
  const retireOnEnd = (): void => {
    void retire().catch(() => {
      /* finally awaits this same retirement */
    });
  };
  req.once('aborted', retireOnEnd);
  res.once('finish', retireOnEnd);
  res.once('close', retireOnEnd);
  // IncomingMessage.close is deliberately not used: parsed body completion is not disconnection.
  let failed = false,
    cause: unknown;
  let result: EnableRoomRepoResult | RoomMainRepairResult | RoomMergeResult | undefined;
  try {
    if (req.aborted || res.destroyed || res.writableEnded) await retire();
    if (operation === 'enable') result = await executeRoomRepoEnable(repo!, handle);
    else if (operation === 'repair')
      result = await executeRoomRepoRepair(repo!, handle, input as RoomMainRepair);
    else
      result = await executeRoomHttpMerge(
        merge!,
        handle,
        input as { summary: string; worktree?: string }
      );
  } catch (error) {
    failed = true;
    cause = error;
  } finally {
    req.off('aborted', retireOnEnd);
    res.off('finish', retireOnEnd);
    res.off('close', retireOnEnd);
    try {
      await retire();
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    }
  }
  if (failed) throw cause;
  return result!;
}

/**
 * Run a file operation under the original request handle and join its retirement.
 *
 * @param c - Hono context retaining the exact session admission and raw Node objects.
 * @param work - Operation using the original editor and its captured opaque handle.
 * @returns The operation result after cleanup; the first failure retains precedence.
 */
export async function withRoomFileHttpRequest<T>(
  c: Context<ApiEnv>,
  work: (editor: ReturnType<typeof getRoomFileEditor>, handle: object) => Promise<T>
): Promise<T> {
  const { req, res } = originalDocHonoRequest(c);
  const editor = getRoomFileEditor();
  const roomId = c.req.param('id');
  if (typeof roomId !== 'string') throw new Error('Original Room route ID is unavailable.');
  const handle = await captureRoomFileEditorHttpOperation(editor, roomId, req, res);
  let failed = false,
    cause: unknown,
    value!: T;
  try {
    value = await work(editor, handle);
  } catch (error) {
    failed = true;
    cause = error;
  }
  try {
    await retireRoomFileEditorHttpOperation(editor, handle);
  } catch (error) {
    if (!failed) {
      failed = true;
      cause = error;
    }
  }
  if (failed) throw cause;
  return value;
}

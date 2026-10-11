/**
 * The room-files slice of the mock Transport, spread into
 * `createMockTransport`: a room with no files of its own.
 *
 * @module test-utils/mock-room-files
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The room-files methods of the Transport port. */
type RoomFileMethods = Pick<
  Transport,
  | 'readRoomFiles'
  | 'readRoomFileContent'
  | 'readRoomRepoStatus'
  | 'saveRoomFile'
  | 'uploadRoomFiles'
  | 'moveRoomFile'
  | 'deleteRoomFile'
  | 'saveAttachmentToRoomFiles'
  | 'repairRoomMain'
  | 'mergeRoomMain'
  | 'readRoomCanvasDiff'
  | 'writeRoomCanvasDiff'
>;

/**
 * The refusal a room with no files of its own answers with, shaped the way the
 * HTTP adapter shapes it: an `Error` carrying `code` and `status`, which is
 * what every client reads to tell one refusal from another.
 */
function mockRoomHasNoRepoError(): Error & { code: string; status: number } {
  return Object.assign(new Error('This room does not have files of its own.'), {
    code: 'ROOM_HAS_NO_REPO',
    status: 409,
  });
}

/**
 * Mock room-files methods for a room with no files of its own, which is what
 * nearly every room is: the surfaces that offer files read this code and show
 * nothing at all. A test about a room's files overrides them; a test about
 * anything else must not have to know rooms can have files.
 */
export function roomFileTransportMocks(): RoomFileMethods {
  return {
    readRoomFiles: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    readRoomFileContent: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    readRoomRepoStatus: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    saveRoomFile: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    uploadRoomFiles: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    moveRoomFile: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    deleteRoomFile: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    saveAttachmentToRoomFiles: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    repairRoomMain: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    mergeRoomMain: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    readRoomCanvasDiff: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
    writeRoomCanvasDiff: vi.fn().mockRejectedValue(mockRoomHasNoRepoError()),
  };
}

import { types as utilTypes } from 'node:util';
import type { roomRepos } from '@dorkos/db';
import type { RoomRepoSidecar } from '@dorkos/shared/room-repo';

/**
 * The file inside a room's home directory that records its repo.
 *
 * A constant rather than an inline string because the reconciler's directory
 * walk and the store's path builder must name the same file, and a typo in
 * either would look like "no room on this install has a repo".
 */
export const ROOM_REPO_SIDECAR_FILENAME = 'room-repo.json';
/** New internal persistence refusal ceiling; oversize historical files stay untouched. */
export const ROOM_REPO_SIDECAR_MAX_BYTES = 64 * 1024;
function requireBoundedRoomRepoScalars(sidecar: RoomRepoSidecar): void {
  // Bound each variable scalar before stringify; the byte check also covers UTF8/JSON escaping.
  for (const value of [sidecar.roomId, sidecar.createdAt, sidecar.createdBy]) {
    if (typeof value !== 'string' || value.length > ROOM_REPO_SIDECAR_MAX_BYTES)
      throw new Error('Room sidecar exceeds its persistence ceiling.');
  }
}
/** Capture only original plain sidecar metadata before any persistence operation. */
export function captureRoomRepoPersistenceMetadata(input: RoomRepoSidecar): RoomRepoSidecar {
  const capture = (value: object, allowed: readonly string[]): Record<string, unknown> => {
    if (
      utilTypes.isProxy(value) ||
      !value ||
      typeof value !== 'object' ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    )
      throw new Error('Room sidecar persistence requires plain metadata.');
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key))
        throw new Error('Room sidecar contains unsupported persistence fields.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        throw new Error('Room sidecar persistence requires plain data fields.');
      result[key] = descriptor.value;
    }
    return result;
  };
  const result = capture(input, [
    'roomId',
    'mode',
    'createdAt',
    'createdBy',
    'defaultBranch',
    'caps',
    'lastMergeSeq',
  ]);
  if (result.caps !== undefined)
    result.caps = Object.freeze(
      capture(result.caps as object, ['maxFileBytes', 'maxRepoBytes', 'maxRoomMdBytes'])
    );
  const sidecar = Object.freeze(result) as unknown as RoomRepoSidecar;
  requireBoundedRoomRepoScalars(sidecar);
  return sidecar;
}
/** Serialize the original finite sidecar shape without granting filesystem mutation authority. */
export function serializeBoundedRoomRepoSidecar(sidecar: RoomRepoSidecar): Buffer {
  requireBoundedRoomRepoScalars(sidecar);
  if (
    (Object.getPrototypeOf(sidecar) !== Object.prototype &&
      Object.getPrototypeOf(sidecar) !== null) ||
    Object.prototype.hasOwnProperty.call(sidecar, 'toJSON')
  )
    throw new Error('Room sidecar persistence requires plain metadata.');
  // Legacy public fixture input must also have a finite known shape; refuse extra data rather than discard it.
  for (const key in sidecar) {
    if (
      !Object.prototype.hasOwnProperty.call(sidecar, key) ||
      ![
        'roomId',
        'mode',
        'createdAt',
        'createdBy',
        'defaultBranch',
        'caps',
        'lastMergeSeq',
      ].includes(key)
    )
      throw new Error('Room sidecar contains unsupported persistence fields.');
  }
  if (sidecar.mode !== 'owned' || sidecar.defaultBranch !== 'main')
    throw new Error('Unsupported Room sidecar binding.');
  if (sidecar.caps !== undefined) {
    if (
      sidecar.caps === null ||
      typeof sidecar.caps !== 'object' ||
      (Object.getPrototypeOf(sidecar.caps) !== Object.prototype &&
        Object.getPrototypeOf(sidecar.caps) !== null) ||
      Object.prototype.hasOwnProperty.call(sidecar.caps, 'toJSON')
    )
      throw new Error('Room sidecar cap persistence requires plain metadata.');
    for (const key in sidecar.caps) {
      if (
        !Object.prototype.hasOwnProperty.call(sidecar.caps, key) ||
        !['maxFileBytes', 'maxRepoBytes', 'maxRoomMdBytes'].includes(key)
      )
        throw new Error('Room sidecar contains unsupported cap fields.');
    }
    for (const value of [
      sidecar.caps.maxFileBytes,
      sidecar.caps.maxRepoBytes,
      sidecar.caps.maxRoomMdBytes,
    ]) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)))
        throw new Error('Invalid Room sidecar numeric cap.');
    }
  }
  if (
    sidecar.lastMergeSeq !== null &&
    (typeof sidecar.lastMergeSeq !== 'number' || !Number.isFinite(sidecar.lastMergeSeq))
  )
    throw new Error('Invalid Room sidecar merge sequence.');
  const bytes = Buffer.from(JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
  if (bytes.byteLength > ROOM_REPO_SIDECAR_MAX_BYTES)
    throw new Error('Room sidecar exceeds its persistence ceiling.');
  return bytes;
}

/**
 * The characters a room id may be made of before it reaches the filesystem.
 *
 * The same allowlist `LocalRoomAttachmentStore` applies to the same segment of
 * the same path, and an allowlist for the same reason: a room id arrives here
 * from a URL path segment, and the only safe way to know a string is not a path
 * is that it cannot contain one.
 */
export const SAFE_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when a room id could be read as a path. */
export class InvalidRoomIdError extends Error {
  constructor(roomId: string) {
    super(`Invalid room id: ${roomId}`);
    this.name = 'InvalidRoomIdError';
  }
}

/** Map a sidecar onto its derived cache row. */
export function toRow(sidecar: RoomRepoSidecar): typeof roomRepos.$inferInsert {
  return {
    roomId: sidecar.roomId,
    mode: sidecar.mode,
    createdAt: sidecar.createdAt,
    lastMergeSeq: sidecar.lastMergeSeq,
  };
}

/** Validate one native cache row without issuing Room mutation authority. */
export function captureRoomRepoCacheRow(
  row: typeof roomRepos.$inferSelect | undefined,
  roomId: string
): typeof roomRepos.$inferSelect | null {
  if (row === undefined) return null;
  if (
    row.roomId !== roomId ||
    typeof row.mode !== 'string' ||
    typeof row.createdAt !== 'string' ||
    (row.lastMergeSeq !== null && (!Number.isSafeInteger(row.lastMergeSeq) || row.lastMergeSeq < 0))
  )
    throw new Error('Room repository cache row is invalid.');
  return row;
}

/** Validate and freeze one native inventory row; caller retains original database custody. */
export function captureRoomRepoInventoryRow(
  row: typeof roomRepos.$inferSelect
): Readonly<typeof roomRepos.$inferSelect> {
  if (
    typeof row.roomId !== 'string' ||
    !SAFE_ROOM_ID.test(row.roomId) ||
    row.mode !== 'owned' ||
    typeof row.createdAt !== 'string' ||
    (row.lastMergeSeq !== null && (!Number.isSafeInteger(row.lastMergeSeq) || row.lastMergeSeq < 0))
  )
    throw new Error('Invalid native Room repo inventory row.');
  return Object.freeze({ ...row });
}

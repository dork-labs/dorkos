import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './schema/index.js';
import type { RoomSpendNativeOperation } from './room-spend-native.js';
import type { RoomDocNativeFrameState as RoomFrame } from './room-doc-data.js';
import type { RoomDocNativeOperation } from './room-doc-statements.js';
import type { RelayDocNativeOperation } from './relay-doc-statements.js';

export type NativeCall = (...args: unknown[]) => unknown;
export type NativeEngine = {
  prepare(sql: string, self: Database.Database, pragma: boolean): Database.Statement;
};
export type Execution = { statement: Database.Statement; method: NativeCall; traces: number };
/** Named internal Db shape preserves the exact schema and original native client type. */
export type OriginalProtectedRoomDb = BetterSQLite3Database<typeof schema> & {
  $client: Database.Database;
};
/** Original constructor-owned ticket; its named return does not mint or expose new custody. */
export interface ProtectedRoomNativeDatabase {
  readonly sqlite: Database.Database;
  readonly generation: number;
  readonly unknown: boolean;
  readonly open: boolean;
  readonly inTransaction: boolean;
  readonly roomEpoch: string;
  invalidate(): void;
  execute(operation: RoomSpendNativeOperation, args?: readonly unknown[]): unknown;
  executeDoc(operation: RoomDocNativeOperation, args?: Readonly<Record<string, unknown>>): unknown;
  readRoomLimitData(roomId: string): Readonly<{
    turnLimitsEnabled: boolean | null;
    maxAgentDepth: number | null;
    maxTurnsPerAgentPerCascade: number | null;
    maxAutoTurnsPerHour: number | null;
  }> | null;
  requireOriginalPublicQueryCustody(): void;
  beginRelayFrame(): Readonly<object>;
  requireRelayFrame(identity: object): RoomFrame & { family: 'room' | 'relay' };
  executeRelayFrame(
    identity: object,
    operation: Exclude<RelayDocNativeOperation, 'begin' | 'commit' | 'rollback'>,
    args?: Readonly<Record<string, unknown>>
  ): unknown;
  commitRelayFrame(identity: object): void;
  rollbackRelayFrame(identity: object): boolean;
  committedRelayFrame(identity: object): boolean;
  withRelayFrameQueries<T>(identity: object, work: (queryDb: object) => T): T;
  requireRelayFramesClosed(): void;
  beginRoomFrame(): Readonly<object>;
  withRoomFrameQueries<T>(identity: object, work: (queryDb: object) => T): T;
  requireRoomFrame(identity: object): RoomFrame & { family: 'room' | 'relay' };
  commitRoomFrame(identity: object): void;
  rollbackRoomFrame(identity: object): boolean;
  committedRoomFrame(identity: object): boolean;
  close(): void;
  wrap(): OriginalProtectedRoomDb;
}

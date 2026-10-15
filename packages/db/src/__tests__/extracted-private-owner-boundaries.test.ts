/** New module seams must never promote public native objects or structural contexts into private ownership. */
import { describe, expect, it, vi } from 'vitest';
import {
  openProtectedRoomNativeDatabase,
  requireOriginalCustodyOwner,
  requireOriginalProxyOwner,
  requireOriginalQueryCustodyOwner,
  requireOriginalFrameQueryOwner,
} from '../room-spend-native.js';
import { requireRelayNativeOperationOwner } from '../relay-doc-native.js';
import { requireRoomDocLifecycleOwner } from '../room-doc-lifecycle.js';
import { requirePublishedMigrationOwner } from '../doc-migration-history.js';
import { captureOriginalPublicCustody } from '../room-spend-native-custody.js';
import { createOriginalPublicProxy } from '../room-spend-native-public-proxy.js';
import { captureOriginalQueryCustody } from '../room-spend-native-query-custody.js';
import { createRoomDocEmissionLifecycle } from '../room-doc-emission-lifecycle.js';
import { createRoomDocUndoLifecycle } from '../room-doc-undo-lifecycle.js';
import { createRoomDocSourceLifecycle } from '../room-doc-source-lifecycle.js';
import { bridgePublishedRoomMigration } from '../doc-migration-published-room.js';
import {
  sourceStrings,
  sourceNumbers,
  sourceNullable,
  claimStrings,
  claimNumbers,
} from '../room-doc-lifecycle-data.js';

const privateReaders: readonly [string, (key: object) => unknown][] = [
  ['public custody', requireOriginalCustodyOwner],
  ['public proxy', requireOriginalProxyOwner],
  ['query custody', requireOriginalQueryCustodyOwner],
  ['frame query', requireOriginalFrameQueryOwner],
  ['Relay operation', requireRelayNativeOperationOwner],
  ['Room lifecycle', requireRoomDocLifecycleOwner],
  ['migration invocation', requirePublishedMigrationOwner],
  ['capture public custody', captureOriginalPublicCustody],
  ['create public proxy', createOriginalPublicProxy],
  ['capture query custody', captureOriginalQueryCustody],
  ['emission lifecycle', createRoomDocEmissionLifecycle],
  ['undo lifecycle', createRoomDocUndoLifecycle],
  ['source lifecycle', createRoomDocSourceLifecycle],
  ['published migration', bridgePublishedRoomMigration],
];

describe('extracted private native owner boundaries', () => {
  it.each(privateReaders)(
    'refuses a supplied context before reading any %s fields',
    (_name, read) => {
      const work = vi.fn(() => {
        throw new Error('Caller work must not execute');
      });
      const context = {
        native: { execute: work },
        run: work,
        db: { transaction: work },
        rows: [],
        folder: 'unused',
      };
      const inspect = vi.fn(() => {
        throw new Error('Structural inspection must not execute');
      });
      const wrapped = new Proxy(context, {
        get: inspect,
        ownKeys: inspect,
        getPrototypeOf: inspect,
      });
      expect(() => read(context)).toThrow(/owner required/);
      expect(() => read(wrapped)).toThrow(/owner required/);
      expect(work).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
    }
  );

  it('refuses genuine public native tickets, SQLite clients and Db facades as private keys', () => {
    const native = openProtectedRoomNativeDatabase(':memory:');
    try {
      const db = native.wrap();
      for (const [, read] of privateReaders) {
        for (const publicObject of [native, native.sqlite, db, new Proxy(native, {})]) {
          expect(() => read(publicObject)).toThrow(/owner required/);
        }
      }
      expect(native.open).toBe(true);
    } finally {
      native.close();
    }
  });

  it('keeps relocated scalar validation policy immutable at runtime', () => {
    for (const tuple of [
      sourceStrings,
      sourceNumbers,
      sourceNullable,
      claimStrings,
      claimNumbers,
    ]) {
      expect(Object.isFrozen(tuple)).toBe(true);
      expect(Reflect.set(tuple, '0', tuple[0])).toBe(false);
    }
  });
});

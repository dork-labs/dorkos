import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql, getTableColumns } from 'drizzle-orm';
import * as schema from './schema/index.js';

import { requireOriginalQueryCustodyOwner } from './room-spend-native.js';

/** Capture query class, codecs and metadata before any original frame facade is exposed. */
export function captureOriginalQueryCustody(ownerKey: object) {
  const publicSelf = requireOriginalQueryCustodyOwner(ownerKey);
  // Capture the actual query-class method descriptors before any public Drizzle wrapper exists.
  // Building these queries does not execute SQL or depend on migrated canvas tables.
  const originalQueryMethods = new Map<object, Map<PropertyKey, PropertyDescriptor>>();
  const originalQueryParents = new Map<object, object | null>();
  const captureQueryMethods = (value: object) => {
    let prototype = Object.getPrototypeOf(value);
    while (prototype && prototype !== Object.prototype) {
      if (!originalQueryMethods.has(prototype)) {
        const slots = new Map<PropertyKey, PropertyDescriptor>();
        for (const key of Reflect.ownKeys(prototype))
          slots.set(key, Object.getOwnPropertyDescriptor(prototype, key)!);
        originalQueryMethods.set(prototype, slots);
        originalQueryParents.set(prototype, Object.getPrototypeOf(prototype));
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  };
  const originalQueryDb = drizzle(publicSelf, { schema });
  const scalar = sql`1`;
  const selectBuilder = originalQueryDb.select({ value: scalar });
  const selectQuery = selectBuilder.from(sql`(select 1)`);
  const selectPrepared = selectQuery.prepare();
  const updateBuilder = originalQueryDb.update(schema.canvasDocChannels);
  const updateQuery = updateBuilder.set({ nextDocSeq: 0 });
  const insertBuilder = originalQueryDb.insert(schema.canvasDocEvents);
  const insertQuery = insertBuilder.values({
    documentId: '',
  } as typeof schema.canvasDocEvents.$inferInsert);
  for (const value of [
    originalQueryDb,
    scalar,
    selectBuilder,
    selectQuery,
    selectPrepared,
    updateBuilder,
    updateQuery,
    insertBuilder,
    insertQuery,
  ])
    captureQueryMethods(value);
  // Session and dialect participate in statement preparation and result decoding.
  for (const object of [originalQueryDb, selectPrepared]) {
    for (const key of ['session', 'dialect', '_']) {
      const slot = Object.getOwnPropertyDescriptor(object, key);
      if (slot && 'value' in slot && slot.value && typeof slot.value === 'object') {
        captureQueryMethods(slot.value);
        const session = Object.getOwnPropertyDescriptor(slot.value, 'session');
        if (session && 'value' in session && session.value) captureQueryMethods(session.value);
      }
    }
  }
  const originalCodecSlots = new Map<object, Map<PropertyKey, PropertyDescriptor | undefined>>();
  const originalCodecParents = new Map<object, object | null>();
  const captureCodec = (codec: object) => {
    captureQueryMethods(codec);
    const slots = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const key of ['mapFromDriverValue', 'mapToDriverValue'])
      slots.set(key, Object.getOwnPropertyDescriptor(codec, key));
    originalCodecSlots.set(codec, slots);
    originalCodecParents.set(codec, Object.getPrototypeOf(codec));
  };
  // These exact fields decode every finite original sender store read and encode its writes.
  for (const table of [
    schema.canvasDocChannels,
    schema.canvasDocEvents,
    schema.canvasDocDeliveries,
    schema.canvasDocBatches,
  ]) {
    for (const column of Object.values(getTableColumns(table))) captureCodec(column);
  }
  const scalarDecoder = Object.getOwnPropertyDescriptor(scalar, 'decoder');
  if (!scalarDecoder || !('value' in scalarDecoder) || !scalarDecoder.value)
    throw new Error('Original scalar decoder unavailable');
  captureCodec(scalarDecoder.value);
  // The four queried table graphs are module-owned SQL metadata. Retain exact
  // data descriptors too: a replaced column map/name can suppress or redirect
  // reads without changing a query method or its decoder identity.
  const originalMetadata = new Map<object, Map<PropertyKey, PropertyDescriptor>>();
  const originalMetadataParents = new Map<object, object | null>();
  const captureMetadata = (value: object) => {
    if (originalMetadata.has(value)) return;
    if (originalMetadata.size >= 4096) throw new Error('Original Room metadata frontier');
    const keys = Reflect.ownKeys(value);
    if (keys.length > 4096) throw new Error('Original Room metadata slot frontier');
    const slots = new Map<PropertyKey, PropertyDescriptor>();
    originalMetadata.set(value, slots);
    originalMetadataParents.set(value, Object.getPrototypeOf(value));
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      slots.set(key, descriptor);
      // Do not invoke getters or traverse function closures/prototypes.
      if ('value' in descriptor && descriptor.value && typeof descriptor.value === 'object')
        captureMetadata(descriptor.value);
    }
  };
  for (const table of [
    schema.canvasDocChannels,
    schema.canvasDocEvents,
    schema.canvasDocDeliveries,
    schema.canvasDocBatches,
  ])
    captureMetadata(table);
  function requireOriginalQueryMethods() {
    for (const [metadata, slots] of originalMetadata) {
      if (
        Object.getPrototypeOf(metadata) !== originalMetadataParents.get(metadata) ||
        Reflect.ownKeys(metadata).length !== slots.size
      )
        throw new Error('Original Room SQL metadata changed');
      for (const [key, before] of slots) {
        const current = Object.getOwnPropertyDescriptor(metadata, key);
        if (
          !current ||
          current.value !== before.value ||
          current.get !== before.get ||
          current.set !== before.set ||
          current.writable !== before.writable ||
          current.configurable !== before.configurable ||
          current.enumerable !== before.enumerable
        )
          throw new Error('Original Room SQL metadata descriptor changed');
      }
    }
    for (const [codec, slots] of originalCodecSlots) {
      if (Object.getPrototypeOf(codec) !== originalCodecParents.get(codec))
        throw new Error('Original Room field codec ancestry changed');
      for (const [key, before] of slots) {
        const current = Object.getOwnPropertyDescriptor(codec, key);
        if (!before && !current) continue;
        if (
          !before ||
          !current ||
          current.value !== before.value ||
          current.get !== before.get ||
          current.set !== before.set ||
          current.writable !== before.writable ||
          current.configurable !== before.configurable ||
          current.enumerable !== before.enumerable
        )
          throw new Error('Original Room field codec changed');
      }
    }
    for (const [prototype, slots] of originalQueryMethods) {
      if (Object.getPrototypeOf(prototype) !== originalQueryParents.get(prototype))
        throw new Error('Original Room query class ancestry changed');
      const keys = Reflect.ownKeys(prototype);
      if (keys.length !== slots.size) throw new Error('Original Room query class changed');
      for (const [key, before] of slots) {
        const current = Object.getOwnPropertyDescriptor(prototype, key);
        if (
          !current ||
          current.value !== before.value ||
          current.get !== before.get ||
          current.set !== before.set ||
          current.writable !== before.writable ||
          current.configurable !== before.configurable ||
          current.enumerable !== before.enumerable
        )
          throw new Error('Original Room query method changed');
      }
    }
  }
  return requireOriginalQueryMethods;
}

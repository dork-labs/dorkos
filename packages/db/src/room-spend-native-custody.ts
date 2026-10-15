import type Database from 'better-sqlite3';
import type { NativeEngine } from './room-spend-native-types.js';

type OriginalIntrinsics = {
  nativeOwnDescriptor: typeof Object.getOwnPropertyDescriptor;
  nativeOwnKeys: typeof Reflect.ownKeys;
  nativePrototypeOf: typeof Object.getPrototypeOf;
  nativeMapGet: typeof Map.prototype.get;
  nativeApply: typeof Reflect.apply;
  eachNativeMap: <K, V>(map: Map<K, V>, visit: (key: K, value: V) => void) => void;
  sameNativeDescriptor: (
    before: PropertyDescriptor | undefined,
    current: PropertyDescriptor | undefined,
    nativeTransactionStatus?: boolean
  ) => boolean;
};
import { requireOriginalCustodyOwner } from './room-spend-native.js';
export interface OriginalPublicCustodyContext {
  raw: Database.Database;
  engine: NativeEngine;
  ordinaryMethods: ReadonlySet<string>;
  opaqueMethods: ReadonlySet<string>;
  nativeGetters: ReadonlySet<string>;
  isUnknown: () => boolean;
  intrinsics: OriginalIntrinsics;
}
/** Capture original native ancestry before public exposure; caller retains sticky taint state. */
export function captureOriginalPublicCustody(ownerKey: object) {
  const { raw, engine, ordinaryMethods, opaqueMethods, nativeGetters, isUnknown, intrinsics } =
    requireOriginalCustodyOwner(ownerKey);
  const {
    nativeOwnDescriptor,
    nativeOwnKeys,
    nativePrototypeOf,
    nativeMapGet,
    nativeApply,
    eachNativeMap,
    sameNativeDescriptor,
  } = intrinsics;
  // Capture native public method slots before wrapping/public exposure. A lazy
  // original child cannot accept a replacement as its constructor baseline.
  const publicMethodOwnSlots = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const key of [...ordinaryMethods, ...opaqueMethods, ...nativeGetters])
    publicMethodOwnSlots.set(key, Object.getOwnPropertyDescriptor(raw, key));
  const nativeCustodyDescriptors = new Map<object, Map<PropertyKey, PropertyDescriptor>>();
  const nativeCustodyParents = new Map<object, object | null>();
  const nativeCustodyRoots = new Map<
    object,
    { parent: object | null; slots: Map<PropertyKey, PropertyDescriptor | undefined> }
  >();
  const captureNativeCustody = (value: object) => {
    const parent = nativePrototypeOf(value);
    const slots = new Map<PropertyKey, PropertyDescriptor | undefined>();
    for (const key of ['prepare', 'open', 'inTransaction', 'run', 'get', 'all', 'raw'])
      slots.set(key, nativeOwnDescriptor(value, key));
    nativeCustodyRoots.set(value, { parent, slots });
    let prototype = parent;
    while (prototype && prototype !== Object.prototype) {
      if (!nativeCustodyDescriptors.has(prototype)) {
        nativeCustodyDescriptors.set(
          prototype,
          new Map(
            Reflect.ownKeys(prototype).map((key) => [
              key,
              Object.getOwnPropertyDescriptor(prototype, key)!,
            ])
          )
        );
        nativeCustodyParents.set(prototype, Object.getPrototypeOf(prototype));
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  };
  captureNativeCustody(raw);
  captureNativeCustody(engine);
  function requireOriginalPublicQueryCustody() {
    if (isUnknown()) throw new Error('Original native database custody unavailable');
    eachNativeMap(nativeCustodyRoots, (root, before) => {
      if (nativePrototypeOf(root) !== before.parent)
        throw new Error('Original native database handle ancestry changed');
      eachNativeMap(before.slots, (key, descriptor) => {
        // BetterSQLite's private cpp handle exposes inTransaction as a V8
        // native data property: its boolean value changes on real BEGIN/END.
        // Only that exact private status value may change; descriptor shape,
        // raw JS getters, method identities and sticky public tamper refusal stay fixed.
        if (
          !sameNativeDescriptor(
            descriptor,
            nativeOwnDescriptor(root, key),
            root === engine && key === 'inTransaction'
          )
        )
          throw new Error('Original native database handle slot changed');
      });
    });
    eachNativeMap(publicMethodOwnSlots, (key, before) => {
      if (!sameNativeDescriptor(before, nativeOwnDescriptor(raw, key)))
        throw new Error('Original native database method shadowed');
    });
    eachNativeMap(nativeCustodyDescriptors, (prototype, slots) => {
      if (
        nativePrototypeOf(prototype) !==
          nativeApply(nativeMapGet, nativeCustodyParents, [prototype]) ||
        nativeOwnKeys(prototype).length !== slots.size
      )
        throw new Error('Original native database method ancestry changed');
      eachNativeMap(slots, (key, before) => {
        if (!sameNativeDescriptor(before, nativeOwnDescriptor(prototype, key)))
          throw new Error('Original native database class changed');
      });
    });
    if (!raw.open) throw new Error('Original native database custody unavailable');
  }
  return { captureNativeCustody, requireOriginalPublicQueryCustody };
}

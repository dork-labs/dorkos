export const nativeOwnDescriptor = Object.getOwnPropertyDescriptor;
export const nativeOwnKeys = Reflect.ownKeys;
export const nativePrototypeOf = Object.getPrototypeOf;
const nativeMapEntries = Map.prototype.entries;
export const nativeMapGet = Map.prototype.get;
const nativeMapNext = nativePrototypeOf(new Map().entries()).next;
export const nativeApply = Reflect.apply;
/** Visit native Map entries through captured iteration intrinsics. */
export function eachNativeMap<K, V>(map: Map<K, V>, visit: (key: K, value: V) => void): void {
  const iterator = nativeApply(nativeMapEntries, map, []);
  for (;;) {
    const step = nativeApply(nativeMapNext, iterator, []) as IteratorResult<[K, V]>;
    if (step.done) return;
    visit(step.value[0], step.value[1]);
  }
}
/** Compare descriptor identities and flags, allowing only the native transaction-status value exception. */
export function sameNativeDescriptor(
  before: PropertyDescriptor | undefined,
  current: PropertyDescriptor | undefined,
  nativeTransactionStatus = false
): boolean {
  if (!before || !current) return before === current;
  if (
    nativeTransactionStatus &&
    (typeof nativeOwnDescriptor(before, 'value')?.value !== 'boolean' ||
      typeof nativeOwnDescriptor(current, 'value')?.value !== 'boolean')
  )
    return false;
  const fields = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'];
  for (let index = 0; index < fields.length; index++) {
    const key = fields[index]!;
    if (nativeTransactionStatus && key === 'value') continue;
    if (nativeOwnDescriptor(before, key)?.value !== nativeOwnDescriptor(current, key)?.value)
      return false;
  }
  return true;
}

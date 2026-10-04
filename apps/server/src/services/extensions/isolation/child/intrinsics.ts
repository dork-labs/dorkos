/**
 * Built-in functions captured when the child's bootstrap is evaluated, before
 * any extension code runs (DOR-2686, spec §4).
 *
 * The network guard keeps deciding long after the extension has started, and
 * the extension shares this realm: it can replace `String.prototype.endsWith`,
 * `Array.prototype.some` or `Map.prototype.get` with a function that always
 * says yes. So every decision the guard makes at run time goes through these
 * captured references, called with `Reflect.apply`, and never through a method
 * looked up on a prototype the extension can reach.
 *
 * Rules for code on the guard's run-time path:
 *
 * - call string, map and number methods only through the uncurried forms here;
 * - never iterate with `for…of`, spread, or destructuring of arrays (they look
 *   up `Array.prototype[Symbol.iterator]`); index loops over arrays the guard
 *   built itself are safe;
 * - never assign to an index of a fresh array (a setter on `Array.prototype`
 *   would swallow it); use typed arrays or `defineOwn`;
 * - check `typeof` before trusting any value that came from the extension.
 *
 * @module services/extensions/isolation/child/intrinsics
 */

const ReflectApply = Reflect.apply;

/**
 * Turn a method into a plain function taking `this` first, bound to the
 * built-in captured now.
 *
 * @param fn - A built-in method.
 */
function uncurry<This, Args extends unknown[], R>(
  fn: (this: This, ...args: Args) => R
): (self: This, ...args: Args) => R {
  // Rest parameters are built from the arguments directly, never through the
  // array iterator, and Reflect.apply reads the list by index.
  return (self, ...args) => ReflectApply(fn, self, args);
}

/** `Reflect.apply`, as it was when the bootstrap started. */
export const apply = ReflectApply;
/** `Object.defineProperty`, as it was when the bootstrap started. */
export const defineProperty = Object.defineProperty;
/** `Object.getPrototypeOf`, as it was when the bootstrap started. */
export const getPrototypeOf = Object.getPrototypeOf;
/** `Object.getOwnPropertyDescriptor`, as it was when the bootstrap started. */
export const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
/** `Object.create`, as it was when the bootstrap started. */
export const createObject = Object.create;
/** `Object.freeze`, as it was when the bootstrap started. */
export const freeze = Object.freeze;
/** `Array.isArray`, as it was when the bootstrap started. */
export const isArray = Array.isArray;
/** `Number.isSafeInteger`, as it was when the bootstrap started. */
export const isSafeInteger = Number.isSafeInteger;
/** `Date.now`, as it was when the bootstrap started. */
export const now = Date.now;
/** The `Error` constructor, as it was when the bootstrap started. */
export const ErrorCtor = Error;
/** The `Map` constructor, as it was when the bootstrap started. */
export const MapCtor = Map;

/** `String.prototype.charCodeAt`, uncurried. */
export const charCodeAt = uncurry(String.prototype.charCodeAt);
/** `String.prototype.slice`, uncurried. */
export const slice = uncurry(String.prototype.slice);
/** `String.prototype.toLowerCase`, uncurried. */
export const toLowerCase = uncurry(String.prototype.toLowerCase);
/** `Map.prototype.get`, uncurried. */
export const mapGet = uncurry(Map.prototype.get) as <K, V>(map: Map<K, V>, key: K) => V | undefined;
/** `Map.prototype.set`, uncurried. */
export const mapSet = uncurry(Map.prototype.set) as <K, V>(
  map: Map<K, V>,
  key: K,
  value: V
) => Map<K, V>;
/** `Map.prototype.delete`, uncurried. */
export const mapDelete = uncurry(Map.prototype.delete) as <K, V>(map: Map<K, V>, key: K) => boolean;

/**
 * Whether `text` ends with `suffix`, without `String.prototype.endsWith`.
 *
 * @param text - A string.
 * @param suffix - The ending.
 */
export function endsWith(text: string, suffix: string): boolean {
  return text.length >= suffix.length && slice(text, text.length - suffix.length) === suffix;
}

/**
 * Make an `Error` carrying a `code`, with both set as own properties so no
 * setter on `Error.prototype` can drop them.
 *
 * @param code - The error code.
 * @param message - The message.
 */
export function codedError(code: string, message: string): Error & { code: string } {
  const err = new ErrorCtor(message) as Error & { code: string };
  defineProperty(err, 'code', {
    value: code,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return err;
}

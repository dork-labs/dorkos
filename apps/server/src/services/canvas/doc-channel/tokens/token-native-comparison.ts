/** Captured descriptor-only comparison for authentic native token source DATA. */
import { types } from 'node:util';
const own = Object.getOwnPropertyDescriptor,
  keys = Object.keys,
  define = Object.defineProperty;
const array = Array.isArray,
  sort = Array.prototype.sort,
  scalar = JSON.stringify,
  apply = Reflect.apply;
const proxy = types.isProxy;
function encode(value: unknown, depth: number): string {
  if (depth > 40) throw new Error('Native token source is not bounded DATA');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return apply(scalar, JSON, [value]);
  if (!value || typeof value !== 'object' || proxy(value))
    throw new Error('Native token source is not own DATA');
  const isArray = array(value);
  let names: string[];
  if (isArray) {
    const length = own(value, 'length');
    const actual = length && own(length, 'value');
    if (!actual || !Number.isSafeInteger(actual.value) || actual.value < 0 || actual.value > 4096)
      throw new Error('Native token DATA array is not bounded');
    names = [];
    for (let index = 0; index < actual.value; index++)
      define(names, String(index), {
        value: String(index),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  } else {
    names = keys(value);
    apply(sort, names, []);
    if (names.length > 256) throw new Error('Native token DATA object is not bounded');
  }
  let text = isArray ? '[' : '{';
  for (let index = 0; index < names.length; index++) {
    const key = names[index]!,
      field = own(value, key),
      actual = field && own(field, 'value');
    if (!actual) throw new Error('Native token DATA field is not own DATA');
    text +=
      (index ? ',' : '') +
      (isArray ? '' : apply(scalar, JSON, [key]) + ':') +
      encode(actual.value, depth + 1);
    if (text.length > 1048576) throw new Error('Native token source exceeds bounded DATA');
  }
  return text + (isArray ? ']' : '}');
}
/** Compare the complete retained original token DATA. */
export function sameOriginalDocTokenData(left: unknown, right: unknown): boolean {
  return encode(left, 0) === encode(right, 0);
}

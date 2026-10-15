/**
 * Text fields of a `multipart/form-data` body, gathered into one object the
 * way `multer` gathered them into `req.body` (through `append-field`).
 *
 * A plain name sets a key, and a name sent twice becomes a list of both
 * values. A name with brackets builds the nested shape it spells:
 * `a[b]=1` is `{ a: { b: '1' } }`, `a[0]=1` is `{ a: ['1'] }` and `a[]=1`
 * appends. A name the bracket syntax cannot read is kept whole, as a plain
 * key. Every object is made without a prototype, so a field named
 * `__proto__` is a key like any other.
 *
 * {@link appendFormField} is that port: the routes that read text fields off
 * an upload (`http/uploads.ts`) read the same object they read under multer.
 *
 * @module http/form-fields
 */

/** One step down a field name: a key into an object or an index into a list. */
interface Step {
  type: 'object' | 'array';
  key: string | number;
  last?: boolean;
  append?: boolean;
  nextType?: 'object' | 'array';
}

/** The gathered fields: strings, lists of them, and objects of either. */
export type FormFields = Record<string, unknown>;

/** A fresh, prototype-free object to gather fields into. */
export function emptyFormFields(): FormFields {
  return Object.create(null) as FormFields;
}

/** Split a field name into steps; a name the syntax cannot read is one step. */
function parsePath(key: string): Step[] {
  const failure = (): Step[] => [{ type: 'object', key, last: true }];
  const firstKey = /^[^[]*/.exec(key)![0];
  if (!firstKey) return failure();

  let pos = firstKey.length;
  let tail: Step = { type: 'object', key: firstKey };
  const steps: Step[] = [tail];
  while (pos < key.length) {
    if (key[pos] === '[' && key[pos + 1] === ']') {
      pos += 2;
      tail.append = true;
      if (pos !== key.length) return failure();
      continue;
    }
    const digit = /^\[(\d+)\]/.exec(key.substring(pos));
    if (digit !== null) {
      pos += digit[0].length;
      tail.nextType = 'array';
      tail = { type: 'array', key: parseInt(digit[1]!, 10) };
      steps.push(tail);
      continue;
    }
    const named = /^\[([^\]]+)\]/.exec(key.substring(pos));
    if (named !== null) {
      pos += named[0].length;
      tail.nextType = 'object';
      tail = { type: 'object', key: named[1]! };
      steps.push(tail);
      continue;
    }
    return failure();
  }
  tail.last = true;
  return steps;
}

/** What kind of value a slot holds now. */
function valueType(value: unknown): 'undefined' | 'array' | 'object' | 'scalar' {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'scalar';
}

type Container = Record<string | number, unknown>;

/** Put the value in the last slot: set it, append it, or turn the slot into a list. */
function setLastValue(context: Container, step: Step, current: unknown, value: string): unknown {
  switch (valueType(current)) {
    case 'undefined':
      context[step.key] = step.append ? [value] : value;
      break;
    case 'array':
      (context[step.key] as unknown[]).push(value);
      break;
    case 'object': {
      const inner = current as Container;
      return setLastValue(inner, { type: 'object', key: '', last: true }, inner[''], value);
    }
    case 'scalar':
      context[step.key] = [context[step.key], value];
      break;
  }
  return context;
}

/** Walk one step, making the object or list the next step needs. */
function setValue(context: Container, step: Step, current: unknown, value: string): unknown {
  if (step.last) return setLastValue(context, step, current, value);
  switch (valueType(current)) {
    case 'undefined':
      context[step.key] = step.nextType === 'array' ? [] : Object.create(null);
      return context[step.key];
    case 'object':
      return context[step.key];
    case 'array': {
      if (step.nextType === 'array') return current;
      const obj: Container = Object.create(null);
      context[step.key] = obj;
      (current as unknown[]).forEach((item, i) => {
        if (item !== undefined) obj[String(i)] = item;
      });
      return obj;
    }
    default: {
      // A scalar already sits where an object is needed: keep it under `''`.
      const obj: Container = Object.create(null);
      obj[''] = current;
      context[step.key] = obj;
      return obj;
    }
  }
}

/**
 * Add one text field to the gathered fields, as `append-field` did for multer.
 *
 * @param store - The gathered fields so far.
 * @param key - The field's name, as the client sent it (escapes reversed).
 * @param value - The field's value.
 */
export function appendFormField(store: FormFields, key: string, value: string): void {
  parsePath(key).reduce<unknown>(
    (context, step) =>
      setValue(context as Container, step, (context as Container)[step.key], value),
    store
  );
}

import { expect } from 'vitest';

/** Path to one provider response field trusted by a wrapper. */
export type FixturePath = readonly (string | number)[];

/** One destructive mutation used to prove a trusted provider field fails closed. */
export interface ProviderFixtureMutation {
  /** Human-readable mutation and field path. */
  label: string;
  /** Mutated independent fixture. */
  value: unknown;
}

function containerAt(value: unknown, path: FixturePath): Record<string, unknown> | unknown[] {
  let current = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`Fixture path is not an object: ${path.join('.')}`);
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (typeof current !== 'object' || current === null) {
    throw new Error(`Fixture path is not an object: ${path.join('.')}`);
  }
  return current as Record<string, unknown> | unknown[];
}

/** Read an object in a provider fixture without unsafe casts in each contract test. */
export function objectAt(value: unknown, ...path: string[]): Record<string, unknown> {
  const result = containerAt(value, path);
  if (Array.isArray(result)) throw new Error(`Fixture path is an array: ${path.join('.')}`);
  return result;
}

/**
 * Generate removal, rename, type-change, and control-injection cases for trusted fields.
 *
 * @param fixture - Sanitized machine-readable provider response.
 * @param paths - Every response field the wrapper relies on.
 * @returns Independent fixture mutations labeled by operation and path.
 */
export function mutateTrustedProviderFields(
  fixture: unknown,
  paths: readonly FixturePath[]
): ProviderFixtureMutation[] {
  return paths.flatMap((path) => {
    if (path.length === 0) throw new Error('Trusted fixture paths cannot be empty');
    const key = path.at(-1)!;
    const parentPath = path.slice(0, -1);
    const source = containerAt(fixture, parentPath);
    const current = (source as Record<string | number, unknown>)[key];
    const variants: ProviderFixtureMutation[] = [];

    const removed = structuredClone(fixture);
    const removedParent = containerAt(removed, parentPath);
    if (Array.isArray(removedParent) && typeof key === 'number') removedParent.splice(key, 1);
    else delete (removedParent as Record<string | number, unknown>)[key];
    variants.push({ label: `remove ${path.join('.')}`, value: removed });

    if (typeof key === 'string') {
      const renamed = structuredClone(fixture);
      const renamedParent = containerAt(renamed, parentPath) as Record<string, unknown>;
      renamedParent[`${key}_renamed`] = renamedParent[key];
      delete renamedParent[key];
      variants.push({ label: `rename ${path.join('.')}`, value: renamed });
    }

    const wrongType = structuredClone(fixture);
    const wrongTypeParent = containerAt(wrongType, parentPath) as Record<string | number, unknown>;
    wrongTypeParent[key] = typeof current === 'boolean' ? 'false' : { invalid: true };
    variants.push({ label: `change type ${path.join('.')}`, value: wrongType });

    if (typeof current === 'string') {
      const controlled = structuredClone(fixture);
      const controlledParent = containerAt(controlled, parentPath) as Record<
        string | number,
        unknown
      >;
      controlledParent[key] = `${current}\u001b[2J`;
      variants.push({ label: `inject control ${path.join('.')}`, value: controlled });
    }
    return variants;
  });
}

function collectFixtureStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectFixtureStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...collectFixtureStrings(child)]);
  }
  return [];
}

/**
 * Drop Fly's `secrets { name }` selection: a list of names only, which the provenance read needs
 * and whose key would otherwise match the credential pattern. Any other shape under `secrets` is
 * kept, so a fixture carrying a secret value still fails.
 */
function withoutSecretNameLists(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecretNameLists);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, child]) =>
          !(
            key === 'secrets' &&
            Array.isArray(child) &&
            child.every(
              (item) =>
                typeof item === 'object' &&
                item !== null &&
                Object.keys(item).length === 1 &&
                'name' in item
            )
          )
      )
      .map(([key, child]) => [key, withoutSecretNameLists(child)])
  );
}

/** Prove a checked-in provider fixture has no credential shape, URL, or terminal control. */
export function expectSanitizedProviderFixture(fixture: unknown, label: string): void {
  const value = withoutSecretNameLists(fixture);
  const serialized = JSON.stringify(value);
  expect(serialized, label).not.toMatch(
    /password|secret|access[_-]?key|session[_-]?token|postgres(?:ql)?:\/\/|https?:\/\//iu
  );
  for (const item of collectFixtureStrings(value)) {
    const hasTerminalControl = [...item].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    });
    expect(hasTerminalControl, label).toBe(false);
  }
}

/**
 * A runtime's safety guards are read fail-closed (DOR-3596): only a guard the
 * runtime declares as exactly `true` counts, so a runtime that says nothing is
 * treated as having none.
 *
 * @module shared/__tests__/runtime-guards
 */
import { describe, expect, it } from 'vitest';
import { RUNTIME_GUARDS, declaresGuard, type RuntimeCapabilities } from '../agent-runtime.js';

describe('declaresGuard', () => {
  it.each(RUNTIME_GUARDS)('counts %s only when it is declared true', (guard) => {
    expect(declaresGuard({ guards: { [guard]: true } }, guard)).toBe(true);
    expect(declaresGuard({ guards: { [guard]: false } }, guard)).toBe(false);
  });

  it('reads a runtime that declares nothing as having no guards', () => {
    for (const guard of RUNTIME_GUARDS) {
      expect(declaresGuard({}, guard)).toBe(false);
      expect(declaresGuard({ guards: {} }, guard)).toBe(false);
      expect(declaresGuard(undefined, guard)).toBe(false);
      expect(declaresGuard(null, guard)).toBe(false);
    }
  });

  it('never counts a value that is not exactly true', () => {
    // A runtime built outside this type system (an extension, a parsed file) can hand over anything.
    const loose = (value: unknown) =>
      ({ guards: { protectedPaths: value } }) as unknown as Pick<RuntimeCapabilities, 'guards'>;
    for (const value of ['true', 1, {}, [], 'yes']) {
      expect(declaresGuard(loose(value), 'protectedPaths')).toBe(false);
    }
  });

  it('does not let one guard stand in for another', () => {
    expect(declaresGuard({ guards: { ownFolder: true } }, 'protectedPaths')).toBe(false);
    expect(declaresGuard({ guards: { protectedPaths: true } }, 'ownFolder')).toBe(false);
  });
});

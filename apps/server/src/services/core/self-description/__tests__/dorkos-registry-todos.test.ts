/**
 * With `DORKOS_TODOS_ENABLED` on, the docs composer includes the to-do tools and still composes
 * (DOR-3088). It once listed the domain without a placeholder for its deps, so the server would
 * not start with the flag on.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../env.js')>();
  return { ...actual, env: { ...actual.env, DORKOS_TODOS_ENABLED: true } };
});

import { composeCapabilityRegistryForDocs } from '../dorkos-registry.js';

describe('composeCapabilityRegistryForDocs with to-dos on', () => {
  it('composes, and lists the to-do tools', () => {
    const ids = composeCapabilityRegistryForDocs().capabilities.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['todos.add', 'todos.update', 'todos.list']));
  });
});

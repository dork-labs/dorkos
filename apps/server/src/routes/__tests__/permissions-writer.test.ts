/**
 * What a permission's history calls the signed-in owner (DOR-2964).
 *
 * Accounts made since DOR-2964 have an empty `user.name`, and older ones often
 * carry their email as it. The raw column used to go straight into the label,
 * which would read "You (signed in as )".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  account: { id: 'owner-1', email: 'dorian@example.com', name: '' },
  displayName: null as string | null,
}));

vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: state.account.id, name: state.account.name }),
  getUserById: (id: string) => (id === state.account.id ? state.account : null),
}));
vi.mock('../../services/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/core/config-manager.js')>();
  return {
    ...actual,
    configManager: {
      get: (key: string) => (key === 'profile' ? { displayName: state.displayName } : undefined),
    },
  };
});

import { writerForPosture } from '../permissions.js';

const SIGNED_IN = { userId: 'owner-1' } as Parameters<typeof writerForPosture>[1];

describe('writerForPosture labels the signed-in owner', () => {
  beforeEach(() => {
    state.account = { id: 'owner-1', email: 'dorian@example.com', name: '' };
    state.displayName = null;
  });

  it('uses the email when the account has no name and the profile has none', () => {
    expect(writerForPosture('signed-in-operator', SIGNED_IN).actorLabel).toBe(
      'You (signed in as dorian@example.com)'
    );
  });

  it('prefers the profile name over an account name that is only the email', () => {
    state.account.name = 'dorian@example.com';
    state.displayName = 'Dorian';
    expect(writerForPosture('signed-in-operator', SIGNED_IN).actorLabel).toBe(
      'You (signed in as Dorian)'
    );
  });

  it('keeps a real account name first', () => {
    state.account.name = 'Dorian C';
    state.displayName = 'Dorian';
    expect(writerForPosture('signed-in-operator', SIGNED_IN).actorLabel).toBe(
      'You (signed in as Dorian C)'
    );
  });
});

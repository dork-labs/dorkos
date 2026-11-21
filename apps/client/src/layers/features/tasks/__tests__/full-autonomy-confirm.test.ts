import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { autonomyToConfirm } from '../lib/full-autonomy-confirm';

const ASK: PermissionModeDescriptor = {
  id: 'default',
  label: 'Default',
  stop: 'ask',
  asks: 'always',
  reach: 'edit',
  promise: 'Asks before it edits a file or runs a command.',
};
const ACT: PermissionModeDescriptor = {
  id: 'acceptEdits',
  label: 'Accept edits',
  stop: 'act',
  asks: 'when-risky',
  reach: 'edit',
  promise: 'Edits files on its own. Asks before it runs a command.',
};
const FULL: PermissionModeDescriptor = {
  id: 'bypassPermissions',
  label: 'Bypass permissions',
  stop: 'autonomy',
  asks: 'never',
  reach: 'everything',
  promise: 'Runs everything without asking.',
};
/** Codex's shape: a middle stop that cannot pause to ask. */
const NEVER_ASKING_ACT: PermissionModeDescriptor = {
  id: 'acceptEdits',
  label: 'Workspace write',
  stop: 'act',
  asks: 'never',
  reach: 'workspace',
  promise: 'Edits files and runs commands inside the workspace.',
};
/** Codex's read-only default: never asks because it has nothing to ask about. */
const READ_ONLY: PermissionModeDescriptor = {
  id: 'default',
  label: 'Read only',
  stop: 'ask',
  asks: 'never',
  reach: 'read',
  promise: 'Reads files. Nothing changes.',
};

const CLAUDE = [ASK, ACT, FULL];

describe('autonomyToConfirm (DOR-3841)', () => {
  it('asks for a new schedule at Full autonomy, with the runtime’s own descriptor', () => {
    expect(
      autonomyToConfirm({
        value: { permissionMode: 'bypassPermissions', runtime: '' },
        descriptors: CLAUDE,
      })
    ).toBe(FULL);
  });

  it('saves a new schedule at a level that asks with no confirm', () => {
    for (const mode of ['default', 'acceptEdits']) {
      expect(
        autonomyToConfirm({ value: { permissionMode: mode, runtime: '' }, descriptors: CLAUDE })
      ).toBeNull();
    }
  });

  it('asks for a middle stop that never asks, and not for a read-only one', () => {
    expect(
      autonomyToConfirm({
        value: { permissionMode: 'acceptEdits', runtime: 'codex' },
        descriptors: [READ_ONLY, NEVER_ASKING_ACT],
      })
    ).toBe(NEVER_ASKING_ACT);
    expect(
      autonomyToConfirm({
        value: { permissionMode: 'default', runtime: 'codex' },
        descriptors: [READ_ONLY, NEVER_ASKING_ACT],
      })
    ).toBeNull();
  });

  it('asks when an edit moves into Full, and not when it stays there', () => {
    expect(
      autonomyToConfirm({
        value: { permissionMode: 'bypassPermissions', runtime: '' },
        opening: { permissionMode: 'acceptEdits', runtime: '' },
        descriptors: CLAUDE,
      })
    ).toBe(FULL);
    expect(
      autonomyToConfirm({
        value: { permissionMode: 'bypassPermissions', runtime: '' },
        opening: { permissionMode: 'bypassPermissions', runtime: '' },
        descriptors: CLAUDE,
      })
    ).toBeNull();
  });

  it('asks when an edit keeps the mode but moves it onto a runtime where it never asks', () => {
    expect(
      autonomyToConfirm({
        value: { permissionMode: 'acceptEdits', runtime: 'codex' },
        opening: { permissionMode: 'acceptEdits', runtime: '' },
        descriptors: [READ_ONLY, NEVER_ASKING_ACT],
      })
    ).toBe(NEVER_ASKING_ACT);
  });

  it('still asks for a known Full id before the runtime has said what it means', () => {
    const descriptor = autonomyToConfirm({
      value: { permissionMode: 'bypassPermissions', runtime: '' },
      descriptors: [],
    });
    expect(descriptor).toMatchObject({ id: 'bypassPermissions', stop: 'autonomy' });
    expect(
      autonomyToConfirm({ value: { permissionMode: 'acceptEdits', runtime: '' }, descriptors: [] })
    ).toBeNull();
  });
});

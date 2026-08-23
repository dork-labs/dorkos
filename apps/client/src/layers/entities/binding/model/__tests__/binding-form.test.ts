import { describe, it, expect } from 'vitest';
import { buildDefaultValues } from '../binding-form';

describe('buildDefaultValues — the unattended default (spec full-power-defaults D6)', () => {
  it('a new binding falls back to acceptEdits and canInitiate false with no operator defaults', () => {
    const values = buildDefaultValues();
    expect(values.permissionMode).toBe('acceptEdits');
    expect(values.canInitiate).toBe(false);
  });

  it('a new binding opens at the operator mode and pre-selects canInitiate on full power', () => {
    const values = buildDefaultValues(undefined, {
      defaultPermissionMode: 'bypassPermissions',
      defaultCanInitiate: true,
    });
    expect(values.permissionMode).toBe('bypassPermissions');
    expect(values.canInitiate).toBe(true);
  });

  it('does NOT pre-select canInitiate when the operator did not choose full power', () => {
    const values = buildDefaultValues(undefined, {
      defaultPermissionMode: 'acceptEdits',
      defaultCanInitiate: false,
    });
    expect(values.canInitiate).toBe(false);
  });

  it('an existing binding keeps its own stored mode and canInitiate over the operator defaults', () => {
    const values = buildDefaultValues(
      { permissionMode: 'plan', canInitiate: false },
      { defaultPermissionMode: 'bypassPermissions', defaultCanInitiate: true }
    );
    expect(values.permissionMode).toBe('plan');
    expect(values.canInitiate).toBe(false);
  });
});

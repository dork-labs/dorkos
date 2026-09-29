import { describe, it, expect } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { buildFormValues, copyFormValues } from '../ui/task-form-values';

const PRESET = {
  id: 'preset-1',
  name: 'Daily review',
  description: 'Review PRs',
  prompt: 'Review all pending PRs',
  cron: '0 9 * * *',
} as TaskTemplate;

const EDIT_TASK = {
  id: 'task-1',
  name: 'Existing',
  description: 'x',
  prompt: 'do the thing',
  cron: null,
  agentId: null,
  permissionMode: 'plan',
  enabled: true,
} as unknown as Task;

describe('buildFormValues — the unattended default (spec full-power-defaults D6)', () => {
  it('a blank task falls back to acceptEdits when no stop is configured', () => {
    expect(buildFormValues().permissionMode).toBe('acceptEdits');
  });

  it('a blank task opens at the resolved operator mode when one is given', () => {
    expect(
      buildFormValues(undefined, undefined, undefined, 'bypassPermissions').permissionMode
    ).toBe('bypassPermissions');
  });

  it('a preset task opens at the resolved operator mode', () => {
    const values = buildFormValues(undefined, PRESET, undefined, 'bypassPermissions');
    expect(values.permissionMode).toBe('bypassPermissions');
    expect(values.name).toBe('Daily review');
  });

  it('editing an existing task keeps its stored mode, ignoring the operator default', () => {
    expect(
      buildFormValues(EDIT_TASK, undefined, undefined, 'bypassPermissions').permissionMode
    ).toBe('plan');
  });
});

describe('copyFormValues — Make my own copy (DOR-2272)', () => {
  it('keeps everything the person typed and names the copy after the original', () => {
    // Purpose: the copy is the person's edit, filed as their own schedule; only
    // the name changes, so it cannot collide with the package's own.
    const values = { ...buildFormValues(EDIT_TASK), prompt: 'my version', agentId: 'agent-1' };

    const copy = copyFormValues(values);

    expect(copy).toEqual({ ...values, name: 'Existing-copy' });
  });

  it('counts up past names already taken, ignoring case', () => {
    // Purpose: a second copy must not collide with the first (DOR-2272 review).
    const values = buildFormValues(EDIT_TASK);

    expect(copyFormValues(values, ['Existing-Copy']).name).toBe('Existing-copy-2');
    expect(copyFormValues(values, ['existing-copy', 'existing-copy-2']).name).toBe(
      'Existing-copy-3'
    );
  });

  it('keeps the name inside the 100-character limit', () => {
    // Purpose: a long package name plus the suffix must still pass the form's
    // own name rule, or Create would be dead on arrival.
    const values = { ...buildFormValues(EDIT_TASK), name: 'x'.repeat(100) };

    const copy = copyFormValues(values);

    expect(copy.name).toHaveLength(100);
    expect(copy.name.endsWith('-copy')).toBe(true);
  });
});

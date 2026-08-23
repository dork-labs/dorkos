import { describe, it, expect } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { buildFormValues } from '../ui/TaskFormInner';

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

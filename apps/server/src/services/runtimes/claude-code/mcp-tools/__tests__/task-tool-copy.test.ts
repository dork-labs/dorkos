/**
 * What the `tasks_*` tools tell an agent about asking for more power and about a task's
 * approval record states the real rules (DOR-4678): the cap on requested rules is the schema's
 * own, and `tasks_list` names the fields DOR-3641 added.
 */
import { describe, expect, it } from 'vitest';
import { TaskPermissionRulesSchema } from '@dorkos/shared/schemas';
import {
  REQUESTED_ALLOW_DESCRIPTION,
  TASK_PERMISSION_RULES_MAX,
  TASKS_CREATE_DESCRIPTION,
  TASKS_LIST_DESCRIPTION,
  TASKS_UPDATE_DESCRIPTION,
} from '../tasks/task-tool-copy.js';

const rules = (n: number) => Array.from({ length: n }, (_, i) => `Bash(/usr/bin/true --n${i})`);

describe('the requested-rules cap', () => {
  it('is the schema’s own limit', () => {
    expect(TaskPermissionRulesSchema.safeParse(rules(TASK_PERMISSION_RULES_MAX)).success).toBe(
      true
    );
    expect(TaskPermissionRulesSchema.safeParse(rules(TASK_PERMISSION_RULES_MAX + 1)).success).toBe(
      false
    );
  });

  it('is stated wherever an agent can ask', () => {
    const cap = `up to ${TASK_PERMISSION_RULES_MAX}`;
    expect(REQUESTED_ALLOW_DESCRIPTION).toContain(cap);
    for (const description of [TASKS_CREATE_DESCRIPTION, TASKS_UPDATE_DESCRIPTION]) {
      expect(description).toContain('requestedPermissionMode');
      expect(description).toContain(`requestedAllow (${cap} rules)`);
      expect(description).toContain('nothing applies until a person approves it');
    }
  });
});

describe('tasks_list', () => {
  it('names the approval record and which tasks can wake', () => {
    for (const field of ['approvedAt', 'approvedBy', 'approvedVia']) {
      expect(TASKS_LIST_DESCRIPTION).toContain(field);
    }
    expect(TASKS_LIST_DESCRIPTION).toContain('Only a task with enabled true and status "active"');
    // The DOR-3641 backfill and `completeTaskApproval`'s default store policy/unknown when
    // nobody knows who approved, so "policy" can't be read as a DorkOS rule there.
    expect(TASKS_LIST_DESCRIPTION).toContain(
      'with it, kind "policy" also means DorkOS did not record who approved it'
    );
  });
});

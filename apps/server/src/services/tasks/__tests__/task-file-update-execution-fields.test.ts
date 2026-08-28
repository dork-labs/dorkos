/**
 * The execution trio's file half: an API write of `runtime`, `model` or `effort`
 * has to reach the SKILL.md, and it has to land inside the `schedule:` block
 * (DOR-1615, DOR-1347).
 *
 * Both halves are load-bearing. A request that never opens the file leaves the
 * row and the file disagreeing until the next reconcile, which then reverts the
 * person's edit — the file is the source of truth. And the block, never the top
 * level: a top-level `model:` is the Claude Code dialect a person's own
 * invocation of the skill reads, so a Codex model id written there would be
 * handed to Claude Code.
 *
 * @module services/tasks/__tests__/task-file-update-execution-fields
 */
import { describe, it, expect } from 'vitest';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { planTaskFileUpdate, touchesFile, type FileBackedRow } from '../task-file-update.js';

const FILE_PATH = `/home/u/.dork/tasks/sweeper/${SKILL_FILENAME}`;

/** The row a request is compared against, with the fields a case varies. */
function row(overrides: Partial<FileBackedRow> = {}): FileBackedRow {
  return {
    name: 'sweeper',
    displayName: null,
    description: 'Sweep the repo',
    cron: '0 3 * * *',
    timezone: 'UTC',
    enabled: true,
    sticky: false,
    permissionMode: 'acceptEdits',
    prompt: 'sweep it',
    runtime: null,
    model: null,
    effort: null,
    ...overrides,
  };
}

/** A SKILL.md whose block carries the given extra lines. */
function file(blockLines = ''): string {
  return `---\nname: sweeper\ndescription: Sweep the repo\nschedule:\n  cron: 0 3 * * *\n  timezone: UTC\n${blockLines}---\n\nsweep it\n`;
}

describe('touchesFile — does an execution write open the SKILL.md', () => {
  it.each(['runtime', 'model', 'effort'] as const)('opens the file for a new %s', (field) => {
    expect(touchesFile({ [field]: 'codex' }, row())).toBe(true);
  });

  it.each(['runtime', 'model', 'effort'] as const)('opens the file to CLEAR %s', (field) => {
    // Clearing is a state a person chooses — back to "the agent's answer" — and
    // it only means anything if the key actually leaves the file.
    expect(touchesFile({ [field]: null }, row({ [field]: 'codex' }))).toBe(true);
  });

  it('does NOT open the file when the request re-sends what the row already holds', () => {
    // The request and the column spell "no override" the same way, so a re-sent
    // current value is correctly read as no change.
    expect(touchesFile({ runtime: 'codex' }, row({ runtime: 'codex' }))).toBe(false);
    expect(touchesFile({ runtime: null }, row({ runtime: null }))).toBe(false);
  });
});

describe('planTaskFileUpdate — where the trio is written', () => {
  it('writes all three INSIDE the schedule block, not at the top level', () => {
    const plan = planTaskFileUpdate(FILE_PATH, file(), {
      runtime: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    });

    expect(plan.kind).toBe('write');
    const written = plan.kind === 'write' ? plan.frontmatter : {};
    expect(written.schedule).toMatchObject({
      runtime: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
    });
    // The discriminating half: a `model:` at the top level is read by Claude
    // Code when a person invokes the skill by hand.
    expect(written).not.toHaveProperty('model');
    expect(written).not.toHaveProperty('runtime');
    expect(written).not.toHaveProperty('effort');
  });

  it('DELETES the key from the block when the request clears it', () => {
    const plan = planTaskFileUpdate(
      FILE_PATH,
      file('  runtime: codex\n  model: gpt-5.5\n  effort: high\n'),
      { runtime: null, model: null }
    );

    expect(plan.kind).toBe('write');
    const block =
      plan.kind === 'write' ? (plan.frontmatter.schedule as Record<string, unknown>) : {};
    expect(block).not.toHaveProperty('runtime');
    expect(block).not.toHaveProperty('model');
    // Untouched fields survive — a clear of one is not a reset of the block.
    expect(block).toMatchObject({ effort: 'high', cron: '0 3 * * *' });
  });

  it('leaves a block that names none of them exactly as it was', () => {
    const plan = planTaskFileUpdate(FILE_PATH, file(), { description: 'Sweep harder' });

    expect(plan.kind).toBe('write');
    const block =
      plan.kind === 'write' ? (plan.frontmatter.schedule as Record<string, unknown>) : {};
    expect(block).not.toHaveProperty('runtime');
    expect(block).not.toHaveProperty('model');
    expect(block).not.toHaveProperty('effort');
  });
});

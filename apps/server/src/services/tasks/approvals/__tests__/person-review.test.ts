import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMockSchedule } from '@dorkos/test-utils';
import { taskReviewRevision, taskReviewRowRevision } from '../person-review.js';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

describe('a person’s schedule review revision', () => {
  it('changes when the row mode or prompt changes, but not when run history changes', () => {
    const task = createMockSchedule();
    const revision = taskReviewRevision(task);
    expect(taskReviewRevision({ ...task, permissionMode: 'dontAsk' })).not.toBe(revision);
    expect(taskReviewRevision({ ...task, prompt: 'Different instructions' })).not.toBe(revision);
    expect(taskReviewRevision({ ...task, nextRun: 'later', updatedAt: 'later' })).toBe(revision);
  });
  it('refuses a file edit even before the watcher updates the row', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'schedule-review-'));
    homes.push(home);
    const filePath = path.join(home, 'SKILL.md');
    writeFileSync(filePath, 'original instructions');
    const task = createMockSchedule({ filePath });
    const revision = taskReviewRevision(task);
    const rowRevision = taskReviewRowRevision(task);
    writeFileSync(filePath, 'replacement instructions');
    expect(taskReviewRowRevision(task)).toBe(rowRevision);
    expect(taskReviewRevision(task)).not.toBe(revision);
  });
});

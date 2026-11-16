/**
 * DOR-4315: an agent-set list rides a run only on the programs it pinned, and a
 * one-shot task's list rides its one scheduled run only. Real files in a
 * throwaway folder; made-up names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockSchedule } from '@dorkos/test-utils';
import { pinPrograms, mergePins, parsePins, type AllowListPins } from '../allow-list-pins.js';
import {
  LEVEL_DROPPED_MESSAGE,
  PINS_UNREADABLE_MESSAGE,
  PROGRAM_CHANGED_MESSAGE,
  settleRunAllowList,
  type RunAllowListSources,
} from '../run-allow-list.js';

let dir: string;
let program: string;
let rule: string;
let pins: AllowListPins;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dor4315-run-'));
  program = path.join(dir, 'derive-sample');
  await fs.writeFile(program, '#!/bin/sh\necho sample\n', { mode: 0o755 });
  rule = `Bash(${program} --backfill)`;
  const pinned = await pinPrograms([rule]);
  if (!pinned.ok) throw new Error('could not pin the sample program');
  pins = mergePins(null, pinned.programs, [rule], '2026-11-16T00:00:00.000Z');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const scheduled = { trigger: 'scheduled' as const };

/** The run's sources: these pins, and an agent still at Full unless told otherwise. */
function src(atFull = true): RunAllowListSources {
  return { pinsOf: () => pins, agentStillRunsCommands: async () => atFull };
}

describe('settleRunAllowList', () => {
  it('carries a list whose programs still match their pins', async () => {
    const task = createMockSchedule({ approvedAllow: [rule], runOnce: true, cron: '' });
    await expect(settleRunAllowList(task, scheduled, src())).resolves.toBe(task);
  });

  it('refuses the run when a pinned program changed', async () => {
    await fs.writeFile(program, '#!/bin/sh\necho changed\n');
    const task = createMockSchedule({ approvedAllow: [rule], runOnce: true, cron: '' });
    await expect(settleRunAllowList(task, scheduled, src())).rejects.toThrow(
      PROGRAM_CHANGED_MESSAGE
    );
  });

  it('refuses the run when a pinned program is now a link to another file', async () => {
    const other = path.join(dir, 'other');
    await fs.writeFile(other, '#!/bin/sh\necho sample\n', { mode: 0o755 });
    await fs.rm(program);
    await fs.symlink(other, program);
    const task = createMockSchedule({ approvedAllow: [rule], runOnce: true, cron: '' });
    await expect(settleRunAllowList(task, scheduled, src())).rejects.toThrow(
      PROGRAM_CHANGED_MESSAGE
    );
  });

  it('does not check a rule a person approved, which has no pin', async () => {
    const task = createMockSchedule({ approvedAllow: ['Read(notes/today.md)'] });
    await expect(settleRunAllowList(task, scheduled, src())).resolves.toBe(task);
  });

  it.each(['manual', 'agent'] as const)(
    'runs a one-shot task’s %s run without its list',
    async (trigger) => {
      const task = createMockSchedule({ approvedAllow: [rule], runOnce: true, cron: '' });
      await expect(settleRunAllowList(task, { trigger }, src())).resolves.toMatchObject({
        approvedAllow: null,
      });
    }
  );

  it('runs a one-shot task that was later given a cron without its list', async () => {
    const task = createMockSchedule({ approvedAllow: [rule], runOnce: true, cron: '*/5 * * * *' });
    await expect(settleRunAllowList(task, scheduled, src())).resolves.toMatchObject({
      approvedAllow: null,
    });
  });

  it('refuses the run when the pins can’t be read', async () => {
    const task = createMockSchedule({ approvedAllow: [rule], runOnce: true, cron: '' });
    await expect(
      settleRunAllowList(task, scheduled, { ...src(), pinsOf: () => parsePins('{not json') })
    ).rejects.toThrow(PINS_UNREADABLE_MESSAGE);
  });

  it('leaves a task with no list alone', async () => {
    const task = createMockSchedule();
    await expect(settleRunAllowList(task, scheduled, src())).resolves.toBe(task);
  });

  it('refuses the run when its agent no longer runs commands without asking', async () => {
    const task = createMockSchedule({ approvedAllow: [rule], runOnce: true, cron: '' });
    await expect(settleRunAllowList(task, scheduled, src(false))).rejects.toThrow(
      LEVEL_DROPPED_MESSAGE
    );
  });

  it('does not ask about the agent’s level for rules a person approved', async () => {
    const task = createMockSchedule({ approvedAllow: ['Read(notes/today.md)'] });
    await expect(settleRunAllowList(task, scheduled, src(false))).resolves.toBe(task);
  });
});

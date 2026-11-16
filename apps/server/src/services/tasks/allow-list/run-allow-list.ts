/**
 * The run's half of a task's agent-set allow list (DOR-4315), checked once per
 * run before either dispatch path starts a turn, so a direct run and a relay
 * run carry the same answer.
 *
 * - **A program that changed refuses the run.** Each entry an agent set was
 *   pinned (real path and sha256) when it was set; a run whose program no
 *   longer matches fails with the sentence below, on the run row a person
 *   reads, and nothing runs. The old command line never runs on new bytes.
 *   Rules a person approved on a card carry no pin and are not checked here.
 * - **Pins that can't be read refuse the run** whenever it would carry a list:
 *   DorkOS can no longer tell which rules its agent set.
 * - **A one-shot task's list rides its one scheduled run only.** A manual or
 *   trial run of it runs without the list, so Don't ask refuses those commands,
 *   and so does any run of a one-shot task that has since been given a cron.
 *
 * @module services/tasks/allow-list/run-allow-list
 */
import type { Task, TaskRun } from '@dorkos/shared/types';
import { checkPins, type AllowListPins } from './allow-list-pins.js';

/** What a run refused for a changed program ends with. */
export const PROGRAM_CHANGED_MESSAGE =
  'A program in this task’s allow list changed after the list was set, so nothing ran. ' +
  'Check it, then set the list again on a new task.';

/** What a run refused for pins DorkOS can't read ends with. */
export const PINS_UNREADABLE_MESSAGE =
  'DorkOS can’t read what it recorded about this task’s allow list, so nothing ran. ' +
  'Set the list again on a new task.';

/**
 * The task as this run should carry it: unchanged, or without its list for a
 * one-shot task's other runs.
 *
 * @param task - The task being run.
 * @param run - Its run row.
 * @param pinsOf - The task's pins, from DorkOS's own row.
 * @throws {Error} {@link PROGRAM_CHANGED_MESSAGE}, when a pinned program changed,
 *   or {@link PINS_UNREADABLE_MESSAGE}, when the pins can't be read.
 */
export async function settleRunAllowList(
  task: Task,
  run: Pick<TaskRun, 'trigger'>,
  pinsOf: (taskId: string) => AllowListPins
): Promise<Task> {
  const rules = task.approvedAllow ?? [];
  if (rules.length === 0) return task;
  if (task.runOnce && (run.trigger !== 'scheduled' || task.cron)) {
    return { ...task, approvedAllow: null };
  }
  const pins = pinsOf(task.id);
  if (pins.unreadable) throw new Error(PINS_UNREADABLE_MESSAGE);
  const pinned = await checkPins(
    rules.filter((rule) => Object.hasOwn(pins.programs, rule)),
    pins
  );
  if (!pinned.ok) throw new Error(PROGRAM_CHANGED_MESSAGE);
  return task;
}

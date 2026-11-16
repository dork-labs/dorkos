/**
 * The run's half of a task's agent-set allow list (DOR-4315), checked once per
 * run before either dispatch path starts a turn, so a direct run and a relay
 * run carry the same answer.
 *
 * - **The agent's level is read again at fire time.** An agent sets a list
 *   only while its own level runs any command without asking. If its level has
 *   dropped since, a run that would carry its list fails, and nothing runs.
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
import type { MeshCore } from '@dorkos/mesh';
import type { Task, TaskRun } from '@dorkos/shared/types';
import { checkPins, type AllowListPins } from './allow-list-pins.js';
import { agentLevelNow } from '../agent-mode/agent-mode-decision.js';
import { liveAgentModeSources } from '../agent-mode/agent-mode-sources.js';

/** What a run refused for a changed program ends with. */
export const PROGRAM_CHANGED_MESSAGE =
  'A program in this task’s allow list changed after the list was set, so nothing ran. ' +
  'Check it, then set the list again on a new task.';

/** What a run refused for pins DorkOS can't read ends with. */
export const PINS_UNREADABLE_MESSAGE =
  'DorkOS can’t read what it recorded about this task’s allow list, so nothing ran. ' +
  'Set the list again on a new task.';

/** What a run refused because its agent's level dropped ends with. */
export const LEVEL_DROPPED_MESSAGE =
  'This task’s agent no longer runs commands without asking, so its allow list can’t ' +
  'ride and nothing ran.';

/** What {@link settleRunAllowList} reads besides the task and the run. */
export interface RunAllowListSources {
  /** The task's pins, from DorkOS's own row. */
  pinsOf: (taskId: string) => AllowListPins;
  /** Whether the task's own agent still runs any command without asking, now. */
  agentStillRunsCommands: (task: Task) => Promise<boolean>;
}

/**
 * The task as this run should carry it: unchanged, or without its list for a
 * one-shot task's other runs.
 *
 * @param task - The task being run.
 * @param run - Its run row.
 * @param sources - The pins and the agent's level now.
 * @throws {Error} {@link LEVEL_DROPPED_MESSAGE}, {@link PINS_UNREADABLE_MESSAGE}
 *   or {@link PROGRAM_CHANGED_MESSAGE}, when an agent-set list may not ride.
 */
export async function settleRunAllowList(
  task: Task,
  run: Pick<TaskRun, 'trigger'>,
  sources: RunAllowListSources
): Promise<Task> {
  const rules = task.approvedAllow ?? [];
  if (rules.length === 0) return task;
  if (task.runOnce && (run.trigger !== 'scheduled' || task.cron)) {
    return { ...task, approvedAllow: null };
  }
  const pins = sources.pinsOf(task.id);
  if (pins.unreadable) throw new Error(PINS_UNREADABLE_MESSAGE);
  const agentSet = rules.filter((rule) => Object.hasOwn(pins.programs, rule));
  if (agentSet.length === 0) return task;
  const pinned = await checkPins(agentSet, pins);
  if (!pinned.ok) throw new Error(PROGRAM_CHANGED_MESSAGE);
  if (!(await sources.agentStillRunsCommands(task))) throw new Error(LEVEL_DROPPED_MESSAGE);
  return task;
}

/**
 * The live sources, over the store's run controls and Mesh. An agent DorkOS
 * can't name, or a runtime with no declared modes, counts as not running
 * commands without asking.
 *
 * @param store - The task store, for the pins in its run controls.
 * @param meshCore - Mesh, which names each agent's home; absent or `null` when off.
 */
export function allowListSources(
  store: { runControls: { pinsOf: (taskId: string) => AllowListPins } },
  meshCore: Pick<MeshCore, 'getProjectPath'> | null | undefined
): RunAllowListSources {
  return {
    pinsOf: (taskId) => store.runControls.pinsOf(taskId),
    agentStillRunsCommands: async (task) => {
      const sources = liveAgentModeSources(meshCore ?? undefined);
      const owner = task.agentId
        ? sources.agentPathOf(task.agentId)
        : (task.proposedByAgentPath ?? undefined);
      const declared = sources.declaredModes(task.runtime);
      if (!owner || !declared) return false;
      const level = await agentLevelNow(owner, task.runtime, declared, sources);
      return level.asks === 'never' && level.reach === 'everything';
    },
  };
}

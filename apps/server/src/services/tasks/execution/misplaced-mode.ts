/** A misplaced file mode parks before either dispatch path can start anything. */
import { PACKAGE_TEXT_MAX_BYTES, readTextFileWithin } from '@dorkos/shared/bounded-read';
import { parseSkillFile, readRawFrontmatter } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import {
  MISPLACED_SCHEDULE_PERMISSIONS,
  hasMisplacedSchedulePermissions,
} from '@dorkos/shared/schedule-file-problems';
import type { Task, TaskRun } from '@dorkos/shared/types';
import type { TaskStore } from '../task-store.js';
import { readScheduleFromSkill } from '../skills-root-discovery.js';

/** Read fresh bytes: even a clock tick ahead of the watcher must not run them. */
export async function checkMisplacedMode(
  task: Task,
  run: TaskRun,
  store: TaskStore
): Promise<Task> {
  if (run.trigger !== 'manual' && hasMisplacedSchedulePermissions(task))
    throw new Error(MISPLACED_SCHEDULE_PERMISSIONS);
  if (!task.filePath) return task;
  let content: string;
  try {
    content = await readTextFileWithin(task.filePath, PACKAGE_TEXT_MAX_BYTES, 'The SKILL.md');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return task;
    throw new Error('The schedule file could not be read. Open it to check.', { cause });
  }
  const raw = readRawFrontmatter(content);
  if (!raw) throw new Error('The schedule file could not be read. Open it to check.');
  if (raw.data.schedule === undefined || !Object.hasOwn(raw.data, 'permissions')) return task;
  const parsed = parseSkillFile(task.filePath, content, SkillFrontmatterSchema, {
    requireNameMatch: false,
  });
  if (!parsed.ok) throw new Error(MISPLACED_SCHEDULE_PERMISSIONS);
  const found = readScheduleFromSkill(parsed.definition, {
    resolvedPath: task.filePath,
    scope: task.agentId ? 'project' : 'global',
  });
  if (!found) return task;
  const parked = store.fileSync.upsertFromFile(found.def, task.agentId ?? undefined, {
    source: 'discovery',
    problem: MISPLACED_SCHEDULE_PERMISSIONS,
    projectOnly: task.projectOnly === true,
  });
  if (run.trigger !== 'manual') throw new Error(MISPLACED_SCHEDULE_PERMISSIONS);
  // A person may try it once. The misplaced value is never granted.
  return { ...parked, permissionMode: 'acceptEdits' };
}

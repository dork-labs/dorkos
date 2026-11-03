/**
 * The refusals `tasks_update` gives an edit that points a schedule's runs at
 * an account or a model they may not use. Moved out of `task-tools.ts` so the
 * handler stays under the file-length limit; the rules are unchanged.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-run-refusals
 */
import type { Task } from '@dorkos/shared/types';
import type { McpToolDeps } from '../types.js';
import { jsonContent } from '../types.js';
import {
  scheduleAccountRefusal,
  scheduleRunFolder,
} from '../../../../tasks/lifecycle/schedule-account-eligibility.js';
import { scheduleCreditsModelRefusal } from '../../../../tasks/lifecycle/schedule-credits-model.js';

/** The fields of an update these refusals read. */
interface RunFields {
  account?: string | null;
  runtime?: string | null;
  model?: string | null;
}

/**
 * The refusal for an update whose runs would start on an account that may not
 * work in their folder (spec `flow-multiproject` §8.4, the create path's
 * sentence), or on DorkOS credits with a model credits do not serve (DOR-2636,
 * the update route's sentence). `null` when neither applies.
 *
 * @param deps - The tool dependencies.
 * @param existing - The schedule before the edit.
 * @param args - The update's arguments.
 */
export async function updateRunRefusal(
  deps: McpToolDeps,
  existing: Task,
  args: RunFields
): Promise<ReturnType<typeof jsonContent> | null> {
  const folder = () =>
    scheduleRunFolder(existing.agentId ? deps.meshCore?.getProjectPath(existing.agentId) : null);
  if (typeof args.account === 'string') {
    const refusal = await scheduleAccountRefusal({
      account: args.account,
      runtime: args.runtime ?? existing.runtime,
      folder: folder(),
    });
    if (refusal) return jsonContent({ error: refusal.message, code: refusal.code }, true);
  }
  if (args.model !== undefined || args.account !== undefined || args.runtime !== undefined) {
    const modelRefusal = await scheduleCreditsModelRefusal({
      model: args.model !== undefined ? args.model : existing.model,
      account: args.account !== undefined ? args.account : existing.account,
      runtime: args.runtime !== undefined ? args.runtime : existing.runtime,
      folder: folder(),
    });
    if (modelRefusal) return jsonContent({ error: modelRefusal, code: 'UNSUPPORTED_MODEL' }, true);
  }
  return null;
}

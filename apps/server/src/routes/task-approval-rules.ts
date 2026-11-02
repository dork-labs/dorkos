/** Person-only preview of the folder rules a scheduled run can receive. */
import { readManifest } from '@dorkos/shared/manifest';
import type { Task } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';
import { capabilitiesForTaskRuntime } from '../services/tasks/scheduled-run-power.js';
import { readAgentExecutionDefaults } from '../services/session/resolution/resolve-session-defaults.js';
import { readFolderAllowList } from '../services/runtimes/claude-code/folder-settings/agent-folder-allows.js';
import {
  isFolderAllowListApproved,
  lastApprovedRules,
  isFolderAllowListRefused,
} from '../services/runtimes/claude-code/folder-settings/folder-allow-consent.js';

const NONE = { status: 'none', applied: [], pending: [] } as const;

/**
 * Preview the exact approved, filtered folder list, without granting anything.
 * Managed desks cannot be provisioned by a GET, so their launch-time answer is
 * explicitly unavailable. A later file change still goes through launch consent.
 * Call only after the HTTP caller cleared the operator bar: rules are withheld
 * from agent config reads and must not leak through this task read either.
 */
export async function withTaskFolderRules(task: Task, mesh?: MeshCore): Promise<Task> {
  if (task.status !== 'pending_approval') return task;
  const empty = (): Task => ({ ...task, folderRules: { ...NONE, applied: [], pending: [] } });
  const home = task.agentId ? mesh?.getProjectPath(task.agentId) : undefined;
  if (!home || !task.agentId) return empty();
  try {
    const agentRuntime = (await readAgentExecutionDefaults(home)).runtime;
    const profile = capabilitiesForTaskRuntime(
      task.runtime ??
        (agentRuntime && capabilitiesForTaskRuntime(agentRuntime) ? agentRuntime : null)
    );
    if (profile?.type !== 'claude-code') return empty();
    const manifest = await readManifest(home);
    if (manifest && manifest.workspace.mode !== 'home') {
      return { ...task, folderRules: { status: 'unavailable', applied: [], pending: [] } };
    }
    const list = await readFolderAllowList(home);
    if (list.rules.length === 0) return empty();
    const request = { agentId: task.agentId, home, rules: list.rules };
    const previous = lastApprovedRules(task.agentId, home);
    // resolveFolderAllows applies narrowing of a previous yes on launch. This
    // read reports the same answer without writing that new consent record.
    const approved =
      isFolderAllowListApproved(request) ||
      (!isFolderAllowListRefused(request) &&
        previous !== undefined &&
        list.rules.every((rule) => previous.includes(rule)));
    return {
      ...task,
      folderRules: approved
        ? { status: 'approved', applied: list.rules, pending: [] }
        : { status: 'waiting', applied: [], pending: list.rules },
    };
  } catch {
    return { ...task, folderRules: { status: 'unavailable', applied: [], pending: [] } };
  }
}

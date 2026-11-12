/**
 * What a person is asked to approve when an agent sets a scheduled task's mode
 * or approves one (DOR-3703, Security ruling 7), and what the door checks again
 * before it writes.
 *
 * One text, two jobs. The card shows it, so the person reads who asks, the
 * task's name, timing, mode and the start of its prompt, not just an id; the
 * whole prompt is bound by the version line and shown on the task. And the gate binds
 * the approval to it (`change` in the tier gate), so it carries the task's
 * content hash as well: a task rewritten while the card waits is a different
 * text, the person's answer no longer matches, and the door refuses a grant
 * whose text is not the one it computes now.
 *
 * @module services/tasks/agent-mode/agent-mode-change
 */
import path from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/types';
import { agentApprovalBindingOf } from './agent-mode-binding.js';
import { resolveAgentIdForPath, resolveAgentNameForId } from '../../mesh/agent-path-lookup.js';
import type { AgentModeCall, AgentModeDecided } from './agent-mode-decision.js';

/** How much of a prompt the card shows; the version line binds the rest. */
const PROMPT_HEAD = 600;

/** What the card says about the part of a prompt it does not show. */
const FULL_PROMPT_LINE =
  'Full prompt: bound to this approval by the version below, and shown in full on the task.';

/** A prompt's first line or so, flattened, for the card. */
function promptHead(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_HEAD ? `${flat.slice(0, PROMPT_HEAD - 1)}…` : flat;
}

/** The text fields the card reads from a create body, typed loosely as it arrives. */
function read(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/**
 * One card line's value, on one line: a name, a timing or a zone carrying a
 * line break could otherwise draw a fake `Mode:` or `Prompt:` line of its own.
 */
function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

/**
 * The text a person approves for one call, bound to the task as it stands.
 *
 * @param call - The write (an update's task, or a create's body).
 * @param decision - What the decision made of it.
 * @param meshCore - Mesh, for the folder an update's task runs in.
 * @param callerPath - The asking agent's home, when DorkOS can name one.
 */
export function agentModeChangeOf(
  call: Pick<AgentModeCall, 'door' | 'body' | 'task'>,
  decision: Pick<AgentModeDecided, 'mode' | 'previousMode'>,
  meshCore: Pick<MeshCore, 'getProjectPath'> | undefined,
  callerPath: string | undefined
): string {
  const was =
    decision.previousMode && decision.previousMode !== decision.mode
      ? ` (was ${decision.previousMode})`
      : '';
  const view = call.task ? taskView(call.task) : bodyView(call.body);
  const lines = [
    `Asked by: ${callerLabelOf(callerPath)}`,
    `Task: ${view.name}`,
    `Runs as: ${agentLabelOf(call.task ? call.task.agentId : read(call.body, 'target'))}`,
    `Runs: ${view.cron || 'only when started'}${view.timezone ? ` (${view.timezone})` : ''}`,
    `Mode: ${decision.mode}${was}`,
    `Prompt: ${promptHead(view.prompt)}`,
    FULL_PROMPT_LINE,
  ];
  if (call.task) lines.push(`Version: ${bindingOf(call.task, meshCore)}`);
  return lines.join('\n');
}

/** The agent a task runs as, by name when Mesh knows it, for the card. */
function agentLabelOf(agentId: string | null | undefined): string {
  if (!agentId || agentId === 'global') return 'no agent';
  return resolveAgentNameForId(agentId) ?? agentId;
}

/** The agent asking, by name when Mesh knows its home, for the card. */
function callerLabelOf(callerPath: string | undefined): string {
  if (!callerPath) return 'an agent DorkOS cannot name';
  const id = resolveAgentIdForPath(callerPath);
  return (id ? resolveAgentNameForId(id) : undefined) ?? path.basename(callerPath);
}

function taskView(task: Task) {
  return {
    name: oneLine(task.displayName ?? task.name),
    cron: oneLine(task.cron ?? ''),
    timezone: oneLine(task.timezone ?? ''),
    prompt: task.prompt,
  };
}

function bodyView(body: Record<string, unknown>) {
  return {
    name: oneLine(read(body, 'name')),
    cron: oneLine(read(body, 'cron')),
    timezone: oneLine(read(body, 'timezone')),
    prompt: read(body, 'prompt'),
  };
}

function bindingOf(task: Task, meshCore: Pick<MeshCore, 'getProjectPath'> | undefined): string {
  const cwd = task.agentId ? (meshCore?.getProjectPath(task.agentId) ?? null) : null;
  return agentApprovalBindingOf(task, cwd);
}

/**
 * The one-time raise of existing chats to their agent's own level (DOR-3107).
 *
 * Chats started before an agent's Files & commands level was raised kept the
 * mode they were born with, so they kept asking for approval on routine work.
 * This runs once, at startup, and moves each qualifying chat up to its agent's
 * level, never above it, recording every chat's old mode in ONE permission
 * history event whose Undo sets each one back.
 *
 * ## Which chats (Security's rule, strictest reading)
 *
 * A chat is raised only when every one of these holds:
 *
 * - **A person started it in the app** (`launch_origin = 'interactive'`). A
 *   chat's turn marks are not kept past a restart; only the kind of thing that
 *   started it is. Every other origin either can be marked (another chat's
 *   message, an agent's launch, a beat that read a marked post, a room) or was
 *   started from outside the app (a relay, Telegram, a bridged or space room, a
 *   connector, an extension), so its launching turn counts as unknown and the
 *   chat is left alone. So is a chat with no recorded origin.
 * - **It belongs to a registered agent**, other than the agents kept as they are
 *   ({@link KEPT_AS_THEY_ARE}).
 * - **Its agent's level is looser than the chat's mode.** The level is what a
 *   person set for the agent (the person-set floor), else the configured
 *   default, held to the agent's own settings when those are stricter. The
 *   agent's own file can only lower it, never raise it. A chat is never
 *   lowered, and a chat in Plan mode is a person's choice and stays.
 *
 * Schedules are untouched: their mode lives on the schedule, not the chat.
 *
 * ## Once
 *
 * A done file in DorkOS's own data directory, written after the history event,
 * so a later boot never raises a chat a person has lowered again. Nothing runs,
 * and nothing is marked done, while the person-set record is unseeded or broken:
 * its floors cannot be trusted yet, so the next boot tries again.
 *
 * ## Through the settings path
 *
 * Each chat is written through the same session-settings write a person's mode
 * change makes (`ChatModePort.setMode`), and the history event lands in the
 * Activity feed and the audit log like any permission change.
 *
 * @module services/core/permissions/existing-chats-raise
 */
import fs from 'node:fs';
import path from 'node:path';

import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import {
  isNoLooserThan,
  levelOfMode,
  PERMISSION_STOPS,
  resolveStopMode,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import type { AgentPermissions, PermissionChange } from '@dorkos/shared/permissions';
import type { Logger } from '@dorkos/shared/logger';

import type { ActivityService } from '../../activity/activity-service.js';
import { UPGRADE_WRITER, recordPermissionChange } from './permission-history.js';
import type { PermissionAgentRef } from './permission-service.js';

/** The only launch origin whose chats are raised; see the module doc. */
export const RAISED_LAUNCH_ORIGIN = 'interactive';

/**
 * Agents whose chats stay as they are (the PM's standing rule, 2026-10-19), by
 * folder name or by name.
 */
export const KEPT_AS_THEY_ARE: ReadonlySet<string> = new Set(['dorkos-cloud', 'dorkos-marketing']);

/** A chat mode a person chose on purpose and the raise never moves. */
const PLAN_MODE_ID = 'plan';

/** The note the history shows beside the raise. */
export const EXISTING_CHATS_NOTE =
  'Existing chats with your own agents now run at their agent’s level. Chats ' +
  'started from outside the app, by another agent or chat, or in a room were left alone.';

/** One chat's row, as `session_metadata` holds it. */
export interface ExistingChatRow {
  sessionId: string;
  runtime: string | null;
  agentPath: string | null;
  launchOrigin: string | null;
  permissionMode: string | null;
}

/** Reads and writes one chat's stored mode, through the session-settings path. */
export interface ChatModePort {
  /** The chat's stored mode, `null` for none, `'gone'` when there is no such chat. */
  modeOf: (sessionId: string) => string | null | 'gone';
  /**
   * Store a mode for the chat, as a person's mode change does. `null` sets the
   * runtime's own default mode, which is what a chat with no stored mode runs at.
   */
  setMode: (sessionId: string, mode: string | null) => Promise<void>;
}

let chatModePort: ChatModePort | null = null;

/**
 * Set how chat modes are read and written, for the raise and its Undo. Set at
 * startup; `null` (tests) makes every chat read as gone.
 *
 * @param next - The port over the session-settings path.
 */
export function setChatModePort(next: ChatModePort | null): void {
  chatModePort = next;
}

/**
 * A chat's stored mode now, for an Undo's compare-and-set.
 *
 * @param sessionId - The chat.
 */
export function chatModeNow(sessionId: string): string | null | 'gone' {
  return chatModePort ? chatModePort.modeOf(sessionId) : 'gone';
}

/**
 * Set chats back to the mode each change recorded as `before`, for an Undo.
 * Each chat is written on its own; one that fails is logged by the caller's
 * catch and left out of what the Undo records.
 *
 * @param changes - The `chat` changes to set back, already checked by the Undo.
 * @returns The changes the Undo made, current → restored.
 */
export async function setChatsBack(
  changes: readonly PermissionChange[]
): Promise<PermissionChange[]> {
  const made: PermissionChange[] = [];
  if (!chatModePort) return made;
  for (const change of changes) {
    if (change.key.kind !== 'chat') continue;
    const current = chatModePort.modeOf(change.key.sessionId);
    if (current === 'gone') continue;
    await chatModePort.setMode(change.key.sessionId, change.before);
    made.push({ ...change, before: current, after: change.before });
  }
  return made;
}

/** Everything the raise reads and writes through. */
export interface ExistingChatsRaiseDeps {
  /** The done file, inside DorkOS's data directory. */
  doneFile: string;
  /** Every chat's row. */
  chats: () => ExistingChatRow[];
  /** The registered agents. */
  agents: () => PermissionAgentRef[];
  /** What a person set for each agent. */
  personSet: { isSeeded: () => boolean; get: (agentId: string) => AgentPermissions | undefined };
  /** The configured default stop for a runtime (per-runtime, then global), or `null`. */
  defaultStop: (runtime: string) => PermissionStop | null;
  /** The agent's own Files & commands stop, as the permission gate reads it. */
  agentStop: (agentPath: string) => Promise<PermissionStop | undefined>;
  /** A runtime's declared modes, or `undefined` for a runtime this server lacks. */
  modes: (runtime: string) => DeclaredModes | undefined;
  /** Where each chat's mode is written. */
  port: ChatModePort;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'>;
  /** Where the outcome and any failure are reported. */
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
}

/** What the raise did. */
export interface ExistingChatsRaiseResult {
  /** The chats it raised. */
  raised: number;
}

/** The stricter of two stops. */
function stricterStop(a: PermissionStop, b: PermissionStop): PermissionStop {
  return PERMISSION_STOPS.indexOf(a) <= PERMISSION_STOPS.indexOf(b) ? a : b;
}

/** Whether an agent is one whose chats stay as they are. */
function isKept(agent: PermissionAgentRef): boolean {
  const names = [path.basename(agent.projectPath), agent.name, agent.displayName ?? ''];
  return names.some((n) => KEPT_AS_THEY_ARE.has(n.trim().toLowerCase().replace(/\s+/g, '-')));
}

/** The agent's level as a stop: what a person set, else the default, held to its own file. */
async function agentLevel(
  deps: ExistingChatsRaiseDeps,
  agent: PermissionAgentRef,
  runtime: string
): Promise<PermissionStop | null> {
  const floor = deps.personSet.get(agent.id)?.filesAndCommands ?? deps.defaultStop(runtime);
  if (!floor) return null;
  const own = await deps.agentStop(agent.projectPath);
  return own ? stricterStop(floor, own) : floor;
}

/**
 * The mode one chat is raised to, or `null` when it stays as it is.
 *
 * @param deps - The raise's dependencies.
 * @param row - The chat.
 * @param agents - Every registered agent, by folder.
 */
async function raisedModeFor(
  deps: ExistingChatsRaiseDeps,
  row: ExistingChatRow,
  agents: ReadonlyMap<string, PermissionAgentRef>
): Promise<{ agent: PermissionAgentRef; mode: string } | null> {
  if (row.launchOrigin !== RAISED_LAUNCH_ORIGIN || !row.runtime || !row.agentPath) return null;
  if (row.permissionMode === PLAN_MODE_ID) return null;
  const agent = agents.get(row.agentPath);
  if (!agent || isKept(agent)) return null;
  const declared = deps.modes(row.runtime);
  if (!declared) return null;
  const stop = await agentLevel(deps, agent, row.runtime);
  const mode = resolveStopMode(stop, declared.values);
  const target = levelOfMode(declared, mode);
  const current = levelOfMode(declared, row.permissionMode ?? declared.default);
  if (!mode || !target || !current) return null;
  // Only ever up: a target no looser than what the chat has leaves it alone.
  if (isNoLooserThan(current, target)) return null;
  return { agent, mode };
}

/** Whether the raise already ran on this install. */
function isDone(doneFile: string): boolean {
  return fs.existsSync(doneFile);
}

/** Write the done file, atomically. */
function markDone(doneFile: string, raised: number): void {
  fs.mkdirSync(path.dirname(doneFile), { recursive: true });
  const tmp = `${doneFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, doneAt: new Date().toISOString(), raised }));
  fs.renameSync(tmp, doneFile);
}

/**
 * Raise every qualifying existing chat to its agent's level, once per install.
 *
 * @param deps - The chats, agents, levels, settings path, Activity writer and logger.
 * @returns What it raised, or `null` when it did not run (already done, or the
 *   person-set record cannot be trusted yet).
 */
export async function raiseExistingChats(
  deps: ExistingChatsRaiseDeps
): Promise<ExistingChatsRaiseResult | null> {
  if (isDone(deps.doneFile)) return null;
  if (!deps.personSet.isSeeded()) {
    deps.logger.warn(
      '[Permissions] Existing chats were not raised: what a person set for each agent is not readable yet. Trying again next start.'
    );
    return null;
  }
  const agents = new Map(deps.agents().map((a) => [a.projectPath, a]));
  const changes: PermissionChange[] = [];
  for (const row of deps.chats()) {
    try {
      const raise = await raisedModeFor(deps, row, agents);
      if (!raise) continue;
      await deps.port.setMode(row.sessionId, raise.mode);
      changes.push({
        target: {
          kind: 'agent',
          agentId: raise.agent.id,
          agentPath: raise.agent.projectPath,
          agentName: raise.agent.displayName || raise.agent.name,
        },
        key: { kind: 'chat', sessionId: row.sessionId },
        before: row.permissionMode,
        after: raise.mode,
      });
    } catch (err) {
      deps.logger.warn('[Permissions] could not raise one existing chat; it keeps its mode', {
        sessionId: row.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    await recordPermissionChange(deps.activity, {
      changes,
      surface: 'upgrade',
      writer: UPGRADE_WRITER,
      note: EXISTING_CHATS_NOTE,
    });
  } catch (err) {
    // A raise with no history line could not be undone, so it is put back and
    // tried again next start.
    deps.logger.error(
      '[Permissions] could not record the raise of existing chats; setting them back',
      {
        err: err instanceof Error ? err.message : String(err),
      }
    );
    for (const change of changes) {
      if (change.key.kind !== 'chat') continue;
      await deps.port.setMode(change.key.sessionId, change.before).catch(() => undefined);
    }
    return null;
  }
  markDone(deps.doneFile, changes.length);
  if (changes.length > 0) {
    deps.logger.info('[Permissions] raised existing chats to their agent’s level', {
      raised: changes.length,
    });
  }
  return { raised: changes.length };
}

/**
 * The one-time raise of existing chats to their agent's own level (DOR-3107).
 *
 * Chats started before an agent's Files & commands level was raised kept the
 * mode they were born with, so they kept asking for approval on routine work.
 * This runs once, at startup, and moves each qualifying chat up to its agent's
 * level, never above it, recording every chat's old mode in ONE permission
 * history event whose Undo sets each one back.
 *
 * ## Which chats (Security's rule, Dorian 2026-10-19 15:07: unknown means raise)
 *
 * A chat is raised only when every one of these holds:
 *
 * - **Nothing outside started it, and its launching turn was not marked.** A
 *   chat's own turn marks are not kept past a restart, so the launch is read
 *   from what is kept ({@link ExistingChatsRaiseDeps.launchMarked}, which is
 *   `chat-launch-marks.ts` in production): only our own origins
 *   ({@link RAISED_LAUNCH_ORIGINS}, or none recorded) qualify, and of those a
 *   chat another chat's message or `session_start` opened is left alone when
 *   the opening row carries a mark (on its level, or beside an unknown sender's
 *   runtime default) or came from an outside chat, an agent launch
 *   with no starting chat (the external `/mcp` server, unverified) is left
 *   alone, a room chat is raised only in a room of this computer with no
 *   bridge, no space copy and no marked, outside or Wi-Fi-held post, and a chat
 *   a person opened is left alone when a Wi-Fi sign-in was live as it was
 *   made. Everything else that is unknown is raised. Schedules are never
 *   raised (their mode lives on the schedule), nor is a chat on another
 *   computer (`computer-local`).
 * - **It belongs to a registered agent**, other than the agents kept as they are
 *   ({@link KEPT_AS_THEY_ARE}).
 * - **Its agent's level is looser than the chat's mode.** The level is what a
 *   person set for the agent (the person-set floor), else the configured
 *   default, held to the agent's own settings when those are stricter. The
 *   agent's own file can only lower it, never raise it. A chat is never
 *   lowered, and a chat in Plan, or in any mode at Ask other than the
 *   runtime's default (Claude Code's Never ask), is a person's choice and stays.
 *
 * Schedules are untouched: their mode lives on the schedule, not the chat.
 *
 * ## The second raise: spin-off chats (DOR-3147)
 *
 * Until DOR-3147 a chat at Full autonomy could not pass Full on to a chat it
 * started without naming it, so agents started their chats lower, after the
 * first raise had already run. The same raise runs once more, under its own
 * note and done file, for chats an agent started (`session_start`,
 * {@link SPIN_OFF_ORIGINS}) and only those, by every rule above.
 *
 * ## Once
 *
 * The history event is written first, then a done file in DorkOS's own data
 * directory, and only then is any chat changed. Either one marks the raise as
 * done, so a later boot never raises a chat a person has lowered again, and no
 * chat is ever raised without a history line to undo it from. A chat whose
 * write then fails keeps its mode, and its Undo finds it already back. Nothing
 * runs while the person-set record is unseeded or broken: its floors cannot be
 * trusted yet, so the next boot tries again.
 *
 * ## Through the settings path
 *
 * Each chat is written through the same session-settings write a person's mode
 * change makes (`ChatModePort.setMode`), and the history event lands in the
 * Activity feed, which the audit log copies (`audit/activity-tee.ts`), like any
 * permission change.
 *
 * ## Undo
 *
 * An Undo only ever lowers a chat: setting one back to a looser mode (the Undo
 * of an Undo) is refused per chat, since the agent's level may have dropped
 * since. A chat that cannot be written is reported as skipped, never a reason
 * to fail the rest.
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
import type {
  AgentPermissions,
  PermissionChange,
  PermissionUndoSkip,
} from '@dorkos/shared/permissions';
import type { Logger } from '@dorkos/shared/logger';

import type { ActivityService } from '../../activity/activity-service.js';
import { hasMarks, NO_MARKS, parseStoredMarks, type TurnMarks } from '../turn-power/turn-marks.js';
import { UPGRADE_WRITER, recordPermissionChange } from './permission-history.js';
import type { PermissionAgentRef } from './permission-service.js';

/**
 * The launch origins whose chats may be raised; see the module doc. `chat-message`
 * and `room` are further read by {@link ExistingChatsRaiseDeps.launchMarked}.
 */
export const RAISED_LAUNCH_ORIGINS: ReadonlySet<string> = new Set([
  'interactive',
  'agent-launch',
  'heartbeat',
  'chat-message',
  'room',
  'account-handoff',
  'account-resume',
]);

/**
 * Agents whose chats stay as they are (the PM's standing rule, 2026-10-19), by
 * folder name or by name.
 */
export const KEPT_AS_THEY_ARE: ReadonlySet<string> = new Set(['dorkos-cloud', 'dorkos-marketing']);

/**
 * Whether a launch origin is one of our own (or unknown), whose chat may follow
 * its agent's level: {@link RAISED_LAUNCH_ORIGINS}, or none recorded.
 *
 * @param origin - `session_metadata.launch_origin`, or null.
 */
export function isOwnLaunchOrigin(origin: string | null): boolean {
  return origin === null || RAISED_LAUNCH_ORIGINS.has(origin);
}

/** A chat mode a person chose on purpose and the raise never moves. */
const PLAN_MODE_ID = 'plan';

/** Chats on another computer, which this one cannot vouch for. */
const COMPUTER_LOCAL_RUNTIME = 'computer-local';

/** The note the history shows beside the raise. */
export const EXISTING_CHATS_NOTE =
  'Existing chats with your own agents now run at their agent’s level. Chats started ' +
  'from outside, or from a turn that read outside content, were left alone.';

/** The note the history shows beside the raise of spin-off chats (DOR-3147). */
export const SPIN_OFF_CHATS_NOTE =
  'Chats your agents started now run at their agent’s level. Chats started from ' +
  'outside, or from a turn that read outside content, were left alone.';

/** The launch origin of a chat an agent started with `session_start`: a spin-off. */
export const SPIN_OFF_ORIGINS: ReadonlySet<string> = new Set(['agent-launch']);

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
  /** Whether `candidate` is a looser mode than `than` on the chat's runtime. Unknown is looser. */
  isLooser: (sessionId: string, candidate: string | null, than: string | null) => Promise<boolean>;
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
 * Only ever lowers: a chat the Undo would loosen is left as it is (`floor`),
 * since its agent's level may have dropped since. Each chat is written on its
 * own; one that is gone or cannot be written is reported, never thrown.
 *
 * @param changes - The `chat` changes to set back, already checked by the Undo.
 * @returns The changes the Undo made (current → restored), and the ones it left.
 */
export async function setChatsBack(changes: readonly PermissionChange[]): Promise<{
  made: PermissionChange[];
  skipped: PermissionUndoSkip[];
}> {
  const made: PermissionChange[] = [];
  const skipped: PermissionUndoSkip[] = [];
  for (const change of changes) {
    if (change.key.kind !== 'chat') continue;
    const sessionId = change.key.sessionId;
    try {
      const current = chatModePort ? chatModePort.modeOf(sessionId) : 'gone';
      if (!chatModePort || current === 'gone') {
        skipped.push({ change, current: null, reason: 'gone' });
        continue;
      }
      if (await chatModePort.isLooser(sessionId, change.before, current)) {
        skipped.push({ change, current, reason: 'floor' });
        continue;
      }
      await chatModePort.setMode(sessionId, change.before);
      made.push({ ...change, before: current, after: change.before });
    } catch {
      skipped.push({ change, current: null, reason: 'gone' });
    }
  }
  return { made, skipped };
}

/** Whether a stored value is a plain object (a level, or a marked runtime default). */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The marks one stored bound carries: a level's own mark fields, or the
 * `marks` of `{"bound":"runtime-default","marks":{...}}` (what
 * `senderCeilingJson` stores for an unknown-but-marked sender). The runtime
 * default alone, and anything that is not an object, carries none.
 */
function storedBoundMarks(bound: unknown): TurnMarks {
  if (!isObject(bound)) return NO_MARKS;
  const fields = 'marks' in bound ? bound.marks : bound;
  return isObject(fields) ? parseStoredMarks(JSON.stringify(fields)) : NO_MARKS;
}

/**
 * Whether a chat message's stored sender bound carries a mark: an outsider's
 * words or a teammate's chain, on the level itself, on any of the bounds a list
 * holds (`[level, cap]`, the shape #3107 stores for a marked sender), or on a
 * runtime default stored with its marks (`{"bound":"runtime-default","marks":
 * {...}}`, #3107's shape for a sender whose level is unknown but which a
 * stranger reached). The runtime default alone or with empty marks, a level
 * with no marks, an unreadable value or no message at all is unknown or
 * unmarked, and raises.
 *
 * Deliberately not `isMarkedBound` (`chat-message-ceiling.ts`), which reads the
 * runtime default as marked: a row written before #3107's marked shape, by a
 * sender whose level was unknown, stored exactly that, and unknown means raise.
 * A marked unknown sender's row says so in its `marks`, however many boots the
 * raise is put off.
 *
 * @param ceilingJson - The opening message's `ceiling_json`, or `undefined` for none.
 */
export function openingMessageMarked(ceilingJson: string | undefined): boolean {
  if (ceilingJson === undefined) return false;
  let value: unknown;
  try {
    value = JSON.parse(ceilingJson);
  } catch {
    return false;
  }
  const bounds = Array.isArray(value) ? value : [value];
  return bounds.some((bound) => hasMarks(storedBoundMarks(bound)));
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
  /**
   * Whether what launched the chat was marked or came from outside, read from
   * what is kept: the opening chat message's sender level, or the room's
   * bridge, space copy and post marks. Unknown is not marked.
   */
  launchMarked: (row: ExistingChatRow) => boolean;
  /** The agent's own Files & commands stop, as the permission gate reads it. */
  agentStop: (agentPath: string) => Promise<PermissionStop | undefined>;
  /** A runtime's declared modes, or `undefined` for a runtime this server lacks. */
  modes: (runtime: string) => DeclaredModes | undefined;
  /** Where each chat's mode is written. */
  port: ChatModePort;
  /** The Activity writer. */
  activity: Pick<ActivityService, 'emit'>;
  /** Whether the history already holds this raise: done, even without the done file. */
  priorRaise: () => Promise<boolean>;
  /** The note this raise's history event carries, which marks it as done; {@link EXISTING_CHATS_NOTE} by default. */
  note?: string;
  /** Only chats with one of these launch origins; every own origin by default. */
  origins?: ReadonlySet<string>;
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
 * Whether a chat's mode is one a person picks on purpose rather than lands on:
 * Plan, or a mode at the Ask stop other than the runtime's default (Claude
 * Code's Never ask, which refuses what is not allowed instead of asking).
 */
function isChosenMode(declared: DeclaredModes, modeId: string): boolean {
  if (modeId === PLAN_MODE_ID) return true;
  const mode = declared.values.find((m) => m.id === modeId);
  return mode !== undefined && mode.stop === 'ask' && modeId !== declared.default;
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
): Promise<{ agent: PermissionAgentRef; mode: string; before: string } | null> {
  if (!row.runtime || !row.agentPath) return null;
  if (!isOwnLaunchOrigin(row.launchOrigin)) return null;
  if (deps.origins && (row.launchOrigin === null || !deps.origins.has(row.launchOrigin))) {
    return null;
  }
  if (deps.launchMarked(row)) return null;
  if (row.runtime === COMPUTER_LOCAL_RUNTIME) return null;
  const agent = agents.get(row.agentPath);
  if (!agent || isKept(agent)) return null;
  const declared = deps.modes(row.runtime);
  if (!declared) return null;
  const before = row.permissionMode ?? declared.default;
  if (!before || isChosenMode(declared, before)) return null;
  const stop = await agentLevel(deps, agent, row.runtime);
  const mode = resolveStopMode(stop, declared.values);
  const target = levelOfMode(declared, mode);
  const current = levelOfMode(declared, before);
  if (!mode || !target || !current) return null;
  // Only ever up: a target no looser than what the chat has leaves it alone.
  if (isNoLooserThan(current, target)) return null;
  return { agent, mode, before };
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
  if (isDone(deps.doneFile) || (await deps.priorRaise())) return null;
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
      changes.push({
        target: {
          kind: 'agent',
          agentId: raise.agent.id,
          agentPath: raise.agent.projectPath,
          agentName: raise.agent.displayName || raise.agent.name,
        },
        key: { kind: 'chat', sessionId: row.sessionId },
        before: raise.before,
        after: raise.mode,
      });
    } catch (err) {
      deps.logger.warn('[Permissions] could not read one existing chat; it keeps its mode', {
        sessionId: row.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // History first, then the done file, then the chats: no chat is raised
  // without a line to undo it from, and a failed done file still leaves the
  // line that marks the raise as done.
  try {
    await recordPermissionChange(deps.activity, {
      changes,
      surface: 'upgrade',
      writer: UPGRADE_WRITER,
      note: deps.note ?? EXISTING_CHATS_NOTE,
    });
    markDone(deps.doneFile, changes.length);
  } catch (err) {
    deps.logger.error('[Permissions] could not record the raise of existing chats; none changed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  let raised = 0;
  for (const change of changes) {
    if (change.key.kind !== 'chat' || change.after === null) continue;
    try {
      await deps.port.setMode(change.key.sessionId, change.after);
      raised += 1;
    } catch (err) {
      deps.logger.warn('[Permissions] could not raise one existing chat; it keeps its mode', {
        sessionId: change.key.sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (raised > 0) {
    deps.logger.info('[Permissions] raised existing chats to their agent’s level', { raised });
  }
  return { raised };
}

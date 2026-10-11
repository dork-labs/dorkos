/** Persistent-pump DATA contracts and pure receipt/content builders. */
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { renderContextEntry } from '../../messaging/context-builder.js';
import type { AgentSession } from '../../agent-types.js';
import type { MessageSenderOpts } from '../../messaging/message-sender-shared.js';
import type { SessionPump } from '../session-pump.js';
import type { SessionTurnWindows } from '../session-turn-windows.js';
import type { SessionCrashRecovery } from '../session-crash-recovery.js';
import type { LaunchFingerprint } from '../launch-fingerprint.js';
import type { PumpLaunchPlan } from '../warm-process/pump-launch.js';
import type { PluginReloadCacheImpact } from '../../messaging/plugin-reload-policy.js';

/** One session's pump, its windower, and its crash policy, wired together. */
export interface SessionBundle {
  pump: SessionPump;
  windows: SessionTurnWindows;
  recovery: SessionCrashRecovery;
  /**
   * The running process's query, or `undefined` when this session holds none.
   *
   * Held here rather than on the session, because `session.activeQuery` means
   * something narrower — see {@link SessionBundle.fingerprint}'s neighbour in
   * `acquire`, where the two are kept apart.
   */
  live: Query | undefined;
  /** What the live process was launched with; `undefined` until one boots. */
  fingerprint: LaunchFingerprint | undefined;
  /** The plan of the dispatch currently in flight, read by the launcher. */
  plan: PumpLaunchPlan | undefined;
  /**
   * True while a turn is BOOTING on this session — the launch is in flight and
   * the pump has not yet reached its `running` edge, so `session.activeQuery` is
   * not armed. This is the one window where a Stop cannot reach the turn through
   * the ordinary path, so {@link PersistentDispatch.bootingQuery} exposes
   * {@link SessionBundle.live} to it (DOR-1191). Distinct from a merely-warm
   * idle process, which is never booting a turn and must never be interrupted.
   */
  booting: boolean;
  /**
   * True when the process this bundle last lost was closed by a DorkOS Stop
   * rather than lost to a crash — the same answer that rides
   * {@link PumpCrash.stopRequested}, kept here for the one reader that arrives
   * AFTER the crash seam has already cleared everything it could be re-derived
   * from (DOR-1302).
   *
   * That reader is {@link PersistentDispatch.explainRefusedDispatch}. A Stop
   * during a turn's LAUNCH kills the process before `system/init`, so the
   * dispatch that was waiting on it is refused rather than streamed — and by
   * then {@link SessionBundle.live} is cleared, `session.activeQuery` was never
   * armed (no `running` edge fired), and `session.lastQuery` names some earlier
   * turn's query if it names anything. A flag is the only carrier left.
   *
   * Reset at the start of every dispatch, so it describes THIS launch and never
   * a Stop two turns ago.
   */
  closedByStop: boolean;
  /**
   * Every background `task_type` the running process has reported, so each is
   * logged once per process ({@link noteTaskTypes}). Which types a Monitor or a
   * future task kind carries is not verified against a real CLI, and a real
   * session's log is where that answer comes from (spec `warm-process-lifecycle`
   * D1). Emptied when the process dies; a replacement process gets a fresh bundle.
   */
  seenTaskTypes: Set<string>;
  /**
   * The busy spell (its `busySince`) this process was already warned about for
   * holding a stale tool list past the four-hour ceiling, so the warning is
   * said once rather than on every message (DOR-2685). A replacement process
   * gets a fresh bundle.
   */
  staleToolListWarnedFor?: number;
  /**
   * True while this process holds background work, mirroring its durable
   * record in `background-work.json` (DOR-2065), so ending the process can
   * tell whether there is a record to clear without reading the file.
   */
  heldWork?: boolean;
  /**
   * The person chose Switch now (DOR-2065): the next restart this session
   * decides goes ahead although background work is still running. Consumed by
   * the next dispatch, whatever it decides.
   */
  switchRequested?: boolean;
  /**
   * A message on this session was held for this process's background work
   * and has not run since — what makes Switch now mean anything (DOR-2065).
   */
  holdOutstanding?: boolean;
}

/** What one dispatch needs beyond the session itself. */
export interface PersistentDispatchArgs {
  sessionId: string;
  content: string;
  session: AgentSession;
  opts: MessageSenderOpts;
  messageOpts?: MessageOpts;
}

/**
 * Turn a failure that happened before any output into the same terminal pair a
 * turn error always produces, so the projector settles rather than pinning
 * `streaming` on a turn that never ran.
 */
export function* terminalFailure(
  sessionId: string,
  message: string,
  details?: string
): Generator<StreamEvent> {
  yield {
    type: 'error',
    data: {
      message,
      category: 'execution_error',
      ...(details !== undefined ? { details } : {}),
    },
  };
  yield { type: 'done', data: { sessionId } };
}

export { waitingOnFor } from '../warm-process/pump-launch.js';

/** Assemble delivered context without consuming a stream or changing pump state. */
export function enrichDeliveredContent(
  content: string,
  additionalContext?: AdditionalContext
): string {
  const contextBlocks = (additionalContext ?? []).map(renderContextEntry).filter(Boolean);
  if (contextBlocks.length === 0) return content;
  return `${contextBlocks.join('\n\n')}\n\n${content}`;
}

/** Classify a frame without reading or changing its stream. */
export function carriesContent(message: SDKMessage): boolean {
  return message.type !== 'result' && message.type !== 'system';
}

/** Original held-plugin receipt callback DATA signature; cannot install pump custody. */
export type PluginReloadHeld = (
  sessionId: string,
  impact: PluginReloadCacheImpact,
  contextTokens: number | undefined
) => void;

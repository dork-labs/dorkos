/**
 * An OpenCode agent's heavy shell job waits its turn while the computer is busy (DOR-4209), in the
 * same machine-wide line as every other agent's (`core/load-gate/`).
 *
 * **Where it holds.** The sidecar asks DorkOS before every `bash` call, at every level, Full
 * included (`permission.asked`, answered in `approvals.ts`), and the call does not run until that
 * ask is answered. A heavy command's ask waits here first; then the ask goes to the normal decision
 * in `approvals.ts`, unchanged: the protected-file check, the installed packages' shell guards, the
 * folder grants, the level's auto-approve, or a person's card. The wait sits outside all of them,
 * so the shell guards' own time limit (`PACKAGE_HOOK_TIMEOUT_MS`) never counts the time in line.
 * A light command's ask goes straight to the decision, as before.
 *
 * **It holds, it never decides.** Nothing here answers the sidecar. However the wait ends (its
 * turn, a let-through, the hard cap, a gate failure, a Stop), the normal decision runs next and is
 * the only thing that answers. After a Stop that means the decision answers an ask on a turn being
 * aborted, as it would have without the gate; what keeps that reply from running anything is the
 * sidecar's own abort of the session (`interruptQuery` sends it right after the stop), not this
 * module. Nothing in this repo shows the sidecar refusing such a reply, so that is not claimed.
 *
 * **The turn's event stream waits with it.** The approval pass is a generator over the turn's
 * events, so while a `bash` ask waits, the turn's later events wait behind it. That is the same
 * place the shell guards already run, and the call itself is blocked on the ask anyway. The wait's
 * status line is yielded from here, once when it starts and about every minute after.
 *
 * **A chat never waits behind its own slot.** The end that gives a slot back (`tool_call_end`)
 * rides this same stream, so a second heavy call waiting for the slot its own chat holds would wait
 * for an end queued behind itself, until the hard cap, holding every heavy job on the computer. So
 * every ask of a turn waits under one share key ({@link openCodeShareKey}): a heavy call from a
 * chat that holds a slot gets a share of it at once from the gate (`chat-turns.ts`), and the slot
 * goes back when the last share does. A helper's ask uses the parent's key for the same reason;
 * this is where OpenCode differs from Claude Code, whose helpers each wait their own turn. A
 * chat's asks reach this one at a time, so two of its calls never wait in line together.
 *
 * **When the slot is given back.** When the call ends (its `tool_call_end`, finished or failed), when
 * the decision refuses it, when a card is raised for it (a person approving is already a gate, and a
 * card can wait for hours: after a yes it runs straight away, outside the line), and when the turn
 * ends, however it ends: the runtime clears the session's approvals at teardown, and the slots with
 * them ({@link HeavyShellSlots.endSession}). A sidecar that dies ends its turns' streams, and so their
 * slots. Two cases give the slot back as the decision starts, because the call's end cannot be seen:
 * an ask from a helper's own session (its tool calls never reach this stream as calls), and an ask
 * that does not name its tool call: each gives its share back, and a slot its chat's other calls
 * still share stays with them.
 *
 * **Not covered.** A sidecar that dies while an ask waits in line is not seen until the wait ends:
 * the ask keeps its place, and gives it up as soon as its turn comes and its answer fails. Whether
 * the sidecar gives up on an ask held for a long time is not settled: its 1.19.3 types give a
 * permission no expiry, and nobody has held one live for hours (`approvals.ts` says the same of a
 * card left unanswered). If it does, the answer after the wait meets a dropped ask and fails, which
 * is the normal decision's own failure path.
 *
 * Nothing here logs or shows command text: the program's name and counts only.
 *
 * @module services/runtimes/opencode/messaging/load-gate-hold
 */
import type { ApprovalEvent, StreamEvent } from '@dorkos/shared/types';
import type { HeldSlot } from '../../../core/load-gate/load-gate.js';
import {
  waitForHeavyTurn,
  wouldHold,
  type RuntimeWaitDeps,
} from '../../../core/load-gate/runtime-wait.js';
import type { OpenCodePermissionState } from '../events/session-event-mapper.js';

/** The one permission a heavy command can be held at. */
const SHELL_PERMISSION = 'bash';

/**
 * The share key every `bash` ask of one turn waits under, its helpers' included: they all reach
 * this one event stream, so a helper's ask waiting behind its parent's slot would wait for an end
 * queued behind itself. Claude Code gives each helper its own key because each runs its own hooks.
 *
 * @param sessionId - The DorkOS session.
 */
export const openCodeShareKey = (sessionId: string): string => `opencode:${sessionId}:main`;

/**
 * Each running heavy `bash` call's share of its chat's slot, by DorkOS session and tool call id.
 * The gate counts the shares (`chat-turns.ts`): the slot goes back when the last one does.
 */
export class HeavyShellSlots {
  private readonly held = new Map<string, Map<string, HeldSlot>>();

  /**
   * Keep a call's share until the call ends.
   *
   * @param sessionId - The DorkOS session.
   * @param callId - The tool call the share is for.
   * @param slot - The share.
   */
  keep(sessionId: string, callId: string, slot: HeldSlot): void {
    let forSession = this.held.get(sessionId);
    if (!forSession) {
      forSession = new Map();
      this.held.set(sessionId, forSession);
    }
    // The same call held twice: the older share is nobody's now.
    forSession.get(callId)?.release();
    forSession.set(callId, slot);
  }

  /**
   * A call ended, ran or not: give its share back. Nothing happens for a call holding none.
   *
   * @param sessionId - The DorkOS session.
   * @param callId - The tool call.
   */
  finish(sessionId: string, callId: string): void {
    const forSession = this.held.get(sessionId);
    const slot = forSession?.get(callId);
    if (!forSession || !slot) return;
    forSession.delete(callId);
    if (forSession.size === 0) this.held.delete(sessionId);
    slot.release();
  }

  /**
   * The session's turn ended: give back every share it still holds.
   *
   * @param sessionId - The DorkOS session.
   */
  endSession(sessionId: string): void {
    const forSession = this.held.get(sessionId);
    this.held.delete(sessionId);
    for (const slot of forSession?.values() ?? []) slot.release();
  }
}

/** What a held ask reads of its turn. */
export interface HeldShellTurn {
  /** The DorkOS session. */
  readonly sessionId: string;
  /** The turn's own OpenCode session: a call asked anywhere else is a helper's. */
  readonly ocSessionId: string;
  /** Which session asked, and which tool call each ask is for. */
  readonly permissions: OpenCodePermissionState;
  /** Stops the wait when the turn is stopped. */
  readonly signal?: AbortSignal;
}

/** One `bash` ask on its way to the normal decision. */
export interface HeldShellAsk {
  /** The turn the ask came in. */
  readonly turn: HeldShellTurn;
  /** The mapped ask: its permission id, its tool, and the command it names. */
  readonly approval: ApprovalEvent;
  /** Where its slot is kept while its call runs. */
  readonly slots: HeavyShellSlots;
  /** The gate, the settings and the log; the server's own by default. */
  readonly deps?: RuntimeWaitDeps;
}

/** The command a `bash` ask names (its `metadata.command`), the way the shell guards read it. */
function commandOf(approval: ApprovalEvent): string | undefined {
  try {
    const command = (JSON.parse(approval.input) as { command?: unknown }).command;
    return typeof command === 'string' ? command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wait in line, yielding the chat's status line as the wait goes, and return the slot (or `null`).
 * Stopped early by its consumer, it leaves the line, and gives back a slot it never handed over.
 */
async function* waitInLine(
  ask: HeldShellAsk,
  command: string
): AsyncGenerator<StreamEvent, HeldSlot | null> {
  const stop = new AbortController();
  const notices: StreamEvent[] = [];
  const wait: { wake?: () => void; result?: { slot: HeldSlot | null }; handed: boolean } = {
    handed: false,
  };
  const signals = ask.turn.signal ? [ask.turn.signal, stop.signal] : [stop.signal];
  const waited = waitForHeavyTurn(
    {
      command,
      owner: { chatId: ask.turn.sessionId },
      shareKey: openCodeShareKey(ask.turn.sessionId),
      signal: AbortSignal.any(signals),
      notify: (event) => {
        notices.push(event);
        wait.wake?.();
      },
    },
    ask.deps
  ).then((slot) => {
    wait.result = { slot };
    wait.wake?.();
  });
  try {
    for (;;) {
      // Only the newest line matters: the app shows it in place of the last.
      const newest = notices.splice(0).at(-1);
      if (newest) {
        yield newest;
        continue;
      }
      if (wait.result) {
        wait.handed = true;
        return wait.result.slot;
      }
      await new Promise<void>((resolve) => (wait.wake = resolve));
      delete wait.wake;
    }
  } finally {
    if (!wait.handed) {
      stop.abort();
      void waited.then(() => wait.result?.slot?.release());
    }
  }
}

/** Whether `event` settles the ask with id `askId` without running it here: a card, or a refusal. */
function settlesAsk(event: StreamEvent, askId: string): boolean {
  if (event.type !== 'approval_required' && event.type !== 'permission_denied') return false;
  return (event.data as { toolCallId?: unknown }).toolCallId === askId;
}

/**
 * Hold a heavy `bash` ask until its turn, then hand it to `decide`, the normal decision, and pass on
 * everything it yields. Anything else goes straight to `decide`.
 *
 * @param ask - The ask, its turn, and where its slot is kept.
 * @param decide - The normal decision for this ask, run exactly once whatever the wait did.
 */
export async function* holdHeavyShell(
  ask: HeldShellAsk,
  decide: () => AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const { turn, approval, slots } = ask;
  const command = approval.toolName === SHELL_PERMISSION ? commandOf(approval) : undefined;
  if (command === undefined || !wouldHold(command, ask.deps)) {
    yield* decide();
    return;
  }
  const askedIn = turn.permissions.pendingPermissionSessions.get(approval.toolCallId);
  const callId =
    askedIn === undefined || askedIn === turn.ocSessionId
      ? turn.permissions.permissionCallIds?.get(approval.toolCallId)
      : undefined;
  // A chat holding a slot shares it at once (the share key), so this never waits behind its own.
  const slot = yield* waitInLine(ask, command);
  if (slot === null || callId === undefined) {
    // Nothing to keep, or no way to see the call end: it runs outside the line.
    slot?.release();
    yield* decide();
    return;
  }
  slots.keep(turn.sessionId, callId, slot);
  let decided = false;
  try {
    for await (const event of decide()) {
      if (settlesAsk(event, approval.toolCallId)) slots.finish(turn.sessionId, callId);
      yield event;
    }
    decided = true;
  } finally {
    // The decision threw, or the turn stopped reading: the slot is nobody's now.
    if (!decided) slots.finish(turn.sessionId, callId);
  }
}

import { readOriginalTestModeInteractionsView } from '../test-mode-runtime.js';
import type {
  DeliverIntoTurnOpts,
  RuntimeDeliveryResult,
  SessionWarmth,
  InteractionAnswerOptions,
  ToolDecisionOptions,
} from '@dorkos/shared/agent-runtime';
import type { InterruptReceipt } from '@dorkos/shared/types';
import { peekProjector } from '../../../session/session-state-projector.js';
import { heldProcesses } from '../held-process.js';
import { interactionGate } from '../interaction-gate.js';
import { declaredInterruptOutcome } from '../scenario-store.js';
import type { TestModeScenarioSessionView } from './test-mode-scenario-session-types.js';

/** Allocate a separate private family; actual registration remains root lexical. */
export function createIsolatedTestModeInteractions() {
  const views = new WeakMap<object, TestModeScenarioSessionView>();
  const get = WeakMap.prototype.get,
    set = WeakMap.prototype.set,
    apply = Reflect.apply;
  function read(owner: object): TestModeScenarioSessionView {
    const view = apply(get, views, [owner]);
    if (!view) throw new Error('Original TestMode Interactions owner required.');
    return view;
  }
  return {
    register(owner: object, view: TestModeScenarioSessionView): void {
      apply(set, views, [owner, view]);
    },
    read,
  };
}

/** Resolve the original pending approval and its projector interaction receipt. Requires the original private owner before effects. */
export function approveTool(
  owner: object,
  id: string,
  toolCallId: string,
  approved: boolean,
  opts?: ToolDecisionOptions
): boolean {
  readOriginalTestModeInteractionsView(owner);
  const resolved = interactionGate.resolveApproval(id, toolCallId, {
    approved,
    ...(opts?.alwaysAllow !== undefined ? { alwaysAllow: opts.alwaysAllow } : {}),
    ...(opts?.denyReason !== undefined ? { denyReason: opts.denyReason } : {}),
  });
  if (!resolved) return false;
  peekProjector(id)?.resolveInteraction(toolCallId, approved ? 'approved' : 'denied', {
    // Only claimable when the words were actually carried to the scenario,
    // which is precisely when a reason was given.
    ...(opts?.denyReason !== undefined ? { reasonGiven: true } : {}),
    ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
  });
  return true;
}
/** Resolve original pending answers and their projector interaction receipt. Requires the original private owner before effects. */
export function submitAnswers(
  owner: object,
  id: string,
  toolCallId: string,
  answers: Record<string, string>,
  opts?: InteractionAnswerOptions
): boolean {
  readOriginalTestModeInteractionsView(owner);
  if (!interactionGate.resolveAnswers(id, toolCallId, answers)) return false;
  peekProjector(id)?.resolveInteraction(toolCallId, 'answered', {
    ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}),
  });
  return true;
}
/** Resolve the original pending elicitation and its projector interaction receipt. Requires the original private owner before effects. */
export function submitElicitation(
  owner: object,
  id: string,
  interactionId: string,
  action: 'accept' | 'decline' | 'cancel',
  content?: Record<string, unknown>,
  opts?: InteractionAnswerOptions
): boolean {
  readOriginalTestModeInteractionsView(owner);
  const resolved = interactionGate.resolveElicitation(id, interactionId, {
    action,
    ...(content !== undefined ? { content } : {}),
  });
  if (!resolved) return false;
  peekProjector(id)?.resolveInteraction(
    interactionId,
    action === 'accept' ? 'answered' : 'denied',
    { ...(opts?.answeredBy ? { answeredBy: opts.answeredBy } : {}) }
  );
  return true;
}
/** Return the original unsupported task-stop receipt. Requires the original private owner before effects. */
export async function stopTask(
  owner: object,
  _sessionId: string,
  _taskId: string
): Promise<InterruptReceipt> {
  const view = readOriginalTestModeInteractionsView(owner);
  return { outcome: 'not-running', reason: 'no-open-turn', runtime: view.type };
}
/** Apply the original held-process staging or steering admission checks. Requires the original private owner before effects. */
export async function deliverIntoTurn(
  owner: object,
  sessionId: string,
  content: string,
  opts: DeliverIntoTurnOpts
): Promise<RuntimeDeliveryResult> {
  readOriginalTestModeInteractionsView(owner);
  if (opts.mode === 'stage') {
    // One question, asked the way `canStageSession` asks it. Gating on `holds`
    // instead diverged from that answer in two states this really reaches —
    // opted in before the first turn, and opted in after a reap — and the
    // server, told the session was stageable, would have queued the words
    // rather than folding them (see `ensureHeld`).
    if (!heldProcesses.ensureHeld(sessionId)) {
      return { delivered: false, reason: 'unsupported' };
    }
    heldProcesses.stage(sessionId, content);
    return { delivered: true };
  }
  // A steer needs the process AND a turn already running on it. `holds` rather
  // than `willHold` on purpose: a turn cannot be open on a session that holds
  // nothing (every turn on the held path begins by taking the process), so this
  // only ever refuses a session with no live turn to join.
  if (!heldProcesses.holds(sessionId) || !interactionGate.isOpen(sessionId)) {
    return { delivered: false, reason: 'no-open-turn' };
  }
  return { delivered: true };
}
/** Read the original held-process steering eligibility. Requires the original private owner before effects. */
export function canSteerSession(owner: object, sessionId: string): boolean {
  readOriginalTestModeInteractionsView(owner);
  return heldProcesses.willHold(sessionId);
}
/** Read the original held-process staging eligibility. Requires the original private owner before effects. */
export function canStageSession(owner: object, sessionId: string): boolean {
  readOriginalTestModeInteractionsView(owner);
  return heldProcesses.willHold(sessionId);
}
/** Read the original held-process session warmth. Requires the original private owner before effects. */
export function getSessionWarmth(owner: object, sessionId: string): SessionWarmth {
  readOriginalTestModeInteractionsView(owner);
  return heldProcesses.warmth(sessionId);
}
/** Reap the original held process. Requires the original private owner before effects. */
export async function reapSession(owner: object, sessionId: string): Promise<void> {
  readOriginalTestModeInteractionsView(owner);
  heldProcesses.reap(sessionId);
}
/** Return the original unsupported open-turn settling result. Requires the original private owner before effects. */
export async function settleOpenTurn(owner: object, _sessionId: string): Promise<boolean> {
  readOriginalTestModeInteractionsView(owner);
  return false;
}
/** Apply the original declared interrupt outcome and native/projector retirement sequence. Requires the original private owner before effects. */
export async function interruptQuery(owner: object, sessionId: string): Promise<InterruptReceipt> {
  const view = readOriginalTestModeInteractionsView(owner);
  const notRunning: InterruptReceipt = {
    outcome: 'not-running',
    reason: 'no-open-turn',
    runtime: view.type,
  };
  const declared = declaredInterruptOutcome();
  // A declared `unconfirmed` or `failed` means the turn did NOT end, so the
  // abort is deliberately not performed: the test is staging the ending a
  // runtime that could not confirm would produce, and a turn that quietly
  // stopped underneath that copy would prove nothing about it.
  if (declared === 'unconfirmed' || declared === 'failed') {
    if (!interactionGate.isOpen(sessionId)) return notRunning;
    return {
      outcome: declared,
      reason: declared === 'failed' ? 'delivery-failed' : 'runtime-declined',
      runtime: view.type,
    };
  }
  // Read before the abort, which clears them.
  const pending = interactionGate.pendingInteractionIds(sessionId);
  const native = view.nativeEntries.get(sessionId);
  if (native) {
    native.retired = true;
    native.controller.abort();
  }
  if (!interactionGate.abort(sessionId)) return notRunning;
  if (native) native.interrupted = true;
  const projector = peekProjector(sessionId);
  for (const interactionId of pending) projector?.resolveInteraction(interactionId);
  return { outcome: declared ?? 'closed', runtime: view.type };
}

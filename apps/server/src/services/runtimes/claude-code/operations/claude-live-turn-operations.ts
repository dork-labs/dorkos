import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { DeliverIntoTurnOpts, RuntimeDeliveryResult } from '@dorkos/shared/agent-runtime';
import { isCreditsClaudeRoot } from '../credits-root.js';
import { SESSIONS } from '../../../../config/constants.js';

/** Execute original deliverIntoTurn behavior after actual runtime private-key admission. */
export async function deliverIntoTurn(
  ownerKey: object,
  sessionId: string,
  content: string,
  opts: DeliverIntoTurnOpts
): Promise<RuntimeDeliveryResult> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  if (opts.mode === 'stage') {
    // A stage may have to WARM a cold session — the message has to reach a
    // transcript, and a cold one has none live — so it needs the session
    // record and the launch ports, exactly as a turn does. They are resolved
    // here, from the session's own persisted settings (a stage carries no
    // per-send cwd or model of its own), and handed to the pump. Warming is
    // gated on the opt-in inside {@link PersistentDispatch.stage}, so a session
    // that has not opted in is refused before any process is booted — reaching
    // that refusal means the server ignored {@link canStageSession}.
    const session = await facet.sessionStore.ensureForMessage(
      sessionId,
      facet.transcriptReader,
      facet.cwd
    );
    const cwdKey = session.cwd || facet.cwd;
    const senderOpts = facet.buildSenderOpts(sessionId, session, cwdKey);
    return facet.persistent.stage(sessionId, content, opts, session, senderOpts);
  }
  // A steer rides the persistent pump's held input stream. On the resume path
  // there is no held stream that outlives a turn to reach, so a steer there is
  // simply "no open turn" — which `PersistentDispatch.steer` returns for a
  // session it holds no live process for, without special-casing the path.
  return facet.persistent.steer(sessionId, content, opts);
}

/** Execute original isHelperWorking behavior after actual runtime private-key admission. */
export function isHelperWorking(ownerKey: object, sessionId: string): boolean {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  if (facet.persistent.isHelperWorking(sessionId)) return true;
  // The resume path: the running turn's own tracker. Its ceiling is measured
  // from the turn's start, the one moment this path records; the pump's is
  // measured from its busy spell.
  const session = facet.sessionStore.findSession(sessionId);
  if (session?.liveHelperCount === undefined) return false;
  return (
    session.liveHelperCount() > 0 &&
    // Awake time, so a laptop asleep mid-turn does not end the wait on waking (DOR-2717).
    performance.now() - (session.turnStartedAwake ?? performance.now()) <
      SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS
  );
}

/** Execute original stopCreditsSessions behavior after actual runtime private-key admission. */
export async function stopCreditsSessions(ownerKey: object): Promise<void> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const ids = facet.sessionStore.sessionIdsWhere((session) => {
    const root = session.launchedAccountRoot ?? session.accountRoot;
    return root !== undefined && isCreditsClaudeRoot(root);
  });
  for (const id of ids) {
    await facet.interruptQuery(id).catch(() => undefined);
    // Evicted, not reaped: a polite reap declines a process still holding
    // background work, and a revoked token must not stay live for hours
    // behind a running shell (DOR-2065).
    facet.persistent.forget(id);
    await facet.pumps.evict(id).catch(() => undefined);
  }
}

/** Execute original reapSession behavior after actual runtime private-key admission. */
export async function reapSession(ownerKey: object, sessionId: string): Promise<void> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const nativeEntries = facet.claudeRuntimeEntries.get(facet.runtime);
  if (nativeEntries)
    for (const [key, entry] of nativeEntries) {
      const canonical = Object.getOwnPropertyDescriptor(entry.session, 'sdkSessionId');
      if (key === sessionId || (canonical && 'value' in canonical && canonical.value === sessionId))
        entry.retired = true;
    }
  // A reaped pump is SPENT — the registry drops it, and `SessionPump` refuses
  // everything asked of it afterwards. Forgetting the wiring in the same beat
  // is what makes the next message build a fresh one instead of dispatching
  // into a pump that can only throw.
  if (await facet.pumps.reap(sessionId)) facet.persistent.forget(sessionId);
}

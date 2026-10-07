import { query } from '@anthropic-ai/claude-agent-sdk';
import { createHeldUserPrompt } from '../../sdk/sdk-utils.js';
import {
  commitOriginalClaudeRelayQueryStart,
  requireOriginalClaudeRelayQueryStart,
} from '../../claude-code-runtime.js';
import type { OriginalDocumentProcessReservation } from '@dorkos/relay/server-private-document';
/** Original launch resolution retained before Relay native claim; not SDK FIRST authority. */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentSession } from '../../agent-types.js';
import type { MessageSenderOpts } from '../message-sender-shared.js';
import { resolveEffectiveCwd, resolveLaunch } from '../launch-resolver.js';
import { validateDispatchBoundary } from '../../dispatch-boundary.js';
export interface OriginalPreparedRelaySdkLaunch {
  readonly kind: 'original-prepared-relay-sdk-launch';
}
const launches = new WeakMap<
  OriginalPreparedRelaySdkLaunch,
  {
    session: AgentSession;
    sessionId: string;
    content: string;
    opts: MessageSenderOpts;
    messageOpts: MessageOpts;
    resolved: Awaited<ReturnType<typeof resolveLaunch>>;
    retired: boolean;
    consumed: boolean;
    queryAttempted: boolean;
    spawnAttempted: boolean;
    stop?: () => void;
    returned?: () => Promise<unknown>;
    cleanup?: Promise<void>;
    process: OriginalDocumentProcessReservation;
  }
>();
/** No query/spawn, statuses or account-substitution commit here. Original source supplies the only input. */
export async function prepareOriginalRelaySdkLaunch(
  sessionId: string,
  content: string,
  session: AgentSession,
  opts: MessageSenderOpts,
  messageOpts: MessageOpts,
  process: OriginalDocumentProcessReservation
): Promise<OriginalPreparedRelaySdkLaunch> {
  session.lastActivity = Date.now();
  session.eventQueue = [];
  session.contextBreakdown = undefined;
  session.interruptRequestedAt = undefined;
  session.limitReportedThisTurn = false;
  session.rejectedLimitThisTurn = undefined;
  const effectiveCwd = resolveEffectiveCwd(opts, messageOpts);
  await validateDispatchBoundary(effectiveCwd);
  const resolved = await resolveLaunch({
    sessionId,
    content,
    session,
    opts,
    messageOpts,
    effectiveCwd,
  });
  if (resolved.sdkOptions.spawnClaudeCodeProcess)
    throw new Error('Original Relay launch refuses a configured alternate spawner');
  const token: OriginalPreparedRelaySdkLaunch = Object.freeze({
    kind: 'original-prepared-relay-sdk-launch',
  });
  Object.defineProperty(resolved.sdkOptions, 'spawnClaudeCodeProcess', {
    value: (options: Parameters<typeof process.spawn>[0]) => {
      const own = launches.get(token);
      if (!own || own.retired || !own.queryAttempted || own.spawnAttempted)
        throw new Error('Original Relay SDK spawn entry consumed or unavailable');
      requireOriginalClaudeRelayQueryStart(session, token);
      // Actual SDK-owned spawn callback is the only first physical entry. One-use
      // latch precedes the actual Node spawn; a thrown/UNKNOWN attempt cannot retry.
      own.spawnAttempted = true;
      return process.spawn(options);
    },
    enumerable: true,
    configurable: false,
    writable: false,
  });
  launches.set(token, {
    session,
    sessionId,
    content,
    opts,
    messageOpts,
    resolved,
    retired: false,
    consumed: false,
    queryAttempted: false,
    spawnAttempted: false,
    process,
  });
  return token;
}
/** Exact privately retained launch, not a supplied Options/query/process handle. */
export function requireOriginalPreparedRelaySdkLaunch(
  token: OriginalPreparedRelaySdkLaunch,
  session: AgentSession
): void {
  const own = launches.get(token);
  if (!own || own.retired || own.session !== session)
    throw new Error('Original Relay SDK launch retired or changed');
}
/** Retire the original prepared Relay SDK launch for its exact session. */
export function retireOriginalPreparedRelaySdkLaunch(
  token: OriginalPreparedRelaySdkLaunch,
  session: AgentSession
): void {
  const own = launches.get(token);
  if (!own || own.session !== session) throw new Error('Original Relay SDK launch unavailable');
  own.retired = true;
}
/** Only the actual original sender consumes its exact retained tuple; no caller Options become authority. */
export function consumeOriginalRelaySdkLaunch(
  token: OriginalPreparedRelaySdkLaunch,
  sessionId: string,
  content: string,
  session: AgentSession,
  opts: MessageSenderOpts,
  messageOpts: MessageOpts | undefined
) {
  const own = launches.get(token);
  if (
    !own ||
    own.retired ||
    own.consumed ||
    own.session !== session ||
    own.sessionId !== sessionId ||
    own.content !== content ||
    own.opts !== opts ||
    own.messageOpts !== messageOpts
  )
    throw new Error('Original Relay sender tuple changed');
  own.consumed = true;
  return own.resolved;
}
/** Fixed actual SDK query call. No caller query factory/process reporter/holder can replace it. */
export async function startOriginalRelaySdkQuery(
  token: OriginalPreparedRelaySdkLaunch,
  session: AgentSession
) {
  const own = launches.get(token);
  if (
    !own ||
    own.retired ||
    !own.consumed ||
    own.session !== session ||
    own.queryAttempted ||
    own.stop
  )
    throw new Error('Original Relay query start unavailable');
  const held = createHeldUserPrompt(own.resolved.enrichedContent);
  own.stop = held.close.bind(held);
  const input = { prompt: held.prompt, options: own.resolved.sdkOptions };
  await commitOriginalClaudeRelayQueryStart(session, token);
  requireOriginalClaudeRelayQueryStart(session, token);
  // Distinct original SDK FIRST-attempt custody; never a session projector seq.
  // There is no await or caller callback between this latch and actual query.
  own.queryAttempted = true;
  const actual = query(input);
  const close = actual.close.bind(actual),
    returned = actual.return.bind(actual);
  const closeInput = held.close.bind(held);
  own.stop = () => {
    let failed = false;
    let first: unknown;
    try {
      closeInput();
    } catch (cause) {
      failed = true;
      first = cause;
    }
    try {
      close();
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
    if (failed) throw first;
  };
  own.returned = returned;
  return { query: actual, endStdin: held.close.bind(held) };
}
/** Synchronous cancellation reaches the actual query even while generator.next waits. */
export function stopOriginalRelaySdkQuery(
  token: OriginalPreparedRelaySdkLaunch,
  session: AgentSession
): void {
  const own = launches.get(token);
  if (!own || own.session !== session) throw new Error('Original Relay launch unavailable');
  own.retired = true;
  own.stop?.();
}
/** Both original SDK return and physical cancellation/drain start before either is awaited. */
export function drainOriginalRelaySdkQuery(
  token: OriginalPreparedRelaySdkLaunch,
  session: AgentSession
): Promise<void> {
  const own = launches.get(token);
  if (!own || own.session !== session)
    return Promise.reject(new Error('Original Relay launch unavailable'));
  if (own.cleanup) return own.cleanup;
  own.retired = true;
  own.cleanup = Promise.resolve().then(async () => {
    let failed = false;
    let first: unknown;
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    try {
      own.stop?.();
    } catch (cause) {
      remember(cause);
    }
    const sdkReturn = Promise.resolve()
      .then(() => own.returned?.())
      .catch(remember);
    const physicalDrain = Promise.resolve()
      .then(async () => {
        await own.process.drain();
        own.process.requireReleased();
      })
      .catch(remember);
    await Promise.allSettled([sdkReturn, physicalDrain]);
    if (failed) throw first;
  });
  return own.cleanup;
}

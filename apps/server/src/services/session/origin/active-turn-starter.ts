/** Display-only provenance while one runtime send is in flight. */
import type { TurnStarter, AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import { primaryOf } from '../resolution/session-key-registry.js';

const LABELS: Record<TurnStarter, string> = {
  telegram: 'a Telegram message',
  slack: 'a Slack message',
  webhook: 'a webhook',
  'agent-message': 'a message from another agent',
  'outside-message': 'a message from outside DorkOS',
  agent: 'the agent itself',
  'room-messages': 'messages in the room',
  unknown: 'something DorkOS couldn’t identify',
};
const active = new Map<string, Set<{ starter: TurnStarter | undefined }>>();

/** Record a send only while it runs; a stale settle cannot erase a newer send. */
export function beginTurnStarter(sessionId: string, starter: TurnStarter | undefined): () => void {
  const key = primaryOf(sessionId);
  const entry = { starter };
  const entries = active.get(key) ?? new Set();
  entries.add(entry);
  active.set(key, entries);
  return () => {
    entries.delete(entry);
    if (entries.size === 0 && active.get(key) === entries) active.delete(key);
  };
}

/** No guess when sends overlap. The ordinary lineage fallback handles an unlabelled send. */
export function activeTurnStarterOf(sessionId: string): string | undefined {
  const entries = active.get(primaryOf(sessionId));
  if (!entries?.size) return undefined;
  if (entries.size !== 1) return 'something DorkOS couldn’t identify';
  const starter = [...entries][0]!.starter;
  if (starter === undefined) return undefined;
  return Object.hasOwn(LABELS, starter) ? LABELS[starter] : 'something DorkOS couldn’t identify';
}

/** Scope provenance to iteration, including errors, interruption and early iterator return. */
export async function* trackTurnStarter<T>(
  sessionId: string,
  starter: TurnStarter | undefined,
  events: AsyncIterable<T>
): AsyncGenerator<T> {
  const release = beginTurnStarter(sessionId, starter);
  try {
    yield* events;
  } finally {
    release();
  }
}

/** The registry seam wraps every runtime; this decorator changes no send arguments or authority. */
export function recordTurnStarters(runtime: AgentRuntime): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (
        (prop === 'sendMessage' || prop === 'executeCommandIntent') &&
        typeof target[prop] === 'function'
      ) {
        const start = (target[prop] as AgentRuntime['sendMessage']).bind(target);
        return (id: string, content: string, opts?: MessageOpts) =>
          trackTurnStarter(
            id,
            opts?.turnStarter ?? opts?.roomTurn?.turnStarter,
            start(id, content, opts)
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

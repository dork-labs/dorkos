import type { AgentSession } from '../../agent-types.js';

/** Each caller gets unrelated custody; only the original main module holds its actual instance. */
export function createIsolatedClaudeSessionCustody() {
  const nativeMapValues = Map.prototype.values;
  const nativeMapGet = Map.prototype.get;
  const nativeSessionStores = new WeakMap<
    object,
    {
      sessions: Map<string, AgentSession>;
      index: Map<string, string>;
      retired: WeakSet<AgentSession>;
    }
  >();
  /** Read only the genuine constructor's native session lifetime; no caller can register an entry. */
  function isCurrentClaudeNativeSession(store: object, session: AgentSession): boolean {
    const state = nativeSessionStores.get(store);
    if (!state || state.retired.has(session)) return false;
    const slot = Object.getOwnPropertyDescriptor(store, 'sessions');
    if (!slot || !('value' in slot) || slot.value !== state.sessions) {
      state.retired.add(session);
      return false;
    }
    for (const current of nativeMapValues.call(state.sessions))
      if (current === session) return true;
    return false;
  }

  /** Callback-free same original session alias lookup; replaced public find/read methods are never consulted. */
  function isOriginalClaudeSessionAlias(
    store: object,
    retiredId: string,
    canonicalId: string
  ): boolean {
    const own = nativeSessionStores.get(store);
    const sessions = Object.getOwnPropertyDescriptor(store, 'sessions');
    const index = Object.getOwnPropertyDescriptor(store, 'sdkSessionIndex');
    if (
      !own ||
      retiredId === canonicalId ||
      sessions?.value !== own.sessions ||
      index?.value !== own.index
    )
      return false;
    const resolve = (id: string): AgentSession | undefined =>
      nativeMapGet.call(own.sessions, id) ??
      nativeMapGet.call(own.sessions, nativeMapGet.call(own.index, id));
    const before = resolve(retiredId),
      after = resolve(canonicalId);
    if (!before || before !== after || own.retired.has(before)) return false;
    const sdk = Object.getOwnPropertyDescriptor(before, 'sdkSessionId');
    return !!sdk && 'value' in sdk && sdk.value === canonicalId;
  }

  return Object.freeze({
    nativeSessionStores,
    isCurrentClaudeNativeSession,
    isOriginalClaudeSessionAlias,
  });
}

import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { AgentSession } from '../agent-types.js';
import type { MessageSenderOpts } from '../messaging/message-sender-shared.js';

/** Execute original #buildSenderOpts behavior after actual runtime private-key admission. */
export function buildSenderOpts(
  ownerKey: object,
  sessionId: string,
  session: AgentSession,
  cwdKey: string,
  turnAgent?: string
): MessageSenderOpts {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  // Resolve the selected model's capabilities once: thinking config + whether it
  // supports auto permission mode (undefined when the model isn't cached yet).
  const modelCapability = facet.cache.resolveModelCapability(session.model);
  const cacheCallbacks = facet.cache.buildSendCallbacks(cwdKey);

  return {
    cwd: facet.cwd,
    sessionCwd: session.cwd,
    claudeCliPath: facet.spawnBinaryPath,
    ...(facet.attachments ? { attachments: facet.attachments } : {}),
    meshCore: facet.meshCore,
    bindingRouter: facet.bindingRouter,
    bindingStore: facet.bindingStore,
    adapterManager: facet.adapterManager,
    mcpServerFactory: facet.mcpServerFactory,
    connectorTools: facet.connectorAgentFor(cwdKey, turnAgent) !== undefined,
    ...cacheCallbacks,
    // Composed over the cache's own handler rather than replacing it: the
    // per-turn status snapshot is one observation with two readers — the
    // cache, which answers "what is connected?", and the revocation watch,
    // which acts on the single status that means "the token you sent me was
    // refused" (DOR-981). The session id is read when the snapshot ARRIVES,
    // not now, so a session that was assigned its canonical id mid-turn
    // reports the id its projector is keyed by.
    onMcpStatusReceived: (servers) => {
      cacheCallbacks.onMcpStatusReceived?.(servers);
      facet.reportMcpAuthFailures(session.sdkSessionId || sessionId, cwdKey, servers);
    },
    // `sessionId` is the id THIS turn was asked with, which is only a hint:
    // after the session's first rename it is an alias, not the key the
    // store holds it under. The store resolves the real key itself.
    onSdkSessionRebind: (previousSdkSessionId, nextSdkSessionId) =>
      facet.sessionStore.rebindSdkSession(previousSdkSessionId, nextSdkSessionId, sessionId),
    modelThinkingCapability: modelCapability,
    modelSupportsAutoMode: modelCapability
      ? (modelCapability.supportsAutoMode ?? false)
      : undefined,
    lookupModel: (value) => facet.cache.resolveModelCapability(value),
    rememberSessionModel: (model) => facet.sessionStore.rememberModel(session, sessionId, model),
    plugins: facet.activatedPlugins,
    getKnownCommands: async () => {
      // Cold SDK cache → null: built-ins are unknowable before the first
      // query for this cwd, so the sender passes command-shaped content
      // through unverified (DOR-107).
      if (!facet.cache.hasSdkCommands(cwdKey)) return null;
      const { commands } = await facet.cache.getCommands(facet.getOrCreateRegistry(cwdKey), cwdKey);
      return commands.map((c) => c.fullCommand);
    },
  };
}

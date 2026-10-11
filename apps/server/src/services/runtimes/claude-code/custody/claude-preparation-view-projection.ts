import type { OriginalClaudeNativePreparationView } from './claude-native-preparation-contracts.js';
import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';

const originalClaudePreparationFreeze = Object.freeze;
const originalClaudePreparationApply = Reflect.apply;

/** Caller-owned fixed readers only; no key, map, registrar or operational admission is created. */
export interface OriginalClaudePreparationProjectionSources {
  readonly owner: ClaudeCodeRuntime;
  readonly runtime: OriginalClaudeNativePreparationView['runtime'];
  readonly cache: () => OriginalClaudeNativePreparationView['cache'];
  readonly lockManager: () => OriginalClaudeNativePreparationView['lockManager'];
  readonly pluginReloads: () => OriginalClaudeNativePreparationView['pluginReloads'];
  readonly pumps: () => OriginalClaudeNativePreparationView['pumps'];
  readonly activatedPlugins: () => OriginalClaudeNativePreparationView['activatedPlugins'];
  readonly writeActivatedPlugins: (
    value: OriginalClaudeNativePreparationView['activatedPlugins']
  ) => void;
  readonly broadcastCommandsChanged: () => OriginalClaudeNativePreparationView['broadcastCommandsChanged'];
  readonly forgetProjectCommands: () => OriginalClaudeNativePreparationView['forgetProjectCommands'];
  readonly reloadCommandsForLiveSessions: () => OriginalClaudeNativePreparationView['reloadCommandsForLiveSessions'];
  readonly recordPaidPluginReload: () => OriginalClaudeNativePreparationView['recordPaidPluginReload'];
  readonly notifyInteractionResolved: () => OriginalClaudeNativePreparationView['notifyInteractionResolved'];
  readonly interruptQuery: () => OriginalClaudeNativePreparationView['interruptQuery'];
  readonly attachments: () => OriginalClaudeNativePreparationView['attachments'];
  readonly adapterManager: () => OriginalClaudeNativePreparationView['adapterManager'];
  readonly bindingRouter: () => OriginalClaudeNativePreparationView['bindingRouter'];
  readonly bindingStore: () => OriginalClaudeNativePreparationView['bindingStore'];
  readonly mcpServerFactory: () => OriginalClaudeNativePreparationView['mcpServerFactory'];
  readonly spawnBinaryPath: () => OriginalClaudeNativePreparationView['spawnBinaryPath'];
  readonly mcpAuthEvidence: () => OriginalClaudeNativePreparationView['mcpAuthEvidence'];
  readonly pluginReloadActivity: () => OriginalClaudeNativePreparationView['pluginReloadActivity'];
  readonly warmFailedAt: () => OriginalClaudeNativePreparationView['warmFailedAt'];
  readonly connectorAgentFor: OriginalClaudeNativePreparationView['connectorAgentFor'];
  readonly reportMcpAuthFailures: () => OriginalClaudeNativePreparationView['reportMcpAuthFailures'];
  readonly getOrCreateRegistry: () => OriginalClaudeNativePreparationView['getOrCreateRegistry'];
  readonly sessionStore: () => OriginalClaudeNativePreparationView['sessionStore'];
  readonly reloadableSession: () => OriginalClaudeNativePreparationView['reloadableSession'];
  readonly accountsAccess: () => OriginalClaudeNativePreparationView['accountsAccess'];
  readonly originalClaudeLockedStreams: OriginalClaudeNativePreparationView['originalClaudeLockedStreams'];
  readonly originalClaudeRoomStreams: OriginalClaudeNativePreparationView['originalClaudeRoomStreams'];
  readonly originalClaudePersistentRequests: OriginalClaudeNativePreparationView['originalClaudePersistentRequests'];
  readonly connectorRuntimeTools: () => OriginalClaudeNativePreparationView['connectorRuntimeTools'];
  readonly meshCore: () => OriginalClaudeNativePreparationView['meshCore'];
  readonly transcriptReader: () => OriginalClaudeNativePreparationView['transcriptReader'];
  readonly cwd: () => OriginalClaudeNativePreparationView['cwd'];
  readonly persistent: () => OriginalClaudeNativePreparationView['persistent'];
  readonly relayPreparing: () => OriginalClaudeNativePreparationView['relayPreparing'];
  readonly roomPreparing: () => OriginalClaudeNativePreparationView['roomPreparing'];
  readonly claudeRuntimeEntries: OriginalClaudeNativePreparationView['claudeRuntimeEntries'];
  readonly claudeOriginalStores: OriginalClaudeNativePreparationView['claudeOriginalStores'];
  readonly claudeRoomQuerySessions: OriginalClaudeNativePreparationView['claudeRoomQuerySessions'];
  readonly claudeNativeConstructors: OriginalClaudeNativePreparationView['claudeNativeConstructors'];
  readonly claudeNativeOperations: OriginalClaudeNativePreparationView['claudeNativeOperations'];
  readonly claudeOriginalSessionOperations: OriginalClaudeNativePreparationView['claudeOriginalSessionOperations'];
  readonly claudeRoomPrepared: OriginalClaudeNativePreparationView['claudeRoomPrepared'];
  readonly claudeRelayPrepared: OriginalClaudeNativePreparationView['claudeRelayPrepared'];
  readonly originalRelayLaunchPreparations: OriginalClaudeNativePreparationView['originalRelayLaunchPreparations'];
  readonly sendOwnedMessage: OriginalClaudeNativePreparationView['sendOwnedMessage'];
  readonly installNativeTurn: OriginalClaudeNativePreparationView['installNativeTurn'];
  readonly buildSenderOpts: OriginalClaudeNativePreparationView['buildSenderOpts'];
  readonly createMessage: OriginalClaudeNativePreparationView['createMessage'];
}

/** Project the original ordered descriptors without invoking any supplied reader during construction. */
export function projectOriginalClaudePreparationView(
  sources: OriginalClaudePreparationProjectionSources
): OriginalClaudeNativePreparationView {
  return originalClaudePreparationFreeze<OriginalClaudeNativePreparationView>({
    runtime: sources.runtime,
    get cache() {
      return sources.cache();
    },
    get lockManager() {
      return sources.lockManager();
    },
    get pluginReloads() {
      return sources.pluginReloads();
    },
    get pumps() {
      return sources.pumps();
    },
    get activatedPlugins() {
      return sources.activatedPlugins();
    },
    set activatedPlugins(value) {
      sources.writeActivatedPlugins(value);
    },
    get broadcastCommandsChanged() {
      const method = sources.broadcastCommandsChanged();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get forgetProjectCommands() {
      const method = sources.forgetProjectCommands();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get reloadCommandsForLiveSessions() {
      const method = sources.reloadCommandsForLiveSessions();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get recordPaidPluginReload() {
      const method = sources.recordPaidPluginReload();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get notifyInteractionResolved() {
      const method = sources.notifyInteractionResolved();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get interruptQuery() {
      const method = sources.interruptQuery();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get attachments() {
      return sources.attachments();
    },
    get adapterManager() {
      return sources.adapterManager();
    },
    get bindingRouter() {
      return sources.bindingRouter();
    },
    get bindingStore() {
      return sources.bindingStore();
    },
    get mcpServerFactory() {
      return sources.mcpServerFactory();
    },
    get spawnBinaryPath() {
      return sources.spawnBinaryPath();
    },
    get mcpAuthEvidence() {
      return sources.mcpAuthEvidence();
    },
    get pluginReloadActivity() {
      return sources.pluginReloadActivity();
    },
    get warmFailedAt() {
      return sources.warmFailedAt();
    },
    connectorAgentFor: sources.connectorAgentFor,
    get reportMcpAuthFailures() {
      const method = sources.reportMcpAuthFailures();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get getOrCreateRegistry() {
      const method = sources.getOrCreateRegistry();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get sessionStore() {
      return sources.sessionStore();
    },
    get reloadableSession() {
      const method = sources.reloadableSession();
      return (...args: Parameters<typeof method>): ReturnType<typeof method> =>
        originalClaudePreparationApply(method, sources.owner, args) as ReturnType<typeof method>;
    },
    get accountsAccess() {
      return sources.accountsAccess();
    },
    originalClaudeLockedStreams: sources.originalClaudeLockedStreams,
    originalClaudeRoomStreams: sources.originalClaudeRoomStreams,
    originalClaudePersistentRequests: sources.originalClaudePersistentRequests,
    get connectorRuntimeTools() {
      return sources.connectorRuntimeTools();
    },
    get meshCore() {
      return sources.meshCore();
    },
    get transcriptReader() {
      return sources.transcriptReader();
    },
    get cwd() {
      return sources.cwd();
    },
    get persistent() {
      return sources.persistent();
    },
    get relayPreparing() {
      return sources.relayPreparing();
    },
    get roomPreparing() {
      return sources.roomPreparing();
    },
    claudeRuntimeEntries: sources.claudeRuntimeEntries,
    claudeOriginalStores: sources.claudeOriginalStores,
    claudeRoomQuerySessions: sources.claudeRoomQuerySessions,
    claudeNativeConstructors: sources.claudeNativeConstructors,
    claudeNativeOperations: sources.claudeNativeOperations,
    claudeOriginalSessionOperations: sources.claudeOriginalSessionOperations,
    claudeRoomPrepared: sources.claudeRoomPrepared,
    claudeRelayPrepared: sources.claudeRelayPrepared,
    originalRelayLaunchPreparations: sources.originalRelayLaunchPreparations,
    sendOwnedMessage: sources.sendOwnedMessage,
    installNativeTurn: sources.installNativeTurn,
    buildSenderOpts: sources.buildSenderOpts,
    createMessage: sources.createMessage,
  });
}

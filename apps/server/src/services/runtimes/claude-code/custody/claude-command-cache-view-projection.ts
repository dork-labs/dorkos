import type { OriginalClaudeCommands } from './claude-command-cache-custody.js';
import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';

const originalClaudeCommandFreeze = Object.freeze;
const originalClaudeCommandApply = Reflect.apply;

/** Caller-owned fixed readers only; no key, map, registrar or operational admission is created. */
export interface OriginalClaudeCommandCacheProjectionSources {
  readonly owner: ClaudeCodeRuntime;
  readonly cache: () => OriginalClaudeCommands['cache'];
  readonly cwd: () => OriginalClaudeCommands['cwd'];
  readonly warmingCwds: () => OriginalClaudeCommands['warmingCwds'];
  readonly warmFailedAt: () => OriginalClaudeCommands['warmFailedAt'];
  readonly activatedPlugins: () => OriginalClaudeCommands['activatedPlugins'];
  readonly spawnBinaryPath: () => OriginalClaudeCommands['spawnBinaryPath'];
  readonly commandRegistries: () => OriginalClaudeCommands['commandRegistries'];
  readonly MAX_COMMAND_REGISTRIES: () => OriginalClaudeCommands['MAX_COMMAND_REGISTRIES'];
  readonly WARM_FAILURE_COOLDOWN_MS: () => OriginalClaudeCommands['WARM_FAILURE_COOLDOWN_MS'];
  readonly WARM_TIMEOUT_MS: () => OriginalClaudeCommands['WARM_TIMEOUT_MS'];
  readonly getOrCreateRegistry: () => OriginalClaudeCommands['getOrCreateRegistry'];
  readonly warmCommands: () => OriginalClaudeCommands['warmCommands'];
  readonly recordWarmFailure: () => OriginalClaudeCommands['recordWarmFailure'];
  readonly broadcastCommandsChanged: () => OriginalClaudeCommands['broadcastCommandsChanged'];
}

/** Project the original ordered descriptors without invoking any supplied reader during construction. */
export function projectOriginalClaudeCommandCacheView(
  sources: OriginalClaudeCommandCacheProjectionSources
): OriginalClaudeCommands {
  return originalClaudeCommandFreeze<OriginalClaudeCommands>({
    get cache() {
      return sources.cache();
    },
    get cwd() {
      return sources.cwd();
    },
    get warmingCwds() {
      return sources.warmingCwds();
    },
    get warmFailedAt() {
      return sources.warmFailedAt();
    },
    get activatedPlugins() {
      return sources.activatedPlugins();
    },
    get spawnBinaryPath() {
      return sources.spawnBinaryPath();
    },
    get commandRegistries() {
      return sources.commandRegistries();
    },
    get MAX_COMMAND_REGISTRIES() {
      return sources.MAX_COMMAND_REGISTRIES();
    },
    get WARM_FAILURE_COOLDOWN_MS() {
      return sources.WARM_FAILURE_COOLDOWN_MS();
    },
    get WARM_TIMEOUT_MS() {
      return sources.WARM_TIMEOUT_MS();
    },
    get getOrCreateRegistry() {
      const method = sources.getOrCreateRegistry();
      return (root: string) =>
        originalClaudeCommandApply(method, sources.owner, [root]) as ReturnType<typeof method>;
    },
    get warmCommands() {
      const method = sources.warmCommands();
      return (cwd: string) =>
        originalClaudeCommandApply(method, sources.owner, [cwd]) as ReturnType<typeof method>;
    },
    get recordWarmFailure() {
      const method = sources.recordWarmFailure();
      return (cwd: string) =>
        originalClaudeCommandApply(method, sources.owner, [cwd]) as ReturnType<typeof method>;
    },
    get broadcastCommandsChanged() {
      const method = sources.broadcastCommandsChanged();
      return () =>
        originalClaudeCommandApply(method, sources.owner, []) as ReturnType<typeof method>;
    },
  });
}

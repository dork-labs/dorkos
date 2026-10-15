import { readOriginalClaudeCommandView } from '../claude-code-runtime.js';
import type { ModelOption, SubagentInfo, CommandRegistry } from '@dorkos/shared/types';
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeCache } from '../messaging/runtime-cache.js';
import { CommandRegistryService } from '../tooling/command-registry.js';
import { createIdlePrompt } from '../sdk/sdk-utils.js';
import { runtimeEnvironment } from '../../shared/runtime-environment-config.js';
import { claudeConfigDirEnv, resolveActiveClaudeRoot } from '../claude-config-dir.js';
import { logger } from '../../../../lib/logger.js';

/** Original live command-cache collaborators, registered only under the actual runtime private key. */
export interface OriginalClaudeCommands {
  readonly cache: RuntimeCache;
  readonly cwd: string;
  readonly warmingCwds: Set<string>;
  readonly warmFailedAt: Map<string, number>;
  readonly activatedPlugins: Array<{ type: 'local'; path: string }>;
  readonly spawnBinaryPath: string | undefined;
  readonly commandRegistries: Map<string, CommandRegistryService>;
  readonly MAX_COMMAND_REGISTRIES: number;
  readonly WARM_FAILURE_COOLDOWN_MS: number;
  readonly WARM_TIMEOUT_MS: number;
  readonly getOrCreateRegistry: (root: string) => CommandRegistryService;
  readonly warmCommands: (cwd: string) => Promise<void>;
  readonly recordWarmFailure: (cwd: string) => void;
  readonly broadcastCommandsChanged: () => void;
}

const originalCommandFreeze = Object.freeze;
const originalCommandGet = WeakMap.prototype.get;
const originalCommandSet = WeakMap.prototype.set;
const originalCommandApply = Reflect.apply;

/** Allocate unrelated read/register custody; operations always resolve the original root's instance. */
export function createIsolatedClaudeCommandCacheCustody() {
  const contexts = new WeakMap<object, Readonly<OriginalClaudeCommands>>();
  function read(key: object): Readonly<OriginalClaudeCommands> {
    const own = originalCommandApply(originalCommandGet, contexts, [key]) as
      Readonly<OriginalClaudeCommands> | undefined;
    if (!own) throw new Error('Original Claude command cache is unavailable.');
    return own;
  }
  function register(key: object, context: Readonly<OriginalClaudeCommands>): void {
    originalCommandApply(originalCommandSet, contexts, [key, context]);
  }
  return originalCommandFreeze({ register, read });
}

/** Execute the original getSupportedModels command-cache duty only after actual runtime private-key lookup. */
export async function getSupportedModels(ownerKey: object): Promise<ModelOption[]> {
  const facet = readOriginalClaudeCommandView(ownerKey);
  return facet.cache.getSupportedModels();
}

/** Execute the original getSupportedSubagents command-cache duty only after actual runtime private-key lookup. */
export async function getSupportedSubagents(ownerKey: object): Promise<SubagentInfo[]> {
  const facet = readOriginalClaudeCommandView(ownerKey);
  return facet.cache.getSupportedSubagents();
}

/** Execute the original getCommands command-cache duty only after actual runtime private-key lookup. */
export async function getCommands(
  ownerKey: object,
  forceRefresh?: boolean,
  cwd?: string
): Promise<CommandRegistry> {
  const facet = readOriginalClaudeCommandView(ownerKey);
  const root = cwd || facet.cwd;
  const registry = facet.getOrCreateRegistry(root);
  // Plugin commands (e.g. `/flow:*`) live in the SDK, not on the filesystem,
  // so the cold-cache fallback (`command-registry` scans `.claude/commands/`
  // only) can't surface them. When this cwd has no SDK command list yet, warm
  // it in the background so the palette shows those commands before the
  // session's first message. Whether any plugins actually apply (global OR
  // project-scoped under `<cwd>/.dork/plugins/`) is decided inside
  // `warmCommands` — it exits before booting a probe when none do.
  // Fire-and-forget: the probe broadcasts `commands_changed` on completion,
  // which re-fetches the palette.
  if (!facet.cache.hasSdkCommands(root)) {
    void facet.warmCommands(root);
  }
  return facet.cache.getCommands(registry, root, forceRefresh);
}

/** Execute the original warmCommands command-cache duty only after actual runtime private-key lookup. */
export async function warmCommands(ownerKey: object, cwd: string): Promise<void> {
  const facet = readOriginalClaudeCommandView(ownerKey);
  if (facet.cache.hasSdkCommands(cwd) || facet.warmingCwds.has(cwd)) return;
  const failedAt = facet.warmFailedAt.get(cwd);
  if (failedAt !== undefined && Date.now() - failedAt < facet.WARM_FAILURE_COOLDOWN_MS) {
    return;
  }
  facet.warmingCwds.add(cwd);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Both hoisted so the `finally` can close whatever was actually created:
  // the plugins check below can exit before either exists, and `query()` can
  // throw with `probe` still undefined. Closing stdin via `idle.close()`
  // alone does NOT tear down the CLI child — `Query.close()` does (see
  // RuntimeCache.warmup, which closes the query even though its input
  // generator completes immediately).
  let idle: ReturnType<typeof createIdlePrompt> | undefined;
  let probe: ReturnType<typeof query> | undefined;
  try {
    // Only GLOBAL plugins are SDK-injected now; a project-scoped plugin's
    // commands reach this cwd as `.claude/commands/<pkg>/` wrappers the FS
    // registry already covers, so no probe is needed for them. When no global
    // plugin applies, skip the probe entirely; built-ins arrive with the
    // first real message.
    const plugins = facet.activatedPlugins;
    if (plugins.length === 0) return;
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    idle = createIdlePrompt();
    probe = query({
      prompt: idle.prompt,
      options: {
        cwd,
        plugins,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['local', 'project', 'user'],
        ...(facet.spawnBinaryPath ? { pathToClaudeCodeExecutable: facet.spawnBinaryPath } : {}),
        env: runtimeEnvironment('claude-code', 'warmup', {
          // The probe gets the same explicit account pin a turn does, for two
          // reasons. `settingSources` includes `'user'`, which resolves under
          // the config dir — an inherited root would warm this cwd's palette
          // from ANOTHER account's user settings, and could boot against an
          // account that is not signed in. And an explicit entry keeps the
          // probe out of reach of the process-global mutation the D8 env lock
          // holds during a rename or fork. There is no session here, so the
          // ACTIVE account is the only account this can mean.
          ...claudeConfigDirEnv(resolveActiveClaudeRoot()),
        }),
      },
    });
    const commands = await Promise.race([
      probe.supportedCommands(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('warmCommands: supportedCommands timed out')),
          facet.WARM_TIMEOUT_MS
        );
      }),
    ]);
    // Provisional: the probe omits `mcpServers` (real sessions inject them),
    // so this list can miss MCP-contributed commands. Marking it provisional
    // lets the first real message re-fetch the authoritative, MCP-inclusive
    // set — the palette still populates immediately in the meantime.
    facet.cache.replaceSdkCommands(
      cwd,
      commands.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        aliases: c.aliases,
      })),
      { provisional: true }
    );
    facet.broadcastCommandsChanged();
    facet.warmFailedAt.delete(cwd);
    logger.debug('[warmCommands] warmed command cache', { cwd, count: commands.length });
  } catch (err) {
    // Record the failure so the cooldown guard suppresses a re-probe storm if
    // the SDK is persistently broken (bad auth, missing binary, boot crash).
    facet.recordWarmFailure(cwd);
    logger.debug('[warmCommands] probe failed; cache stays cold until first message', {
      cwd,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timer) clearTimeout(timer);
    // Close the query (kills the CLI child) AND the held prompt (closes
    // stdin). Either can be undefined: the no-applicable-plugins exit creates
    // neither, and a `query()` throw leaves `probe` unset — hence the guards.
    probe?.close();
    idle?.close();
    facet.warmingCwds.delete(cwd);
  }
}

/** Execute the original recordWarmFailure command-cache duty only after actual runtime private-key lookup. */
export function recordWarmFailure(ownerKey: object, cwd: string): void {
  const facet = readOriginalClaudeCommandView(ownerKey);
  const now = Date.now();
  for (const [key, at] of facet.warmFailedAt) {
    if (now - at >= facet.WARM_FAILURE_COOLDOWN_MS) {
      facet.warmFailedAt.delete(key);
    }
  }
  facet.warmFailedAt.set(cwd, now);
}

/** Execute the original getOrCreateRegistry command-cache duty only after actual runtime private-key lookup. */
export function getOrCreateRegistry(ownerKey: object, root: string): CommandRegistryService {
  const facet = readOriginalClaudeCommandView(ownerKey);
  let registry = facet.commandRegistries.get(root);
  if (!registry) {
    if (facet.commandRegistries.size >= facet.MAX_COMMAND_REGISTRIES) {
      const oldest = facet.commandRegistries.keys().next().value!;
      facet.commandRegistries.delete(oldest);
    }
    registry = new CommandRegistryService(root);
    facet.commandRegistries.set(root, registry);
  }
  return registry;
}

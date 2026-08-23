/**
 * How much power a scheduled run starts with when nobody named a level.
 *
 * Two surfaces need the same answer and must never disagree: `POST /api/tasks`,
 * which writes the mode onto a new schedule, and the scheduler, which reads it
 * back at dispatch and needs a value for a row that has none. Before this
 * existed both hardcoded `'acceptEdits'`, so an operator who had set every new
 * conversation to run at full autonomy still got a scheduled run that stopped to
 * ask — the one place nobody is there to answer.
 *
 * The ladder is the operator's own: the configured trust stop
 * ({@link resolveUnattendedDefaultStop}), mapped through the target runtime's
 * capability profile by {@link resolveTrustStops} — the same function the dial
 * renders from, so a resolved default lands on exactly the mode the dial would
 * show as selected. When nothing is configured, or the runtime declares no mode
 * at that stop, or the runtime is not registered at all, the answer is
 * `'acceptEdits'`: byte-for-byte what every scheduled run got before this
 * module, and what anyone who never answered the power door still gets.
 *
 * **This never raises a run above what a person chose.** It reads a stop the
 * operator set through the consent-gated path and nothing else; a config with no
 * stop resolves to the old constant.
 *
 * @module services/tasks/scheduled-run-power
 */
import type { PermissionMode } from '@dorkos/shared/types';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { resolveTrustStops } from '@dorkos/shared/permission-semantics';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { resolveUnattendedDefaultStop } from '../session/resolve-session-defaults.js';

/**
 * What every scheduled run started at before the operator's stop was consulted,
 * and what it still starts at when no stop is configured.
 */
export const SCHEDULED_RUN_FALLBACK_MODE: PermissionMode = 'acceptEdits';

/**
 * The runtime a scheduled run actually executes on.
 *
 * **An assumption, and deliberately not the registry default** — the same one
 * the task form makes client-side (`TaskFormInner.tsx`), stated here too because
 * the server now resolves a mode from it. A task carries no runtime of its own,
 * and the scheduler's is fixed at boot: `apps/server/src/index.ts` binds
 * `schedulerAgentManager` to the `ClaudeCodeRuntime` it constructs and hands
 * that to `TaskSchedulerService`. The `runtimes.default` setting moves the
 * REGISTRY's default — which runtime a new chat gets — and never reaches the
 * scheduler, so resolving through the registry default would map the stop
 * through Codex's mode vocabulary for a run that will execute on Claude Code.
 *
 * **Where this breaks:** the day the scheduler takes its runtime from the
 * registry, or a task carries one. The fix then is to read it from the task, not
 * to widen this constant.
 *
 * A test-mode boot is the one case it is already wrong about — the scheduler
 * runs on `TestModeRuntime` there and `claude-code` is usually not registered.
 * That resolves to no profile, which lands on
 * {@link SCHEDULED_RUN_FALLBACK_MODE} rather than guessing.
 */
const TASK_RUNTIME = 'claude-code';

/**
 * The permission mode a scheduled run should start with, for a caller that named
 * none.
 *
 * @param opts.capabilities - The target runtime's capability profile. Defaults
 *   to the registered `claude-code` profile; `undefined` — an unregistered
 *   runtime, or a test with no registry — falls back to
 *   {@link SCHEDULED_RUN_FALLBACK_MODE}.
 * @param opts.runtimes - The `runtimes` config section; defaults to the stored
 *   one, with the same pre-boot tolerance {@link resolveUnattendedDefaultStop}
 *   documents.
 * @returns The resolved mode, never `undefined`.
 */
export function resolveScheduledRunPermissionMode(opts?: {
  capabilities?: RuntimeCapabilities | undefined;
  runtimes?: UserConfig['runtimes'];
}): PermissionMode {
  const capabilities = opts?.capabilities ?? runtimeRegistry.getAllCapabilities()[TASK_RUNTIME];
  if (!capabilities) return SCHEDULED_RUN_FALLBACK_MODE;

  const stop = resolveUnattendedDefaultStop({
    configSection: capabilities.settings.configSection,
    ...(opts?.runtimes !== undefined ? { runtimes: opts.runtimes } : {}),
  });
  if (!stop) return SCHEDULED_RUN_FALLBACK_MODE;

  const match = resolveTrustStops(capabilities.permissionModes.values).find((s) => s.stop === stop);
  // The cast is the wire's legacy narrowing, not a claim about this id — the
  // same one `resolveTrustMode` documents: `PermissionMode` is a closed enum of
  // the ids the shipped runtimes happen to use, while a mode id is whatever its
  // runtime declared. This one came from the runtime's own profile.
  return match ? (match.mode.id as PermissionMode) : SCHEDULED_RUN_FALLBACK_MODE;
}

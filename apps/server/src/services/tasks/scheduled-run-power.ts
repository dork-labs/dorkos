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
 * **Which runtime's vocabulary, is the caller's to say** (DOR-1615). A mode id
 * is not portable — `acceptEdits` on Claude Code edits files and stops before a
 * command, while on Codex it runs commands in the workspace and cannot pause to
 * ask — so the profile is an argument here, never a lookup. The scheduler passes
 * the profile of the runtime the run RESOLVED to
 * (`resolve-run-execution.ts`); the create path, which has no run yet, passes
 * {@link capabilitiesForTaskRuntime}.
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
 * The capability profile a task's runs will be judged against, for a caller that
 * has a runtime NAME rather than a resolved run (DOR-1615).
 *
 * The create path is the one such caller: it writes a permission mode onto a
 * schedule that does not exist yet, so there is no run to resolve and no agent
 * manifest read to hang it on. It knows two things — what the request asked for,
 * and what the registry defaults to — and those are exactly the two tiers here.
 *
 * This REPLACES the `TASK_RUNTIME = 'claude-code'` constant that used to sit in
 * this file. That constant was an honest description of a scheduler whose
 * runtime was fixed at boot; a task now carries its own, so the fix its own
 * comment asked for ("read it from the task") is what this is.
 *
 * @param runtime - The runtime the caller named, or null/undefined for none.
 * @param registry - The registry; defaults to the process singleton.
 * @returns The profile, or `undefined` for a runtime that is not registered —
 *   which lands on {@link SCHEDULED_RUN_FALLBACK_MODE} rather than guessing,
 *   exactly as an unregistered runtime always has.
 */
export function capabilitiesForTaskRuntime(
  runtime: string | null | undefined,
  registry: Pick<
    typeof runtimeRegistry,
    'getAllCapabilities' | 'getDefaultType'
  > = runtimeRegistry
): RuntimeCapabilities | undefined {
  return registry.getAllCapabilities()[runtime || registry.getDefaultType()];
}

/**
 * The permission mode a scheduled run should start with, for a caller that named
 * none.
 *
 * @param opts.capabilities - The target runtime's capability profile.
 *   **Required, and passed in rather than looked up here**, so every call site
 *   is compile-forced to say which runtime's vocabulary it means — a task
 *   carries its own runtime now, and a default would be a second answer to that
 *   question. `undefined` — an unregistered runtime, or a test with no registry
 *   — falls back to {@link SCHEDULED_RUN_FALLBACK_MODE}.
 * @param opts.runtimes - The `runtimes` config section; defaults to the stored
 *   one, with the same pre-boot tolerance {@link resolveUnattendedDefaultStop}
 *   documents.
 * @returns The resolved mode, never `undefined`.
 */
export function resolveScheduledRunPermissionMode(opts: {
  capabilities: RuntimeCapabilities | undefined;
  runtimes?: UserConfig['runtimes'];
}): PermissionMode {
  const { capabilities } = opts;
  if (!capabilities) return SCHEDULED_RUN_FALLBACK_MODE;

  const stop = resolveUnattendedDefaultStop({
    configSection: capabilities.settings.configSection,
    ...(opts.runtimes !== undefined ? { runtimes: opts.runtimes } : {}),
  });
  if (!stop) return SCHEDULED_RUN_FALLBACK_MODE;

  const match = resolveTrustStops(capabilities.permissionModes.values).find((s) => s.stop === stop);
  // The cast is the wire's legacy narrowing, not a claim about this id — the
  // same one `resolveTrustMode` documents: `PermissionMode` is a closed enum of
  // the ids the shipped runtimes happen to use, while a mode id is whatever its
  // runtime declared. This one came from the runtime's own profile.
  return match ? (match.mode.id as PermissionMode) : SCHEDULED_RUN_FALLBACK_MODE;
}

/**
 * Runtime guard that keeps the session's permission mode compatible with the
 * active model before the SDK query is built.
 *
 * Auto mode (`permissionMode: 'auto'`) is only valid on models that report
 * `supportsAutoMode`; the SDK rejects it with a 400 otherwise. The client hides
 * `'auto'` from the picker on unsupported models, but that gating can't cover
 * every path into the state — a model change, a resumed session, an adapter, or
 * a direct API call could all leave a session in `'auto'` on an unsupported
 * model. This runtime-owned guard is the authoritative chokepoint: it runs at
 * query-construction time (where both the model and the mode are known).
 *
 * It sends `'auto'` ONLY when the model is positively known to support it —
 * anything else (explicitly unsupported, or unknown because the model-capability
 * cache is cold or the model is unrecognized) is coerced to `'default'`. That is
 * the guarantee: a send never 400s over the permission mode. The cost of being
 * wrong is asymmetric — a needless downgrade loses Auto for one turn and says so,
 * while an optimistic pass-through fails the whole send.
 *
 * @module services/runtimes/claude-code/messaging/permission-mode-guard
 */
import type { PermissionMode } from '@dorkos/shared/types';

/** Result of reconciling a session's permission mode against the model. */
export interface PermissionModeResolution {
  /** The mode to actually send to the SDK. */
  permissionMode: PermissionMode;
  /** True when `'auto'` was coerced to `'default'` because the model isn't known to support it. */
  downgradedFromAuto: boolean;
}

/**
 * Coerce `'auto'` to `'default'` unless the active model is known to support auto mode.
 *
 * `modelSupportsAutoMode` is `true`/`false` when the model is known, and `undefined`
 * when it is unknown (cold model cache or an unrecognized model). Only `true` keeps
 * auto: `undefined` is treated as unsupported for THIS send, because passing auto to a
 * model that turns out not to support it fails the entire turn with an SDK 400, whereas
 * downgrading a supported model costs one turn of auto and emits an explanation. The
 * caller never mutates the stored mode, so auto resumes on the next send once the
 * capability cache warms.
 *
 * @param args.permissionMode - The session's current permission mode.
 * @param args.modelSupportsAutoMode - Whether the active model supports auto mode (or undefined if unknown).
 */
export function resolveEffectivePermissionMode(args: {
  permissionMode: PermissionMode;
  modelSupportsAutoMode: boolean | undefined;
}): PermissionModeResolution {
  if (args.permissionMode === 'auto' && args.modelSupportsAutoMode !== true) {
    return { permissionMode: 'default', downgradedFromAuto: true };
  }
  return { permissionMode: args.permissionMode, downgradedFromAuto: false };
}

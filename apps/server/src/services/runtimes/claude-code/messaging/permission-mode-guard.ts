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
 * query-construction time (where both the model and the mode are known) and
 * coerces `'auto'` → `'default'` so a send never 400s, regardless of how the
 * session reached that state.
 *
 * @module services/runtimes/claude-code/messaging/permission-mode-guard
 */
import type { PermissionMode } from '@dorkos/shared/types';

/** Result of reconciling a session's permission mode against the model. */
export interface PermissionModeResolution {
  /** The mode to actually send to the SDK. */
  permissionMode: PermissionMode;
  /** True when `'auto'` was coerced to `'default'` because the model can't support it. */
  downgradedFromAuto: boolean;
}

/**
 * Coerce `'auto'` to `'default'` when the active model does not support auto mode.
 *
 * `modelSupportsAutoMode` is `true`/`false` when the model is known, and `undefined`
 * when it is unknown (cold model cache or an unrecognized model). We only downgrade on
 * an explicit `false` — never on uncertainty, to avoid stripping auto from a supported
 * model whose capability simply hasn't loaded yet.
 *
 * @param args.permissionMode - The session's current permission mode.
 * @param args.modelSupportsAutoMode - Whether the active model supports auto mode (or undefined if unknown).
 */
export function resolveEffectivePermissionMode(args: {
  permissionMode: PermissionMode;
  modelSupportsAutoMode: boolean | undefined;
}): PermissionModeResolution {
  if (args.permissionMode === 'auto' && args.modelSupportsAutoMode === false) {
    return { permissionMode: 'default', downgradedFromAuto: true };
  }
  return { permissionMode: args.permissionMode, downgradedFromAuto: false };
}

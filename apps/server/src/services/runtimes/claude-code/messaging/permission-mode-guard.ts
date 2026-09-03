/**
 * Runtime guard that keeps the session's permission mode compatible with the
 * SDK query about to be built — and the operator-facing copy for every way that
 * reconciliation can change the mode a turn actually runs in.
 *
 * Two things can move the mode at launch, and BOTH say so. Auto mode is coerced
 * on a model that cannot do it (below); a mode id this runtime does not offer at
 * all is coerced by `narrowToClaudeCodeMode` (DOR-885). Neither may be silent:
 * the session goes on displaying the mode the operator chose, so a turn running
 * in a different one has to be announced or the panel and the behaviour disagree
 * with nothing to explain the gap.
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
 * The two downgrades are told apart because only one of them knows anything. An
 * explicitly-unsupported model can be stated as fact; an unconfirmed one cannot,
 * and it is not always temporary — a cold cache warms on the next send, but a
 * model id the cache has simply never heard of stays unknown indefinitely, so
 * that explanation must not promise Auto is coming back.
 *
 * @module services/runtimes/claude-code/messaging/permission-mode-guard
 */
import type { PermissionMode } from '@dorkos/shared/types';

/** Why `'auto'` was coerced to `'default'` for one send. */
export type AutoDowngradeReason =
  /** The model reported that it does not support auto mode. */
  | 'unsupported'
  /** Nothing is known about this model's auto support (cold cache, or unrecognized id). */
  | 'unconfirmed';

/**
 * Operator-facing explanation per downgrade reason, yielded as `system_status`.
 * Each says exactly as much as the guard actually knows — the unconfirmed case
 * claims nothing about the model and promises nothing about later turns.
 */
export const AUTO_DOWNGRADE_STATUS: Record<AutoDowngradeReason, string> = {
  unsupported: "Auto mode isn't available on this model — using Default instead.",
  unconfirmed: "Couldn't confirm Auto mode works on this model — running this turn in Default.",
};

/**
 * Said when the session's saved mode is not one this runtime offers at all, so
 * the turn runs in Default instead (DOR-885).
 *
 * A different failure from the auto downgrade above, and told apart from it on
 * purpose: nothing is wrong with the model here, and the mode is not coming
 * back on its own the way Auto does. What the person needs to know is the part
 * they can act on — the agent is going to ask before it does things, which is
 * not what the mode on their screen says.
 *
 * Deliberately does NOT print the stored id. It means nothing to the person
 * reading it, and it is the one piece a log line carries instead.
 */
export const UNKNOWN_MODE_STATUS =
  "This session's saved mode isn't one Claude Code offers — using Default, so it will ask before it acts.";

/** Result of reconciling a session's permission mode against the model. */
export interface PermissionModeResolution {
  /** The mode to actually send to the SDK. */
  permissionMode: PermissionMode;
  /**
   * Why `'auto'` was coerced to `'default'`, or `null` when no coercion
   * happened. One field rather than a boolean plus a parallel reason, so the
   * two can never disagree about whether a downgrade occurred.
   */
  autoDowngrade: AutoDowngradeReason | null;
}

/**
 * Coerce `'auto'` to `'default'` unless the active model is known to support auto mode.
 *
 * `modelSupportsAutoMode` is `true`/`false` when the model is known, and `undefined`
 * when it is unknown (cold model cache or an unrecognized model). Only `true` keeps
 * auto: `undefined` is treated as unsupported for THIS send, because passing auto to a
 * model that turns out not to support it fails the entire turn with an SDK 400, whereas
 * downgrading a supported model costs one turn of auto and emits an explanation. The
 * caller never mutates the stored mode, so a session left in auto recovers by itself as
 * soon as the model's capability becomes known — which for a cold cache is the next
 * send, and for an unrecognized model id may be never.
 *
 * @param args.permissionMode - The session's current permission mode.
 * @param args.modelSupportsAutoMode - Whether the active model supports auto mode (or undefined if unknown).
 */
export function resolveEffectivePermissionMode(args: {
  permissionMode: PermissionMode;
  modelSupportsAutoMode: boolean | undefined;
}): PermissionModeResolution {
  if (args.permissionMode === 'auto' && args.modelSupportsAutoMode !== true) {
    return {
      permissionMode: 'default',
      autoDowngrade: args.modelSupportsAutoMode === false ? 'unsupported' : 'unconfirmed',
    };
  }
  return { permissionMode: args.permissionMode, autoDowngrade: null };
}

import type { RuntimeReadiness as RuntimeConnectState } from '@dorkos/shared/agent-runtime';
import { runtimeAuthConnectKind, runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { PRIMARY_RUNTIME_TYPES } from '../config/runtime-descriptors';
/**
 * The quiet ready-state affordance that reopens a runtime's connect flow.
 *
 * "Ready" is a fingerprint check — it cannot see a stale API key or an expired
 * host login — so a ready runtime with a connect flow keeps a small, calm way
 * to fix its sign-in without leaving the settled Ready look. Two shapes:
 * - **OpenCode** (`change`): re-pick the model source. Only offered when a
 *   DorkOS provider is set — a runtime signed in via the OpenCode CLI has
 *   nothing for the picker to change.
 * - **Claude / Codex** (`reconnect`): sign in again, which also replaces a
 *   stored bad key via the login flow's "Use an API key instead" path.
 *
 * Returns `null` when there is nothing honest to reopen (no injected connect
 * renderer, or a runtime whose connect flow we do not know).
 */
interface ReadyReconnect {
  /** Test-id namespace and semantic role: `change` (provider) or `reconnect` (sign-in). */
  idPrefix: 'change' | 'reconnect';
  /** The quiet trigger shown next to the Ready badge. */
  triggerLabel: string;
  /** The cancel link that closes the flow, keeping the current credential. */
  cancelLabel: string;
  /** Connect descriptor handed to the injected flow. */
  connect: NonNullable<RuntimeConnectState['connect']>;
  /** Current provider id, for the OpenCode picker's "Currently:" label. */
  currentProvider?: string;
}

/** Choose the existing sign-in or model-source flow for a ready runtime. */
export function selectReadyReconnect(
  type: string,
  provider: string | undefined,
  hasRenderConnect: boolean
): ReadyReconnect | null {
  if (!hasRenderConnect) return null;
  if (runtimeAuthConnectKind(type) === 'provider-picker') {
    if (!provider) return null;
    return {
      idPrefix: 'change',
      triggerLabel: 'Change',
      cancelLabel: 'Keep current source',
      connect: { kind: 'provider-picker', label: 'Change power source' },
      currentProvider: provider,
    };
  }
  // Login runtimes (Claude, Codex). Gate to the known sibling runtimes so a
  // future runtime we cannot yet sign in never gets a misleading flow.
  if (!(PRIMARY_RUNTIME_TYPES as readonly string[]).includes(type)) return null;
  return {
    idPrefix: 'reconnect',
    triggerLabel: 'Fix sign-in',
    cancelLabel: 'Keep current sign-in',
    connect: { kind: 'login', label: `Reconnect ${runtimeDisplayName(type)}` },
  };
}

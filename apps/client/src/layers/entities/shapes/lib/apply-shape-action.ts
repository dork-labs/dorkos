/**
 * The apply-a-Shape client action — the extracted, testable helper both the
 * app-shell UI dispatcher (agent-issued `apply_layout`) and the switcher UI
 * drive (DOR-355 task 3.1, mirroring the `switchAgentCwd` seam).
 *
 * It POSTs `/api/shapes/:name/apply`, then acts on the response WITHOUT a second
 * fetch (the review-locked §5/§9 contract): restore the chrome through the UI
 * dispatcher, live-remount extensions so newly-activated slots appear (W1c),
 * refresh the installed-Shapes list, surface every degradation warning to the
 * user (§7 — never the console), and auto-follow the arrival agent when the
 * person opted in (W1a). It returns the full result so a React caller can render
 * the richer offers surface.
 *
 * @module entities/shapes/lib/apply-shape-action
 */
import type { QueryClient } from '@tanstack/react-query';
import type { UiCommand } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import type { ApplyShapeResult } from '@dorkos/shared/marketplace-schemas';
import { toast } from 'sonner';
import { requestExtensionRemount, type EffectOwner } from '@/layers/shared/lib';
import { applyShapeLayout } from './apply-shape-layout';
import { shapeKeys } from '../api/query-keys';

/** Injected dependencies for {@link applyShapeAction}. */
export interface ApplyShapeActionDeps {
  /** The active transport (only `applyShape` is used). */
  transport: Pick<Transport, 'applyShape'>;
  /** Exact originating extension occurrence; absent for genuine user actions. */
  effectOwner?: EffectOwner;
  /** Query client — the installed-Shapes list is invalidated so the active flag refreshes. */
  queryClient: QueryClient;
  /**
   * Dispatch a single UI command. The caller binds the real UI dispatcher and
   * the origin (`'agent'` for an agent-issued switch, `'user'` for the switcher UI).
   */
  dispatch: (command: UiCommand) => void;
  /**
   * Switch the cockpit to an agent's working directory (W1a). Used only for the
   * auto-follow arrival agent; omit to never follow.
   */
  switchAgent?: (cwd: string) => void;
  /** Human-facing Shape name for the toast (defaults to the raw name). */
  label?: string;
}

/**
 * Surface the apply outcome honestly: a plain success when everything applied,
 * or a warning toast that lists every degradation note (§7) so a half-satisfied
 * Shape reads as a partially-furnished office, not a silent failure.
 */
function surfaceApplyOutcome(label: string, warnings: string[], owner?: EffectOwner): void {
  if (warnings.length === 0) {
    const method = toast.success;
    const message = `Switched to ${label}`;
    ownedEntry(owner, method, toast, [message]);
    return;
  }
  const noun = warnings.length === 1 ? 'note' : 'notes';
  const method = toast.warning;
  const message = `Switched to ${label} · ${warnings.length} ${noun}`;
  const options = { description: warnings.join('\n') };
  ownedEntry(owner, method, toast, [message, options]);
}

/**
 * Apply an installed Shape and act on the response.
 *
 * @param name - The installed Shape name to apply.
 * @param deps - Injected transport, query client, dispatcher, and optional agent-switch.
 * @returns The apply result (`{ ok, applied, warnings, offeredAgents }`) for the caller to surface further.
 */
export async function applyShapeAction(
  name: string,
  deps: ApplyShapeActionDeps
): Promise<ApplyShapeResult> {
  const owner = deps.effectOwner;
  const transport = deps.transport;
  const apply = transport.applyShape;
  const result = await ownedEntry(owner, apply, transport, [name]);
  owner?.beforeEffect();

  // Each nested layout effect retains the same originating occurrence.
  const dispatch = deps.dispatch;
  applyShapeLayout(result.applied.layout, (command) =>
    ownedEntry(owner, dispatch, deps, [command])
  );

  // Admission transfers only this reload transaction to the genuine provider.
  // Reload may retire the initiating extension: later effects then refuse.
  const remount = ownedEntry(owner, requestExtensionRemount, undefined, []);
  void remount.catch((err: unknown) => {
    // This is a diagnostic, not permission for another host mutation.
    console.error('[shapes] Extension remount after apply failed:', err);
  });

  const query = deps.queryClient;
  const invalidate = query.invalidateQueries;
  const request = { queryKey: shapeKeys.all };
  void ownedEntry(owner, invalidate, query, [request]);
  surfaceApplyOutcome(deps.label ?? name, result.warnings, owner);

  const arrival = result.offeredAgents.find((a) => a.arrival && a.autoFollow && a.projectPath);
  const switchAgent = deps.switchAgent;
  const cwd = arrival?.projectPath;
  if (cwd && switchAgent) ownedEntry(owner, switchAgent, deps, [cwd]);
  owner?.beforeEffect();
  return result;
}

/** Capture preparation first; the genuine owner is checked at each host entry. */
function ownedEntry<Args extends unknown[], T>(
  owner: EffectOwner | undefined,
  method: (...args: Args) => T,
  receiver: unknown,
  args: Args
): T {
  const check = owner?.beforeEffect;
  if (check) Reflect.apply(check, owner, []);
  return Reflect.apply(method, receiver, args) as T;
}

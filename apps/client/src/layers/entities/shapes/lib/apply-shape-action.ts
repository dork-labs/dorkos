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
import { requestExtensionRemount } from '@/layers/shared/lib';
import { applyShapeLayout } from './apply-shape-layout';
import { shapeKeys } from '../api/query-keys';

/** Injected dependencies for {@link applyShapeAction}. */
export interface ApplyShapeActionDeps {
  /** The active transport (only `applyShape` is used). */
  transport: Pick<Transport, 'applyShape'>;
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
function surfaceApplyOutcome(label: string, warnings: string[]): void {
  if (warnings.length === 0) {
    toast.success(`Switched to ${label}`);
    return;
  }
  const noun = warnings.length === 1 ? 'note' : 'notes';
  toast.warning(`Switched to ${label} · ${warnings.length} ${noun}`, {
    description: warnings.join('\n'),
  });
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
  const result = await deps.transport.applyShape(name);

  // Restore the chrome from the returned layout (no second fetch).
  applyShapeLayout(result.applied.layout, deps.dispatch);

  // Live-remount the extension slots so any newly-activated extension appears
  // without a reload (W1c). Fire-and-forget: a rejected remount leaves the
  // previous extensions live, so it must not fail the switch.
  void requestExtensionRemount().catch((err: unknown) => {
    console.error('[shapes] Extension remount after apply failed:', err);
  });

  // Refresh the installed-Shapes list so the active flag flips.
  void deps.queryClient.invalidateQueries({ queryKey: shapeKeys.all });

  surfaceApplyOutcome(deps.label ?? name, result.warnings);

  // Auto-follow the arrival agent only when the person opted in and the agent
  // actually exists (the server sets `autoFollow` from `ui.shapes.autoFollowAgent`).
  const arrival = result.offeredAgents.find((a) => a.arrival && a.autoFollow && a.projectPath);
  if (arrival?.projectPath && deps.switchAgent) {
    deps.switchAgent(arrival.projectPath);
  }

  return result;
}

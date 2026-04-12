import { z } from 'zod';
import type { ZodObject, ZodRawShape } from 'zod';

/**
 * URL search params for deep-linking modal dialogs.
 *
 * Merged into every route's `validateSearch` schema via `mergeDialogSearch`
 * so dialog deep links work from any page without route-specific wiring.
 *
 * Each dialog uses two patterns:
 *  - Boolean-ish: `?tasks=open` opens the dialog (any non-empty value works,
 *    but `'open'` is the canonical form for parameterless dialogs)
 *  - Tab-targeted: `?settings=tools` opens the dialog to a specific tab
 *
 * Sub-section anchors use a sibling param (e.g. `?settings=tools&settingsSection=mcp`).
 */
export const dialogSearchSchema = z.object({
  // Settings
  settings: z.string().optional(),
  settingsSection: z.string().optional(),
  // Agent dialog (legacy — use panel=agent-hub for new links)
  agent: z.string().optional(),
  agentPath: z.string().optional(),
  // Shell-level right panel
  panel: z.string().optional(),
  hubTab: z.string().optional(),
  // Other dialogs (parameterless — no tabs)
  tasks: z.string().optional(),
  relay: z.string().optional(),
});

export type DialogSearch = z.infer<typeof dialogSearchSchema>;

/**
 * Merge dialog search params into a route's existing search schema.
 *
 * @example
 * const sessionSearchSchema = mergeDialogSearch(
 *   z.object({ session: z.string().optional(), dir: z.string().optional() })
 * );
 */
export function mergeDialogSearch<T extends ZodRawShape>(routeSchema: ZodObject<T>) {
  return routeSchema.merge(dialogSearchSchema);
}

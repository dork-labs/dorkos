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
  // Legacy agent dialog. Nothing writes these any more; they are still parsed so
  // `useLegacyProfileLinkRedirect` can see an old bookmark and rewrite it to
  // `?panel=profile`. Old directory addresses become opaque profileRef values.
  agent: z.string().optional(),
  agentPath: z.string().optional(),
  profileRef: z.string().optional(),
  // Shell-level right panel: which tab, and (LEGACY) which inner tab of the
  // agent panel the profile replaced. `hubTab` is kept only so the redirect
  // above can read an old bookmark and translate it; nothing writes it, and
  // `profilePage` is its successor.
  panel: z.string().optional(),
  hubTab: z.string().optional(),
  // Profile — the one param that names a subject rather than a tab: the roster
  // id whose profile is open, so a profile is an address.
  profile: z.string().optional(),
  // Which page of that profile is pushed on top of it (`ProfilePageId`), so a
  // page is an address too. Typed as a plain string here because the ids belong
  // to the profile feature and `shared/` may not import it; the feature parses
  // it back (`asProfilePageId`) and lands on the root when it names no page.
  profilePage: z.string().optional(),
  // The Inbox: `open`, or the id of one waiting item to focus. Read once and
  // removed by `useInboxDeepLink`. Coerced because the app's search parser
  // reads a number-looking id as a number.
  inbox: z.coerce.string().optional().catch(undefined),
  // Other dialogs (parameterless — no tabs)
  tasks: z.string().optional(),
  relay: z.string().optional(),
});

export type DialogSearch = z.infer<typeof dialogSearchSchema>;

/**
 * How the desktop tab history (DOR-2107) treats each param above — the one
 * place that split is written down. Every schema key is in exactly one list
 * (`dialog-search-schema.test.ts` fails otherwise).
 *
 * - **Modifiers** put something over the page you are on: a modal dialog, the
 *   right panel, a one-shot inbox focus, or a legacy key a redirect rewrites.
 *   Opening or closing one is not going anywhere, so it rewrites the tab's
 *   current history entry instead of adding a Back step that reopens it.
 * - **Addresses** name a subject: which profile, which page of it, which agent.
 *   A profile chain (an owner, then an agent they manage, then a page) is a
 *   series of places the profile hooks deliberately PUSH so Back walks it, so
 *   these are left to the router's own PUSH and REPLACE.
 */
export const DIALOG_MODIFIER_KEYS = [
  'settings',
  'settingsSection',
  'tasks',
  'relay',
  'inbox',
  'panel',
  'agent',
  'hubTab',
] as const satisfies readonly (keyof DialogSearch)[];

/** The dialog params that are addresses, not modifiers — see {@link DIALOG_MODIFIER_KEYS}. */
export const DIALOG_ADDRESS_KEYS = [
  'profile',
  'profilePage',
  'agentPath',
  'profileRef',
] as const satisfies readonly (keyof DialogSearch)[];

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

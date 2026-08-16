/**
 * Profile feature — one panel for any identity on this install, with two homes
 * and a push-in stack (spec `profile-unification`).
 *
 * A feature rather than part of the Team page: the profile is reachable from
 * every route through `?profile=<member id>` and mounts once in `DialogHost`,
 * so it belongs to no single surface.
 *
 * The URL state itself lives in `shared/model/use-dialog-deep-link`
 * (`useProfileDeepLink`) beside its Settings and Tasks siblings, so the surfaces
 * that open a profile — rooms, the roster, the sidebar — reach it without
 * importing this feature's internals.
 *
 * @module features/profile
 */
export { ProfileView, type ProfileViewProps } from './ui/ProfileView';
export { ProfileSheet, type ProfileSheetProps } from './ui/ProfileSheet';
export { ProfileSheetContainer, type ProfileSheetContainerProps } from './ui/ProfileSheetContainer';
// The docked home: the right-panel tab on a session. `ProfileDock` is reached
// through the contribution registry (lazily), so the barrel carries it for the
// registration and the playground; everything else opens the panel through
// `openProfileDocked` instead of rendering it.
export { ProfileDock } from './ui/ProfileDock';
export { PROFILE_PANEL_ID, useProfileStore } from './model/profile-store';
export {
  useProfileDockDeepLink,
  useLegacyProfileLinkRedirect,
} from './model/use-profile-dock-deep-link';
export { AccountMenu, type AccountMenuProps } from './ui/AccountMenu';
// `AccountMenuRows` is deliberately NOT on the barrel: the two surfaces that
// draw it — the disc's own menu and the sidebar footer's `⋯` fold — both reach
// it through `AccountMenuContainer`, which is what knows who you are. A second
// public door would invite a caller to render the rows with a member it
// resolved itself.
export { AccountMenuContainer } from './ui/AccountMenuContainer';
export { ProfilePanel, type ProfilePanelProps } from './ui/ProfilePanel';
export { ProfilePanelContainer } from './ui/ProfilePanelContainer';
// The stack's shape, for callers that build one: the playground, and the two
// homes. Its reducers stay inside the feature (`model/profile-stack`) — the
// sheet drives them from the URL, and the docked panel (W2.3) will drive them
// from a store that lives in here too.
export {
  profileStack,
  type ProfilePageId,
  type ProfileStackEntry,
  type ProfileStackState,
} from './model/profile-stack';
// Exported for the playground, which shows the three handle refusals side by
// side. Rendering them through the real mapping is what stops the showcase
// drifting into a set of sentences the product no longer says.
export { handleErrorMessage } from './model/profile-errors';

/**
 * Profile feature — the one panel that shows any identity on this install.
 *
 * A feature rather than part of the Team page: the drawer is reachable from
 * every route through `?profile=<member id>` and mounts once in `DialogHost`,
 * so it belongs to no single surface (spec `identity-consistency` §W3.2).
 *
 * The URL state itself lives in `shared/model/use-dialog-deep-link`
 * (`useProfileDeepLink`) beside its Settings and Tasks siblings, so the surfaces
 * that open a profile — rooms, the roster, the sidebar — reach it without
 * importing this feature's internals.
 *
 * @module features/profile
 */
export { ProfileDrawer, type ProfileDrawerProps } from './ui/ProfileDrawer';
export {
  ProfileDrawerContainer,
  type ProfileDrawerContainerProps,
} from './ui/ProfileDrawerContainer';
export { AccountMenu, type AccountMenuProps } from './ui/AccountMenu';
// `AccountMenuRows` is deliberately NOT on the barrel: the two surfaces that
// draw it — the disc's own menu and the sidebar footer's `⋯` fold — both reach
// it through `AccountMenuContainer`, which is what knows who you are. A second
// public door would invite a caller to render the rows with a member it
// resolved itself.
export { AccountMenuContainer } from './ui/AccountMenuContainer';
export { ProfilePanel, type ProfilePanelProps } from './ui/ProfilePanel';
export { ProfilePanelContainer } from './ui/ProfilePanelContainer';
// Exported for the playground, which shows the three handle refusals side by
// side. Rendering them through the real mapping is what stops the showcase
// drifting into a set of sentences the product no longer says.
export { handleErrorMessage } from './model/profile-errors';

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

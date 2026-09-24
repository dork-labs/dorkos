/**
 * The agent permission model, as the app reads and writes it (spec
 * `agent-permissions`): the default layer, one agent's settings, the history,
 * and the one write hook every permission surface uses.
 *
 * An entity rather than a corner of `agent` or `config`, because the question
 * spans both: the defaults live in config, each agent's differences in its
 * manifest, and the server answers them together.
 *
 * @module entities/permissions
 */
export { permissionKeys } from './model/permission-keys';
export { usePermissions } from './model/use-permissions';
export { useAgentPermissions } from './model/use-agent-permissions';
export { useOverridingAgents } from './model/use-overriding-agents';
export { usePermissionHistory } from './model/use-permission-history';
export {
  useSetPermission,
  type PermissionScope,
  type SetPermissionInput,
} from './model/use-set-permission';

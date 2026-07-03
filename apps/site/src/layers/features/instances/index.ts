/**
 * Device-link instances feature — the dorkos.ai UI for linking and managing
 * local DorkOS instances (accounts-and-auth P2, task 2.3): the `/activate`
 * approval panel and the `/account/instances` registry. Every component reaches
 * the device-flow and instance endpoints only through the `@/lib/auth-client`
 * wrappers.
 *
 * @module features/instances
 */
export { ActivatePanel } from './ui/ActivatePanel';
export { InstanceRegistry } from './ui/InstanceRegistry';

/**
 * The persona move (`agent.migrate_persona`) mounted as the app mounts it, with
 * the deps the composition root gives it, for route tests (DOR-4978).
 *
 * @module routes/__tests__/persona-move-group
 */
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import type { MountedGroup } from '../../http/__tests__/hono-group-listener.js';
import { migratePersonaCapability } from '../../services/mesh/doors/agent-persona-capability.js';
import { agentPersonaDeps } from '../../startup/steps/agent-persona-deps.js';

/**
 * The persona move's REST path, on its own registry.
 *
 * @returns The group, mounted at the root.
 */
export function personaMoveGroup(): MountedGroup {
  return capabilityGroup(
    { name: 'agent', capabilities: [migratePersonaCapability] },
    { agentHomeDeps: agentPersonaDeps }
  );
}

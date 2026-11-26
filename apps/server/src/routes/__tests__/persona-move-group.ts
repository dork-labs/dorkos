/**
 * The persona move (`agent.migrate_persona`) and the agent a folder belongs to
 * (`agent.current`, `GET /api/agents/current`) mounted as the app mounts them,
 * with the deps the composition root gives them, for route tests (DOR-4978).
 *
 * @module routes/__tests__/persona-move-group
 */
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import type { MountedGroup } from '../../http/__tests__/hono-group-listener.js';
import { migratePersonaCapability } from '../../services/mesh/doors/agent-persona-capability.js';
import { agentCurrentCapability } from '../../services/mesh/doors/agent-current-capability.js';
import { agentPersonaDeps } from '../../startup/steps/agent-persona-deps.js';

/**
 * The two REST paths, on their own registry.
 *
 * @returns The group, mounted at the root.
 */
export function personaMoveGroup(): MountedGroup {
  return capabilityGroup(
    { name: 'agent', capabilities: [migratePersonaCapability, agentCurrentCapability] },
    { agentHomeDeps: agentPersonaDeps }
  );
}

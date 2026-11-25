/**
 * The agent registry's doors on `/api/mesh/*` as one capability domain
 * (DOR-4978, ADR 261123-170830): the reads, open to agents with another
 * agent's private fields left out (`mesh-read-capabilities.ts`), and a
 * person's changes (`mesh-write-capabilities.ts`).
 *
 * Six routes stay by hand for now (`routes/mesh.ts`): `PATCH
 * /api/mesh/agents/:id`, which holds a credits change for "Confirm it's you";
 * the heartbeat, which a Wi-Fi sign-in may send on purpose; three reads whose
 * lists do not page yet (the folder list, an agent's reach and health); and
 * one agent's read, whose `{id}` would otherwise answer `/agents/paths`.
 *
 * @module services/mesh/doors/mesh-capabilities
 */
import type { CapabilityDomain } from '../../core/capabilities/index.js';
import { meshOf } from './mesh-capability-deps.js';
import { MESH_READ_CAPABILITIES } from './mesh-read-capabilities.js';
import { MESH_WRITE_CAPABILITIES } from './mesh-write-capabilities.js';

/** The agent registry's doors; on every server whose mesh started. */
export const meshDomain: CapabilityDomain = {
  name: 'mesh',
  assertDeps: meshOf,
  capabilities: [...MESH_READ_CAPABILITIES, ...MESH_WRITE_CAPABILITIES],
};

/** Host-owned Mesh identity and durable computer placement; no guest files are mounted. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { writePrivate } from '../services/computers/backend/private-storage.js';

let mesh: Pick<MeshCore, 'registerByPath'> | undefined;
/** Compose the existing admitted Mesh instance after its startup. */
export function configureComputerMesh(value: Pick<MeshCore, 'registerByPath'>): void {
  mesh = value;
}

/** Hydrate retained placement before event broadcasters; seed only on explicit setup. */
export async function createComputerAgentIdentity(
  root: string,
  anchor: string
): Promise<() => Promise<string>> {
  const path = join(root, 'agent.json');
  let retained: string | undefined;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 1024
      )
        throw new Error('COMPUTER_AGENT_RECORD_REFUSED');
      const record = JSON.parse(await file.readFile('utf8')) as { id?: unknown; anchor?: unknown };
      if (typeof record.id !== 'string' || record.anchor !== anchor)
        throw new Error('COMPUTER_AGENT_RECORD_REFUSED');
      runtimeRegistry.configureComputerAgentBinding(record.id, anchor);
      retained = record.id;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let pending: Promise<string> | undefined;
  return () =>
    (pending ??= (async () => {
      if (!mesh) throw new Error('COMPUTER_MESH_UNAVAILABLE');
      const agent = await mesh.registerByPath(
        anchor,
        { name: 'Computer', runtime: 'opencode' },
        'dorkos-system'
      );
      if (agent.runtime !== 'opencode' || (retained && retained !== agent.id))
        throw new Error('COMPUTER_AGENT_IDENTITY_REFUSED');
      await writePrivate(path, JSON.stringify({ id: agent.id, anchor }));
      runtimeRegistry.configureComputerAgentBinding(agent.id, anchor);
      retained = agent.id;
      return agent.id;
    })().finally(() => {
      pending = undefined;
    }));
}

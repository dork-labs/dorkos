/**
 * Direct mesh methods factory — agent identity backed by manifest files
 * (`.dork/agent.json`) via direct filesystem access.
 *
 * Mirrors the agent-identity portion of `transport/mesh-methods.ts` (the HTTP
 * twin). Mesh registry/topology operations are server-only in embedded mode;
 * their stubs live in `stub-methods.ts`.
 *
 * @module shared/lib/direct/mesh-methods
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Create the agent-identity methods (manifest read / init / update). */
export function createDirectMeshMethods() {
  return {
    async getAgentByPath(agentPath: string): Promise<AgentManifest | null> {
      const { readManifest } = await import('@dorkos/shared/manifest');
      return readManifest(agentPath);
    },

    async resolveAgents(paths: string[]): Promise<Record<string, AgentManifest | null>> {
      const { readManifest } = await import('@dorkos/shared/manifest');
      const result: Record<string, AgentManifest | null> = {};
      await Promise.all(
        paths.map(async (p) => {
          result[p] = await readManifest(p);
        })
      );
      return result;
    },

    async initAgent(
      agentPath: string,
      name?: string,
      description?: string,
      runtime?: string
    ): Promise<AgentManifest> {
      const { readManifest, writeManifest } = await import('@dorkos/shared/manifest');
      const pathMod = await import('path');
      const existing = await readManifest(agentPath);
      if (existing) return existing;

      const manifest: AgentManifest = {
        id: crypto.randomUUID(),
        name: name ?? pathMod.default.basename(agentPath),
        description: description ?? '',
        runtime: (runtime as AgentManifest['runtime']) ?? 'claude-code',
        capabilities: [],
        behavior: { responseMode: 'always' },
        budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
        registeredAt: new Date().toISOString(),
        registeredBy: 'dorkos-obsidian',
        personaEnabled: true,
        enabledToolGroups: {},
      };
      await writeManifest(agentPath, manifest);
      return manifest;
    },

    async updateAgentByPath(
      agentPath: string,
      updates: Partial<AgentManifest>
    ): Promise<AgentManifest> {
      const { readManifest, writeManifest } = await import('@dorkos/shared/manifest');
      const existing = await readManifest(agentPath);
      if (!existing) throw new Error(`No agent registered at path: ${agentPath}`);
      const updated: AgentManifest = { ...existing, ...updates };
      await writeManifest(agentPath, updated);
      return updated;
    },
  };
}

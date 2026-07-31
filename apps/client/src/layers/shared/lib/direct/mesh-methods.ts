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
import type { AgentManifest, AgentManifestUpdate } from '@dorkos/shared/mesh-schemas';

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

    async updateAgentByPath(
      agentPath: string,
      updates: AgentManifestUpdate
    ): Promise<AgentManifest> {
      const { readManifest, writeManifest } = await import('@dorkos/shared/manifest');
      const existing = await readManifest(agentPath);
      if (!existing) throw new Error(`No agent registered at path: ${agentPath}`);
      // `null` means "go back to inheriting the server default", which on a
      // manifest is the ABSENCE of the key — the HTTP route does the same thing
      // server-side. Merging it through would write `"model": null`, which the
      // manifest schema does not admit and which the resolver would read as a
      // set-but-empty value rather than as no opinion at all.
      const cleared = Object.entries(updates)
        .filter(([, value]) => value === null)
        .map(([key]) => key);
      const updated = { ...existing, ...updates } as Record<string, unknown>;
      for (const key of cleared) delete updated[key];
      await writeManifest(agentPath, updated as unknown as AgentManifest);
      return updated as unknown as AgentManifest;
    },
  };
}

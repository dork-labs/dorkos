/**
 * Manifest reader/writer for agent `.dork/agent.json` files.
 *
 * Provides atomic file writing (temp file + rename) and Zod-validated
 * reading of agent manifests stored in project directories.
 *
 * @module mesh/manifest
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const MANIFEST_DIR = '.dork';
const MANIFEST_FILE = 'agent.json';

/**
 * Read and validate an agent manifest from a project directory.
 *
 * @param projectDir - Project directory containing `.dork/agent.json`
 * @returns Parsed manifest, or `null` if the file doesn't exist or fails validation
 */
export async function readManifest(projectDir: string): Promise<AgentManifest | null> {
  const manifestPath = path.join(projectDir, MANIFEST_DIR, MANIFEST_FILE);
  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    const result = AgentManifestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Write an agent manifest to a project directory atomically.
 *
 * Creates the `.dork/` directory if it doesn't exist. Writes to a temp
 * file first, then atomically renames to `agent.json` to prevent partial
 * writes from corrupting the manifest.
 *
 * @param projectDir - Project directory to write `.dork/agent.json` into
 * @param manifest - The agent manifest to write
 */
export async function writeManifest(projectDir: string, manifest: AgentManifest): Promise<void> {
  const dorkDir = path.join(projectDir, MANIFEST_DIR);
  await fs.mkdir(dorkDir, { recursive: true });

  const manifestPath = path.join(dorkDir, MANIFEST_FILE);
  const tempPath = path.join(dorkDir, `.agent-${randomUUID()}.tmp`);

  const content = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, manifestPath);
}

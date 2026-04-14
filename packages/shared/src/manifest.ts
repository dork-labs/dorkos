/**
 * Manifest reader/writer for agent `.dork/agent.json` files.
 *
 * Provides atomic file writing (temp file + rename) and Zod-validated
 * reading of agent manifests stored in project directories.
 *
 * @module shared/manifest
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentManifestSchema } from './mesh-schemas.js';
import type { AgentManifest } from './mesh-schemas.js';

export const MANIFEST_DIR = '.dork';
export const MANIFEST_FILE = 'agent.json';

/**
 * Read and validate an agent manifest from a project directory.
 *
 * @param projectPath - Project directory containing `.dork/agent.json`
 * @returns Parsed manifest, or `null` if the file doesn't exist or fails validation
 */
export async function readManifest(projectPath: string): Promise<AgentManifest | null> {
  const manifestPath = path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE);
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
 * @param projectPath - Project directory to write `.dork/agent.json` into
 * @param manifest - The agent manifest to write
 */
export async function writeManifest(projectPath: string, manifest: AgentManifest): Promise<void> {
  const dorkDir = path.join(projectPath, MANIFEST_DIR);
  await fs.mkdir(dorkDir, { recursive: true });

  const manifestPath = path.join(dorkDir, MANIFEST_FILE);
  const tempPath = path.join(dorkDir, `.agent-${randomUUID()}.tmp`);

  const content = JSON.stringify(manifest, null, 2) + '\n';
  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, manifestPath);
}

/**
 * Remove the agent manifest file from a project directory.
 *
 * @param projectPath - Absolute path to the agent's project directory
 */
export async function removeManifest(projectPath: string): Promise<void> {
  try {
    await fs.unlink(path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE));
  } catch {
    // Best-effort cleanup — ignore if file already gone
  }
}

/**
 * Remove the entire `.dork` directory for an agent project.
 *
 * @param projectPath - Absolute path to the project directory
 * @returns List of deleted file paths relative to the project root
 */
export async function removeDorkDirectory(projectPath: string): Promise<string[]> {
  const dorkPath = path.join(projectPath, MANIFEST_DIR);

  const stat = await fs.stat(dorkPath).catch(() => null);
  if (!stat?.isDirectory()) return [];

  const entries = await fs.readdir(dorkPath, { recursive: true });

  await fs.rm(dorkPath, { recursive: true, force: true });

  return entries.map((e) => path.join(MANIFEST_DIR, String(e)));
}

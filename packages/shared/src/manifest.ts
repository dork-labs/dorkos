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
import type { Logger } from './logger.js';

export const MANIFEST_DIR = '.dork';
export const MANIFEST_FILE = 'agent.json';

/**
 * Read and validate an agent manifest from a project directory.
 *
 * The return contract is `null` for both "no manifest here" and "manifest
 * present but invalid" so callers can treat a directory as un-agented either
 * way. The two cases differ operationally, though: a missing file is the
 * common, expected case and stays silent, while a present-but-invalid file is
 * a divergent on-disk state (a schema-invalid manifest `safeParse`s to `null`
 * forever) — so it is logged with the offending path and issues.
 *
 * @param projectPath - Project directory containing `.dork/agent.json`
 * @param logger - Warn sink for present-but-invalid manifests (defaults to `console`)
 * @returns Parsed manifest, or `null` if the file doesn't exist or fails validation
 */
export async function readManifest(
  projectPath: string,
  logger: Pick<Logger, 'warn'> = console
): Promise<AgentManifest | null> {
  const manifestPath = path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE);

  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    // Missing or unreadable file — the expected "not an agent" case. Silent.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger.warn(
      `[manifest] ${manifestPath} contains invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }

  const result = AgentManifestSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      `[manifest] ${manifestPath} failed schema validation: ${JSON.stringify(result.error.issues)}`
    );
    return null;
  }
  return result.data;
}

/**
 * Write an agent manifest to a project directory atomically.
 *
 * Creates the `.dork/` directory if it doesn't exist. Writes to a temp
 * file first, then atomically renames to `agent.json` to prevent partial
 * writes from corrupting the manifest.
 *
 * Validates `manifest` against {@link AgentManifestSchema} before touching the
 * filesystem — persisting a schema-invalid manifest would make {@link readManifest}
 * `safeParse` it to `null` forever, so the write is rejected up front with a
 * clear error rather than leaving a permanently unreadable file on disk.
 *
 * @param projectPath - Project directory to write `.dork/agent.json` into
 * @param manifest - The agent manifest to write
 * @throws Error when `manifest` fails schema validation
 */
export async function writeManifest(projectPath: string, manifest: AgentManifest): Promise<void> {
  const dorkDir = path.join(projectPath, MANIFEST_DIR);
  const manifestPath = path.join(dorkDir, MANIFEST_FILE);

  const validation = AgentManifestSchema.safeParse(manifest);
  if (!validation.success) {
    throw new Error(
      `Refusing to write invalid agent manifest to ${manifestPath}: ${JSON.stringify(
        validation.error.issues
      )}`
    );
  }

  await fs.mkdir(dorkDir, { recursive: true });

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

/**
 * Filesystem gathering for the deep health checks.
 *
 * These functions do the reading that `checks.ts` deliberately does not. They
 * are read-only — no file is created, moved, or repaired — and they never
 * throw: an unreadable folder contributes nothing rather than failing the whole
 * report.
 *
 * @module services/observability/deep-health/collect
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentManifestLocation } from './checks.js';

/** The per-agent settings file, relative to the agent's project folder. */
const AGENT_MANIFEST_RELATIVE_PATH = path.join('.dork', 'agent.json');

/**
 * Read the agent id each folder's manifest claims.
 *
 * A folder with no manifest, or one that cannot be read, contributes nothing —
 * that is a different problem from two folders claiming one id, and this check
 * is only about the second.
 *
 * @param directories - Absolute paths of agent project folders.
 * @returns One entry per folder that has a readable manifest with an id.
 */
export function collectAgentManifests(directories: readonly string[]): AgentManifestLocation[] {
  const found: AgentManifestLocation[] = [];
  for (const directory of new Set(directories)) {
    const id = readManifestId(path.join(directory, AGENT_MANIFEST_RELATIVE_PATH));
    if (id) found.push({ id, directory });
  }
  return found;
}

/**
 * List the immediate subfolders of the agents home, which is where agents
 * created inside DorkOS (including DorkBot) keep their manifests.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @returns Absolute paths of every folder directly under `<dorkHome>/agents`.
 */
export function listAgentHomeDirectories(dorkHome: string): string[] {
  const agentsHome = path.join(dorkHome, 'agents');
  return readDirNames(agentsHome).map((name) => path.join(agentsHome, name));
}

/** The `id` a manifest claims, or `null` when it has none we can read. */
function readManifestId(manifestPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id = (parsed as { id?: unknown }).id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Names of the immediate subdirectories of `dir`, or none when unreadable. */
function readDirNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

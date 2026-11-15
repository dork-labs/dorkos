/**
 * The Activity line for a folder whose own Codex settings DorkOS let load
 * (DOR-4408): at Full, DorkOS trusts the folder, so Codex reads its
 * `.codex/config.toml`, and any MCP server that file names runs. Names only:
 * the file, never what it says.
 *
 * Once per folder and file content, so a chat that runs twenty turns there
 * leaves one line. Remembered in memory only: a restart may say it once more.
 *
 * @module services/runtimes/codex/app-server/project-config-activity
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityService } from '../../../activity/activity-service.js';

/** The project file Codex reads in a trusted folder. */
const PROJECT_CONFIG = path.join('.codex', 'config.toml');
/** The largest file hashed; past it the line is still written, once per size. */
const MAX_HASHED_BYTES = 256 * 1024;

/** One line for the feed. */
export interface ProjectConfigActivityEntry {
  /** The folder, by real path. */
  cwd: string;
  /** The sentence. */
  summary: string;
}

type ProjectConfigActivityPort = (entry: ProjectConfigActivityEntry) => void;

let port: ProjectConfigActivityPort | undefined;
/** The content last said per folder. */
const said = new Map<string, string>();

/**
 * Hand the loader the Activity writer.
 *
 * @param next - The writer, or `undefined` to stop writing (tests).
 */
export function setProjectConfigActivity(next: ProjectConfigActivityPort | undefined): void {
  port = next;
}

/**
 * Build the writer that records a loaded folder config in the Activity feed.
 *
 * @param activityService - The Activity feed writer.
 */
export function createProjectConfigActivityWriter(
  activityService: ActivityService
): ProjectConfigActivityPort {
  return (entry) => {
    void activityService.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'system',
      eventType: 'codex_project_config.loaded',
      resourceType: 'folder',
      resourceId: entry.cwd,
      summary: entry.summary,
      metadata: { file: PROJECT_CONFIG },
    });
  };
}

/** Forget every remembered folder (tests). */
export function forgetProjectConfigActivity(): void {
  said.clear();
}

/**
 * Say a trusted folder's own Codex settings load, once per content, and only
 * when the folder has them.
 *
 * @param realCwd - The folder, by real path.
 */
export function noteProjectConfigTrusted(realCwd: string): void {
  const digest = digestOf(path.join(realCwd, PROJECT_CONFIG));
  if (digest === null || said.get(realCwd) === digest) return;
  said.set(realCwd, digest);
  port?.({
    cwd: realCwd,
    summary: `Codex loaded ${PROJECT_CONFIG} in ${path.basename(realCwd)} at Full.`,
  });
}

/** A short digest of a regular file, or `null` when there is none. */
function digestOf(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_HASHED_BYTES) return `size:${stat.size}`;
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

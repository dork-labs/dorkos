/**
 * The Activity lines for repo settings a launch paused, and for when they run
 * again (DOR-3298). Names only: a file name or a settings key, never what it
 * says.
 *
 * Each worktree and kind says "paused" once per content, and "running again"
 * once after that, so a chat that runs twenty turns in a paused worktree
 * leaves one line, not twenty. Remembered in memory only: a restart may say
 * "paused" once more.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-config-activity
 */
import type { ActivityService } from '../../../activity/activity-service.js';
import type { RepoConfigKind } from './repo-config-consent.js';

/** One line for the feed. */
export interface RepoConfigActivityEntry {
  /** Which setting. */
  kind: RepoConfigKind;
  /** Whether it paused or runs again. */
  state: 'paused' | 'running';
  /** The worktree's folder. */
  cwd: string;
  /** The sentence. */
  summary: string;
}

/** Where entries go; set at boot. */
type RepoConfigActivityPort = (entry: RepoConfigActivityEntry) => void;

let port: RepoConfigActivityPort | undefined;

/**
 * Hand the launch the Activity writer.
 *
 * @param next - The writer, or `undefined` to stop writing (tests).
 */
export function setRepoConfigActivity(next: RepoConfigActivityPort | undefined): void {
  port = next;
}

/**
 * Build the writer that records paused repo settings in the Activity feed.
 *
 * @param activityService - The Activity feed writer.
 */
export function createRepoConfigActivityWriter(
  activityService: ActivityService
): RepoConfigActivityPort {
  return (entry) => {
    void activityService.emit({
      actorType: 'system',
      actorLabel: 'DorkOS',
      category: 'system',
      eventType: entry.state === 'paused' ? 'repo_config.paused' : 'repo_config.running',
      resourceType: 'folder',
      resourceId: entry.cwd,
      summary: entry.summary,
      metadata: { kind: entry.kind },
    });
  };
}

/** What each kind is called in a line. */
const NOUN: Record<RepoConfigKind, string> = {
  hooks: 'repo hooks',
  local: 'local settings',
  mcpJson: 'repo MCP servers',
};

/** The last paused content per worktree and kind. */
const pausedNow = new Map<string, string>();

/** Forget every remembered state (tests). */
export function forgetRepoConfigActivity(): void {
  pausedNow.clear();
}

/**
 * Say a setting is paused in a worktree, once per content.
 *
 * @param kind - Which setting.
 * @param cwd - The worktree's folder.
 * @param worktree - Its name, for the line.
 * @param what - What changed, by name (`.claude/settings.json changed`).
 * @param digest - The paused content, so the same pause is said once.
 */
export function notePaused(
  kind: RepoConfigKind,
  cwd: string,
  worktree: string,
  what: string,
  digest: string
): void {
  const key = `${kind}\u0000${cwd}`;
  if (pausedNow.get(key) === digest) return;
  pausedNow.set(key, digest);
  port?.({ kind, state: 'paused', cwd, summary: `Paused ${NOUN[kind]} in ${worktree}: ${what}.` });
}

/**
 * Say a setting runs again in a worktree, only if it was said to be paused.
 *
 * @param kind - Which setting.
 * @param cwd - The worktree's folder.
 * @param worktree - Its name, for the line.
 */
export function noteRunning(kind: RepoConfigKind, cwd: string, worktree: string): void {
  const key = `${kind}\u0000${cwd}`;
  if (!pausedNow.delete(key)) return;
  const noun = NOUN[kind];
  port?.({
    kind,
    state: 'running',
    cwd,
    summary: `${noun[0].toUpperCase()}${noun.slice(1)} running again in ${worktree}.`,
  });
}

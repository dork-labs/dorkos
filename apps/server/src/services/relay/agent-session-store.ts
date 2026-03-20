/**
 * Persistent store mapping Mesh agent ULIDs to their SDK session UUIDs.
 *
 * Survives server restarts so conversation threads are not lost when a relay
 * message arrives for an agent that was previously contacted.
 *
 * Storage: {relayDir}/agent-sessions.json
 * Format: { [agentId: string]: AgentSessionRecord }
 *
 * Uses atomic tmp+rename writes to prevent corruption under concurrent updates.
 *
 * @module services/relay/agent-session-store
 */
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { logger } from '../../lib/logger.js';

export interface AgentSessionRecord {
  /** SDK session UUID assigned by Claude Agent SDK on first message. */
  sdkSessionId: string;
  /** ISO timestamp when the mapping was first created. */
  createdAt: string;
  /** ISO timestamp of the last update to this mapping. */
  updatedAt: string;
}

/** Minimal interface consumed by ClaudeCodeAdapter (in packages/relay). */
export interface AgentSessionStoreLike {
  get(agentId: string): string | undefined;
  set(agentId: string, sdkSessionId: string): void;
}

/**
 * Persistent store for agentId → SDK session UUID mappings.
 *
 * @example
 * const store = new AgentSessionStore('/home/user/.dork/relay');
 * await store.init();
 * store.set('01JN4M2X...', '550e8400-...');
 * const sdkId = store.get('01JN4M2X...'); // '550e8400-...'
 */
export class AgentSessionStore implements AgentSessionStoreLike {
  private readonly filePath: string;
  private sessions: Map<string, AgentSessionRecord> = new Map();
  /** Serializes persist calls to prevent concurrent tmp+rename races. */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(relayDir: string) {
    this.filePath = join(relayDir, 'agent-sessions.json');
  }

  /**
   * Load persisted sessions from disk.
   *
   * Non-fatal: missing file starts with empty state; corrupt JSON logs a
   * warning and starts with empty state (no throw).
   */
  async init(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: Record<string, AgentSessionRecord> = JSON.parse(raw);
      this.sessions = new Map(Object.entries(parsed));
      logger.info(`[AgentSessionStore] Loaded ${this.sessions.size} session mapping(s)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File does not exist yet — start empty, will be created on first set()
        logger.debug('[AgentSessionStore] No existing sessions file, starting fresh');
        return;
      }
      // Corrupt JSON or other read error — log warning and start empty
      logger.warn('[AgentSessionStore] Failed to load sessions file, starting with empty state', {
        err,
      });
      this.sessions = new Map();
    }
  }

  /**
   * Get the SDK session UUID for a given Mesh agent ULID.
   *
   * @param agentId - Mesh ULID of the target agent
   * @returns SDK session UUID, or undefined if no mapping exists
   */
  get(agentId: string): string | undefined {
    return this.sessions.get(agentId)?.sdkSessionId;
  }

  /**
   * Set or update the SDK session UUID for a Mesh agent ULID.
   *
   * Updates the in-memory map immediately and persists asynchronously.
   * The in-memory map is always the authoritative source within a process lifetime.
   *
   * @param agentId - Mesh ULID of the agent
   * @param sdkSessionId - SDK session UUID returned by AgentManager after first message
   */
  set(agentId: string, sdkSessionId: string): void {
    const now = new Date().toISOString();
    const existing = this.sessions.get(agentId);
    this.sessions.set(agentId, {
      sdkSessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.persist().catch((err) => {
      logger.warn('[AgentSessionStore] Failed to persist session mapping', { err });
    });
  }

  /**
   * Remove the session mapping for a Mesh agent ULID.
   *
   * @param agentId - Mesh ULID to remove
   */
  delete(agentId: string): void {
    this.sessions.delete(agentId);
    this.persist().catch((err) => {
      logger.warn('[AgentSessionStore] Failed to persist after delete', { err });
    });
  }

  /**
   * Flush any pending writes to disk.
   *
   * Call during shutdown to ensure the last fire-and-forget persist
   * completes before the process exits.
   */
  async shutdown(): Promise<void> {
    try {
      await this.writeLock;
    } catch {
      // Errors already logged by set/delete .catch() handlers
    }
  }

  /** Enqueue an atomic persist, serialized to prevent concurrent tmp+rename races. */
  private persist(): Promise<void> {
    this.writeLock = this.writeLock.then(
      () => this.doPersist(),
      () => this.doPersist()
    );
    return this.writeLock;
  }

  /** Atomic tmp+rename write. Must be serialized via writeLock. */
  private async doPersist(): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });
    const data: Record<string, AgentSessionRecord> = {};
    for (const [agentId, record] of this.sessions) {
      data[agentId] = record;
    }
    const json = JSON.stringify(data, null, 2);
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, json, 'utf-8');
    await rename(tmp, this.filePath);
  }
}

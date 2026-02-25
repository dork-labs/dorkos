import chokidar, { type FSWatcher } from 'chokidar';
import { join } from 'path';
import type { Response } from 'express';
import type { TranscriptReader } from './transcript-reader.js';
import { WATCHER } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

/**
 * SessionBroadcaster manages file watching and SSE broadcasting for cross-client session sync.
 *
 * Watches SDK JSONL transcript files and broadcasts updates to connected SSE clients when
 * file changes are detected. Supports multiple clients per session with automatic cleanup.
 *
 * Usage:
 * ```typescript
 * const broadcaster = new SessionBroadcaster(transcriptReader);
 *
 * // Register SSE client for a session
 * app.get('/api/sessions/:id/sync', (req, res) => {
 *   res.setHeader('Content-Type', 'text/event-stream');
 *   broadcaster.registerClient(req.params.id, vaultRoot, res);
 * });
 *
 * // Cleanup on shutdown
 * process.on('SIGTERM', () => broadcaster.shutdown());
 * ```
 */
export class SessionBroadcaster {
  private clients = new Map<string, Set<Response>>();
  private watchers = new Map<string, FSWatcher>();
  private offsets = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(private transcriptReader: TranscriptReader) {}

  /**
   * Register an SSE client for a session.
   *
   * - Adds the response to the set of connected clients
   * - Starts a file watcher if none exists for this session
   * - Initializes offset to current file size (only broadcast new content)
   * - Sends sync_connected event to the client
   * - Auto-deregisters on response close
   *
   * @param sessionId - Session UUID
   * @param vaultRoot - Vault root path for resolving transcript directory
   * @param res - Express Response object configured for SSE
   */
  registerClient(sessionId: string, vaultRoot: string, res: Response): void {
    // Add client to set
    if (!this.clients.has(sessionId)) {
      this.clients.set(sessionId, new Set());
    }
    this.clients.get(sessionId)!.add(res);

    // Start watcher if this is the first client for this session
    if (!this.watchers.has(sessionId)) {
      this.startWatcher(sessionId, vaultRoot);
    }

    // Send sync_connected event
    res.write(`event: sync_connected\ndata: ${JSON.stringify({ sessionId })}\n\n`);

    // Auto-deregister on close
    res.on('close', () => {
      this.deregisterClient(sessionId, res);
    });
  }

  /**
   * Deregister an SSE client from a session.
   *
   * - Removes the response from the client set
   * - Stops the file watcher if no clients remain for this session
   * - Cleans up offsets and timers
   *
   * @param sessionId - Session UUID
   * @param res - Express Response object to remove
   */
  deregisterClient(sessionId: string, res: Response): void {
    const clientSet = this.clients.get(sessionId);
    if (!clientSet) return;

    clientSet.delete(res);

    // Clean up if no clients remain
    if (clientSet.size === 0) {
      this.clients.delete(sessionId);

      // Stop watcher
      const watcher = this.watchers.get(sessionId);
      if (watcher) {
        watcher.close();
        this.watchers.delete(sessionId);
      }

      // Clean up state
      this.offsets.delete(sessionId);

      const timer = this.debounceTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(sessionId);
      }
    }
  }

  /**
   * Start a chokidar file watcher for a session's JSONL transcript.
   *
   * Watches the SDK transcript file and broadcasts updates on change events.
   * Changes are debounced (100ms) to batch rapid writes during streaming.
   *
   * @param sessionId - Session UUID
   * @param vaultRoot - Vault root path for resolving transcript directory
   */
  private startWatcher(sessionId: string, vaultRoot: string): void {
    const transcriptsDir = this.transcriptReader.getTranscriptsDir(vaultRoot);
    const filePath = join(transcriptsDir, `${sessionId}.jsonl`);

    // Initialize offset to current file size (only new content)
    this.initializeOffset(vaultRoot, sessionId);

    // Create watcher
    const watcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: true, // Don't fire for initial file scan
      awaitWriteFinish: {
        stabilityThreshold: WATCHER.STABILITY_THRESHOLD_MS,
        pollInterval: WATCHER.POLL_INTERVAL_MS,
      },
    });

    watcher.on('change', () => {
      // Debounce rapid changes
      const existingTimer = this.debounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        this.debounceTimers.delete(sessionId);
        this.broadcastUpdate(sessionId, vaultRoot).catch((err) => {
          logger.error(
            `[SessionBroadcaster] Failed to broadcast update for session ${sessionId}:`,
            err
          );
        });
      }, WATCHER.DEBOUNCE_MS);

      this.debounceTimers.set(sessionId, timer);
    });

    this.watchers.set(sessionId, watcher);
  }

  /**
   * Initialize the byte offset for a session to the current file size.
   * This ensures we only broadcast new content, not existing history.
   *
   * @param vaultRoot - Vault root path
   * @param sessionId - Session UUID
   */
  private async initializeOffset(vaultRoot: string, sessionId: string): Promise<void> {
    try {
      const { newOffset } = await this.transcriptReader.readFromOffset(vaultRoot, sessionId, 0);
      this.offsets.set(sessionId, newOffset);
    } catch (_err) {
      // File may not exist yet, start at 0
      this.offsets.set(sessionId, 0);
    }
  }

  /**
   * Broadcast a sync_update event to all connected clients for a session.
   *
   * Reads new content from the transcript file since the last offset and
   * sends a sync_update SSE event if new content exists.
   *
   * @param sessionId - Session UUID
   * @param vaultRoot - Vault root path
   */
  private async broadcastUpdate(sessionId: string, vaultRoot: string): Promise<void> {
    const currentOffset = this.offsets.get(sessionId) ?? 0;

    try {
      const { content, newOffset } = await this.transcriptReader.readFromOffset(
        vaultRoot,
        sessionId,
        currentOffset
      );

      // Update offset
      this.offsets.set(sessionId, newOffset);

      // Only broadcast if there's new content
      if (content.length === 0) {
        return;
      }

      // Send to all connected clients
      const clientSet = this.clients.get(sessionId);
      if (!clientSet || clientSet.size === 0) {
        return;
      }

      const event = {
        sessionId,
        timestamp: new Date().toISOString(),
      };

      const eventData = `event: sync_update\ndata: ${JSON.stringify(event)}\n\n`;

      for (const client of Array.from(clientSet)) {
        try {
          client.write(eventData);
        } catch (err) {
          // Client may have disconnected, will be cleaned up on 'close' event
          logger.error(
            `[SessionBroadcaster] Failed to write to client for session ${sessionId}:`,
            err
          );
        }
      }
    } catch (err) {
      logger.error(`[SessionBroadcaster] Failed to read offset for session ${sessionId}:`, err);
    }
  }

  /**
   * Shutdown the broadcaster, closing all watchers and client connections.
   * Should be called on server shutdown.
   */
  shutdown(): void {
    // Clear all timers
    Array.from(this.debounceTimers.values()).forEach((timer) => {
      clearTimeout(timer);
    });
    this.debounceTimers.clear();

    // Close all watchers
    Array.from(this.watchers.values()).forEach((watcher) => {
      watcher.close();
    });
    this.watchers.clear();

    // End all client responses
    Array.from(this.clients.values()).forEach((clientSet) => {
      Array.from(clientSet).forEach((client) => {
        try {
          client.end();
        } catch {
          // Ignore errors on close
        }
      });
    });
    this.clients.clear();

    // Clear offsets
    this.offsets.clear();
  }
}

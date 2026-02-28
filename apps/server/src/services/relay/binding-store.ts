/**
 * JSON file-backed store for adapter-agent bindings.
 *
 * Persists to `~/.dork/relay/bindings.json` and watches for external
 * changes via chokidar for hot-reload. Provides CRUD operations and
 * most-specific-first resolution for routing inbound adapter messages
 * to the correct agent.
 *
 * @module services/relay/binding-store
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join as pathJoin } from 'node:path';
import { randomUUID } from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  AdapterBindingSchema,
  CreateBindingRequestSchema,
  type AdapterBinding,
  type CreateBindingRequest,
} from '@dorkos/shared/relay-schemas';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';

const BindingsFileSchema = z.object({
  bindings: z.array(AdapterBindingSchema),
});

/** Chokidar stability threshold before triggering hot-reload (ms). */
const STABILITY_THRESHOLD_MS = 150;
/** Chokidar poll interval for write-finish detection (ms). */
const POLL_INTERVAL_MS = 50;

/**
 * JSON file-backed store for adapter-agent bindings.
 *
 * Persists to `{relayDir}/bindings.json` and watches for external
 * changes via chokidar for hot-reload.
 */
export class BindingStore {
  private bindings: Map<string, AdapterBinding> = new Map();
  private readonly filePath: string;
  private watcher?: FSWatcher;
  /** Guard to skip reload when we just wrote the file ourselves. */
  private skipNextReload = false;

  constructor(relayDir: string) {
    this.filePath = pathJoin(relayDir, 'bindings.json');
  }

  /** Load bindings from disk and start the file watcher. */
  async init(): Promise<void> {
    await this.load();
    this.watch();
  }

  /** Return all bindings as an array. */
  getAll(): AdapterBinding[] {
    return Array.from(this.bindings.values());
  }

  /** Find a binding by its UUID. */
  getById(id: string): AdapterBinding | undefined {
    return this.bindings.get(id);
  }

  /** Find all bindings for a given adapter ID. */
  getByAdapterId(adapterId: string): AdapterBinding[] {
    return this.getAll().filter((b) => b.adapterId === adapterId);
  }

  /**
   * Find bindings whose adapterId doesn't match any known adapter.
   *
   * @param knownAdapterIds - Set of currently valid adapter IDs
   */
  getOrphaned(knownAdapterIds: string[]): AdapterBinding[] {
    const known = new Set(knownAdapterIds);
    return this.getAll().filter((b) => !known.has(b.adapterId));
  }

  /**
   * Create a new binding with generated id and timestamps.
   *
   * @param input - Binding configuration (without id/timestamps)
   * @returns The created binding with generated id and timestamps
   */
  async create(input: CreateBindingRequest): Promise<AdapterBinding> {
    // Parse through schema to apply defaults (sessionStrategy, label)
    const parsed = CreateBindingRequestSchema.parse(input);
    const now = new Date().toISOString();
    const binding: AdapterBinding = {
      ...parsed,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.bindings.set(binding.id, binding);
    await this.save();
    return binding;
  }

  /**
   * Delete a binding by ID.
   *
   * @param id - The binding UUID to delete
   * @returns true if found and deleted, false if not found
   */
  async delete(id: string): Promise<boolean> {
    const existed = this.bindings.delete(id);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  /**
   * Resolve the best matching binding for an inbound message.
   *
   * Uses most-specific-first scoring:
   * 1. adapterId + chatId + channelType (score 7)
   * 2. adapterId + chatId (score 5)
   * 3. adapterId + channelType (score 3)
   * 4. adapterId only / wildcard (score 1)
   * 5. no match -> undefined (dead-letter)
   *
   * @param adapterId - The adapter that received the message
   * @param chatId - Optional chat identifier from the message subject
   * @param channelType - Optional channel type from envelope metadata
   */
  resolve(
    adapterId: string,
    chatId?: string,
    channelType?: string,
  ): AdapterBinding | undefined {
    const candidates = this.getByAdapterId(adapterId);
    if (candidates.length === 0) return undefined;

    return candidates
      .map((binding) => ({ binding, score: this.scoreMatch(binding, chatId, channelType) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)[0]?.binding;
  }

  private scoreMatch(
    binding: AdapterBinding,
    chatId?: string,
    channelType?: string,
  ): number {
    let score = 1; // base: adapterId already matches (filtered by caller)
    if (binding.chatId) {
      if (binding.chatId === chatId) score += 4;
      else return 0; // explicit chatId mismatch
    }
    if (binding.channelType) {
      if (binding.channelType === channelType) score += 2;
      else return 0; // explicit channelType mismatch
    }
    return score;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = BindingsFileSchema.parse(JSON.parse(raw));
      this.bindings.clear();
      for (const b of parsed.bindings) {
        this.bindings.set(b.id, b);
      }
      logger.info(`Loaded ${this.bindings.size} binding(s) from ${this.filePath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.info('No bindings.json found, starting with empty bindings');
        this.bindings.clear();
      } else {
        logger.error('Failed to load bindings.json, starting with empty bindings', err);
        this.bindings.clear();
      }
    }
  }

  private async save(): Promise<void> {
    this.skipNextReload = true;
    const data = { bindings: this.getAll() };
    await mkdir(dirname(this.filePath), { recursive: true });
    // Atomic write: temp file + rename
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, this.filePath);
  }

  private watch(): void {
    this.watcher = chokidar.watch(this.filePath, {
      awaitWriteFinish: {
        stabilityThreshold: STABILITY_THRESHOLD_MS,
        pollInterval: POLL_INTERVAL_MS,
      },
    });
    this.watcher.on('change', async () => {
      if (this.skipNextReload) {
        this.skipNextReload = false;
        return;
      }
      logger.info('bindings.json changed on disk, reloading');
      await this.load();
    });
  }

  /** Close the file watcher and clear in-memory state. */
  async shutdown(): Promise<void> {
    await this.watcher?.close();
    this.bindings.clear();
  }
}

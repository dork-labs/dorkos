/**
 * JSON file-backed store for adapter-agent bindings.
 *
 * Persists to `~/.dork/relay/bindings.json` and watches for external
 * changes via chokidar for hot-reload. Provides CRUD operations and
 * most-specific-first resolution for routing inbound adapter messages
 * to the correct agent.
 *
 * **One chat, one agent** (connection-scoping spec `specs/connection-scoping/`
 * §Part 2): `create`/`update` enforce uniqueness on `(adapterId, chatId)` for
 * every non-empty `chatId` — the audited bug was two bindings tied at the same
 * scoring tier silently shadowing each other by creation order
 * (`Array.sort`'s stability + `Map` insertion order). Re-pointing an existing
 * binding to a different agent is the one narrow exception to "bindings are
 * re-created, not re-pointed" — see {@link BindingStore.moveToAgent}.
 *
 * @module services/relay/binding-store
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join as pathJoin, dirname } from 'node:path';
import { withFileLock } from '@dorkos/shared/atomic-write';
import { randomUUID } from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  AdapterBindingSchema,
  CreateBindingRequestSchema,
  BRIDGE_REQUIRES_CHAT_ID_MESSAGE,
  type AdapterBinding,
  type UpdateBindingRequest,
} from '@dorkos/shared/relay-schemas';
import { z } from 'zod';
import { logError, logger } from '../../lib/logger.js';
import { carryForwardBindingDefaults } from './safe-defaults.js';

/** Loose file schema — validates structure but not individual entries. */
const BindingsFileShellSchema = z.object({
  bindings: z.array(z.unknown()),
});

/**
 * Thrown by {@link BindingStore.create}/{@link BindingStore.update} when the
 * requested `(adapterId, chatId)` already belongs to another binding — "one
 * chat, one agent" (connection-scoping spec §Part 2). Carries the conflicting
 * binding so a caller can offer a move rather than a bare rejection.
 */
export class BindingConflictError extends Error {
  /** The existing binding that already owns this `(adapterId, chatId)`. */
  readonly conflict: AdapterBinding;

  constructor(conflict: AdapterBinding) {
    super(
      `Chat '${conflict.chatId}' on adapter '${conflict.adapterId}' is already bound to agent ` +
        `'${conflict.agentId}' (binding ${conflict.id}).`
    );
    this.name = 'BindingConflictError';
    this.conflict = conflict;
  }
}

/** Chokidar stability threshold before triggering hot-reload (ms). */
const STABILITY_THRESHOLD_MS = 150;
/** Chokidar poll interval for write-finish detection (ms). */
const POLL_INTERVAL_MS = 50;

/**
 * Mutable binding fields as the store receives them — {@link UpdateBindingRequest}
 * after the route's null-to-undefined conversion. A key explicitly present with
 * `undefined` clears the field via the update spread; an absent key is a no-op.
 *
 * **`roomId` is the one field the conversion does NOT touch.** Every other
 * nullable/optional field (`chatId`, `channelType`) uses `null` on the wire to
 * mean "clear it," which the route turns into `undefined` before it reaches
 * here. `roomId` is different: `AdapterBindingSchema` declares it
 * `.nullable()`, not `.optional()` — `null` IS its valid "not bridged" value,
 * the schema's own default, not a clear-to-undefined signal. Converting it
 * would let it drift to `undefined` in memory (a value the schema's inferred
 * type does not admit) for the rest of this process's life; a restart's
 * `AdapterBindingSchema` default only repairs it after the fact, once JSON
 * has already silently dropped the key on save.
 */
export type BindingUpdate = {
  [K in keyof UpdateBindingRequest]?: K extends 'roomId'
    ? UpdateBindingRequest[K]
    : Exclude<UpdateBindingRequest[K], null>;
};

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
  /**
   * Mtime (in ms) of the file after our most recent self-write.
   *
   * After each `save()` we `stat()` the file and store `mtimeMs`.
   * When chokidar fires a change event we `stat()` again: if `mtimeMs`
   * matches `lastWriteMtime` the event is our own write and we skip
   * the reload; otherwise the change is external and we hot-reload.
   */
  private lastWriteMtime: number | null = null;

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
   * **One chat, one agent** (connection-scoping spec §Part 2): throws
   * {@link BindingConflictError} when `chatId` is non-empty and another
   * binding on the same `adapterId` already claims it — regardless of that
   * binding's `enabled` state, since a paused binding still owns its chat.
   * Wildcard bindings (`chatId` absent) are exempt — see
   * `specs/connection-scoping/design-decisions.md` D3.
   *
   * @param input - Binding configuration (without id/timestamps)
   * @returns The created binding with generated id and timestamps
   * @throws {@link BindingConflictError} on a `(adapterId, chatId)` collision.
   */
  async create(input: z.input<typeof CreateBindingRequestSchema>): Promise<AdapterBinding> {
    // Parse through schema to apply defaults (sessionStrategy, label)
    const parsed = CreateBindingRequestSchema.parse(input);
    this.assertChatAvailable(parsed.adapterId, parsed.chatId);
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
   * Throw {@link BindingConflictError} if `chatId` (when non-empty) is
   * already claimed by a DIFFERENT binding on `adapterId`. Shared by
   * {@link create} and {@link update}.
   *
   * @param adapterId - The adapter the new/updated binding is on.
   * @param chatId - The chat id being claimed, or `undefined` for a wildcard.
   * @param excludeId - A binding id to ignore (the one being updated).
   */
  private assertChatAvailable(
    adapterId: string,
    chatId: string | undefined,
    excludeId?: string
  ): void {
    if (!chatId) return;
    const existing = this.getByAdapterId(adapterId).find(
      (b) => b.chatId === chatId && b.id !== excludeId
    );
    if (existing) throw new BindingConflictError(existing);
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
   * Update an existing binding's mutable fields.
   *
   * **Validates the MERGED result against `AdapterBindingSchema` before it is
   * ever set in memory or saved.** The HTTP route already checks
   * `bridge`/`chatId` against the merged state before calling this, but that
   * check is the route's problem, not this method's guarantee — any other
   * in-process caller (a future task's `ingest`/`deliver`, a script, a test)
   * can reach `update` directly. Without this, an invalid merge — `bridge:
   * 'room'` landing on a binding with no `chatId` — would sit fine in memory,
   * get written to `bindings.json`, and then be silently DISCARDED by `load()`
   * on the next restart (`AdapterBindingSchema.safeParse` fails, the entry is
   * dropped): the binding would look created, work until restart, then vanish.
   * Rejecting here means the invalid state can never reach disk from any
   * boundary.
   *
   * Also re-checks "one chat, one agent" (§Part 2) when `updates.chatId`
   * changes to a new non-empty value — `adapterId` itself is never mutable
   * here, so a `chatId` change is the only way an update could newly collide.
   *
   * @param id - The binding UUID to update
   * @param updates - Fields to update; every {@link UpdateBindingRequest} field is accepted
   * @returns The updated binding, or undefined if not found
   * @throws When the merged result fails `AdapterBindingSchema` — in practice
   *   {@link BRIDGE_REQUIRES_CHAT_ID_MESSAGE}, the only refinement the schema carries.
   * @throws {@link BindingConflictError} on a `(adapterId, chatId)` collision.
   */
  async update(id: string, updates: BindingUpdate): Promise<AdapterBinding | undefined> {
    const existing = this.bindings.get(id);
    if (!existing) return undefined;
    if (updates.chatId !== undefined && updates.chatId !== existing.chatId) {
      this.assertChatAvailable(existing.adapterId, updates.chatId, id);
    }
    const merged: AdapterBinding = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    const result = AdapterBindingSchema.safeParse(merged);
    if (!result.success) {
      const bridgeIssue = result.error.issues.find(
        (issue) => issue.message === BRIDGE_REQUIRES_CHAT_ID_MESSAGE
      );
      throw new Error(
        bridgeIssue
          ? BRIDGE_REQUIRES_CHAT_ID_MESSAGE
          : `Invalid binding update: ${result.error.issues.map((issue) => issue.message).join('; ')}`
      );
    }
    this.bindings.set(id, result.data);
    await this.save();
    return result.data;
  }

  /**
   * Re-point an EXISTING binding's `agentId` in place (connection-scoping
   * spec §Part 2 Move semantics) — the one narrow exception to
   * {@link update}'s "bindings are re-created, not re-pointed" rule.
   * `id`/`chatId`/`adapterId` are unchanged; only `agentId` and `updatedAt`
   * move. This is what makes "This chat reaches X. Move it to Y?" possible
   * without losing the binding's identity (and therefore its session-map
   * entries' key) the way a delete-and-recreate would.
   *
   * Callers are responsible for clearing any session-map entries the OLD
   * agent's project directory produced — see
   * `BindingRouter.clearSessionsForBinding` — since a binding row alone
   * cannot know about the router's separate session map.
   *
   * @param id - The binding UUID to re-point.
   * @param agentId - The new owning agent.
   * @returns The updated binding, or undefined if `id` is not found.
   */
  async moveToAgent(id: string, agentId: string): Promise<AdapterBinding | undefined> {
    const existing = this.bindings.get(id);
    if (!existing) return undefined;
    const moved: AdapterBinding = { ...existing, agentId, updatedAt: new Date().toISOString() };
    this.bindings.set(id, moved);
    await this.save();
    return moved;
  }

  /**
   * Resolve the best matching ENABLED binding for an inbound message.
   *
   * Uses most-specific-first scoring:
   * 1. adapterId + chatId + channelType (score 7)
   * 2. adapterId + chatId (score 5)
   * 3. adapterId + channelType (score 3)
   * 4. adapterId only / wildcard (score 1)
   * 5. no match -> undefined (dead-letter)
   *
   * **Disabled candidates are excluded from scoring** (connection-scoping
   * spec §Part 2 — the audited fact that `resolve()` used to let a
   * higher-scoring DISABLED binding win over a lower-scoring enabled
   * fallback, e.g. a paused specific binding permanently blocking an enabled
   * wildcard). When the caller needs to know whether a MISS is a true
   * `no_binding` or "the only candidate is paused," see
   * {@link resolveIncludingDisabled}.
   *
   * @param adapterId - The adapter that received the message
   * @param chatId - Optional chat identifier from the message subject
   * @param channelType - Optional channel type from envelope metadata
   */
  resolve(adapterId: string, chatId?: string, channelType?: string): AdapterBinding | undefined {
    return this._resolve(adapterId, chatId, channelType, { includeDisabled: false });
  }

  /**
   * Identical scoring to {@link resolve}, but disabled candidates are
   * eligible too. Used ONLY by the router's fallback path — a hit here after
   * a `resolve()` miss means "nothing matched because it's paused," which is
   * what turns a silent `no_binding` drop into the told `binding_paused`
   * refusal (DOR-789's "every refusal is told" invariant, preserved
   * alongside the `resolve()` fix — see
   * `specs/connection-scoping/design-decisions.md` D5). Not a general-purpose
   * alternative to `resolve()` — nothing else should call this.
   *
   * @param adapterId - The adapter that received the message
   * @param chatId - Optional chat identifier from the message subject
   * @param channelType - Optional channel type from envelope metadata
   */
  resolveIncludingDisabled(
    adapterId: string,
    chatId?: string,
    channelType?: string
  ): AdapterBinding | undefined {
    return this._resolve(adapterId, chatId, channelType, { includeDisabled: true });
  }

  private _resolve(
    adapterId: string,
    chatId: string | undefined,
    channelType: string | undefined,
    opts: { includeDisabled: boolean }
  ): AdapterBinding | undefined {
    const candidates = this.getByAdapterId(adapterId).filter(
      (b) => opts.includeDisabled || b.enabled !== false
    );
    if (candidates.length === 0) return undefined;

    return candidates
      .map((binding) => ({ binding, score: this.scoreMatch(binding, chatId, channelType) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)[0]?.binding;
  }

  private scoreMatch(binding: AdapterBinding, chatId?: string, channelType?: string): number {
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

  /**
   * Reconcile every `(adapterId, non-empty chatId)` collision found on load
   * — a `bindings.json` written before the uniqueness invariant existed may
   * legitimately hold two bindings differentiated only by `channelType`
   * (tiered chatId+channelType vs chatId-alone), which `resolve()`'s scoring
   * used to treat as two live, competing candidates. **This method never
   * deletes a binding.** An earlier version did (keep-oldest, discard the
   * rest), which destroyed configuration data a person may have set up on
   * purpose and was irreversible on top of that — see
   * `specs/connection-scoping/design-decisions.md` D3-addendum for why that
   * was wrong and what replaced it: the OLDEST binding for a chat keeps
   * `enabled` untouched; every other colliding binding is disabled in place
   * (never removed) — routing-wise this is equivalent to "one enabled
   * binding per chat," which is what §Part 2 actually requires, while the
   * losing row, its `agentId`, its `label`, everything, stays on disk and
   * recoverable (a `move`/re-enable is a config edit, not a data-recovery
   * exercise).
   *
   * Every disabled row is ALSO written verbatim to a
   * `bindings.discarded-<ISO-timestamp>.json` sidecar next to `bindings.json`
   * before the cleaned file is saved — belt-and-suspenders recoverability
   * even though nothing was actually removed from the live file.
   *
   * Mutates `this.bindings` directly (called only from `load()`, before any
   * save). Returns the count of newly-disabled rows, folded into `load()`'s
   * existing discard counter/re-save trigger.
   */
  private async dedupeChatCollisions(): Promise<number> {
    // adapterId -> chatId -> the oldest binding seen so far for that pair.
    const winners = new Map<string, Map<string, AdapterBinding>>();
    const losers: AdapterBinding[] = [];
    for (const binding of this.getAll()) {
      if (!binding.chatId) continue;
      let byChat = winners.get(binding.adapterId);
      if (!byChat) {
        byChat = new Map();
        winners.set(binding.adapterId, byChat);
      }
      const incumbent = byChat.get(binding.chatId);
      if (!incumbent) {
        byChat.set(binding.chatId, binding);
        continue;
      }
      const older = incumbent.createdAt <= binding.createdAt ? incumbent : binding;
      const newer = older === incumbent ? binding : incumbent;
      byChat.set(binding.chatId, older);
      losers.push(newer);
    }

    // `losers` above is computed from `getAll()`, which does not care whether
    // a colliding row is already disabled — so on every load AFTER the first
    // reconciliation, the SAME already-disabled loser reappears in `losers`
    // again (it still collides on chatId; it just no longer routes). Without
    // this filter, every server start would re-write a fresh
    // `bindings.discarded-<timestamp>.json`, re-run `save()`, and re-log
    // "auto-disabled" for a collision that was already handled — forever.
    // Only a row that is NOT YET disabled is newly-actionable this load.
    const newlyDisabled = losers.filter((l) => this.bindings.get(l.id)?.enabled !== false);
    if (newlyDisabled.length === 0) return 0;

    await this.writeDiscardedSidecar(newlyDisabled);

    for (const loser of newlyDisabled) {
      const current = this.bindings.get(loser.id);
      if (!current) continue; // defensive — every loser id came from this.bindings itself
      this.bindings.set(loser.id, { ...current, enabled: false });
      logger.warn(
        'Auto-disabled a colliding binding for an already-bound chat during load (backed up, not deleted)',
        {
          id: loser.id,
          adapterId: loser.adapterId,
          chatId: loser.chatId,
          channelType: loser.channelType,
          agentId: loser.agentId,
          label: loser.label,
        }
      );
    }
    return newlyDisabled.length;
  }

  /**
   * Write the full, unmodified rows of every auto-disabled binding to a
   * timestamped sidecar file next to `bindings.json` — the recoverability
   * half of {@link dedupeChatCollisions}. Best-effort: a write failure here
   * is logged and swallowed rather than blocking `load()`, since the rows
   * themselves are already safe (disabled in place, not deleted).
   *
   * @param losers - The full binding rows being auto-disabled this load.
   */
  private async writeDiscardedSidecar(losers: AdapterBinding[]): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sidecarPath = pathJoin(dirname(this.filePath), `bindings.discarded-${stamp}.json`);
    try {
      await writeFile(sidecarPath, JSON.stringify({ bindings: losers }, null, 2), 'utf-8');
      logger.info(
        `Backed up ${losers.length} auto-disabled binding(s) to ${sidecarPath} before re-saving bindings.json`
      );
    } catch (err) {
      logger.error(
        `Failed to write the discarded-bindings sidecar at ${sidecarPath} — the rows are still safe ` +
          '(disabled in place in bindings.json, not deleted), only this extra backup copy is missing',
        logError(err)
      );
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      // Stamp legacy entries before any schema default can fire — once
      // `AdapterBindingSchema` applies its own default the old value is gone.
      const json = carryForwardBindingDefaults(JSON.parse(raw) as unknown);
      const shell = BindingsFileShellSchema.safeParse(json);
      if (!shell.success) {
        logger.error('bindings.json has invalid structure, starting with empty bindings');
        this.bindings.clear();
        return;
      }

      this.bindings.clear();
      let invalidDiscarded = 0;
      for (const entry of shell.data.bindings) {
        const result = AdapterBindingSchema.safeParse(entry);
        if (result.success) {
          this.bindings.set(result.data.id, result.data);
        } else {
          invalidDiscarded++;
          logger.warn('Discarding invalid binding entry during load', {
            entry,
            errors: result.error.issues,
          });
        }
      }

      // "One chat, one agent" reconciliation pass (connection-scoping spec
      // §Part 2): a `bindings.json` written before this invariant existed may
      // already hold two bindings on the same `(adapterId, chatId)` —
      // exactly the audited tie `resolve()` used to silently shadow. Every
      // colliding row is disabled in place (never deleted) and backed up to
      // a sidecar file — see {@link dedupeChatCollisions}.
      const autoDisabled = await this.dedupeChatCollisions();

      if (invalidDiscarded > 0 || autoDisabled > 0) {
        logger.info(
          `Loaded ${this.bindings.size} binding(s): discarded ${invalidDiscarded} invalid, ` +
            `auto-disabled ${autoDisabled} chat-collision — auto-saving reconciled file`
        );
        await this.save();
      } else {
        logger.info(`Loaded ${this.bindings.size} binding(s) from ${this.filePath}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('[BindingSubsystem] no bindings.json yet, starting with none');
        this.bindings.clear();
      } else {
        logger.error(
          '[BindingSubsystem] could not load bindings.json, starting with none',
          logError(err)
        );
        this.bindings.clear();
      }
    }
  }

  private async save(): Promise<void> {
    const data = { bindings: this.getAll() };
    // The stat stays inside the lock: if a second save landed between our
    // rename and our stat, we would record its mtime as our own and then treat
    // that external change as self-inflicted.
    await withFileLock(this.filePath, async (write) => {
      await write(JSON.stringify(data, null, 2));
      // Record the mtime of our own write so the chokidar handler can
      // distinguish it from an external change.
      const fileStat = await stat(this.filePath);
      this.lastWriteMtime = fileStat.mtimeMs;
    });
  }

  private watch(): void {
    this.watcher = chokidar.watch(this.filePath, {
      awaitWriteFinish: {
        stabilityThreshold: STABILITY_THRESHOLD_MS,
        pollInterval: POLL_INTERVAL_MS,
      },
    });
    this.watcher.on('change', async () => {
      const fileStat = await stat(this.filePath);
      if (this.lastWriteMtime !== null && fileStat.mtimeMs === this.lastWriteMtime) {
        // This change event matches our own write's mtime — skip reload.
        this.lastWriteMtime = null;
        return;
      }
      logger.info('bindings.json changed on disk, reloading');
      await this.load();
    });

    // Without this handler a watcher failure (e.g. EMFILE) has nowhere to go
    // but the process-wide unhandled-error path. Bindings already in memory
    // keep routing inbound messages; only hot-reload of external edits stops
    // working until the process restarts. Latched per distinct error code
    // rather than a single boolean: a benign EACCES must never suppress the
    // EMFILE storm that follows it. The Set lives in this per-instance closure,
    // so one store's latch cannot silence another's.
    const seenCodes = new Set<string>();
    this.watcher.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      // Logged as an explicit object, never the bare Error: the NDJSON reporter
      // spreads what it is given, and `message`/`stack` are non-enumerable on
      // an Error, so they would vanish (DOR-832).
      logger.error(
        `[watcher-error] BindingStore: ${this.filePath} — further ${code} errors from this watcher are suppressed`,
        {
          filePath: this.filePath,
          code,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          suppressingFurtherErrors: true,
        }
      );
    });
  }

  /** Close the file watcher and clear in-memory state. */
  async shutdown(): Promise<void> {
    await this.watcher?.close();
    this.bindings.clear();
  }
}

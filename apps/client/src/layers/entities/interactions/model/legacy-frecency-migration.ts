/**
 * Retiring `dorkos:agent-frecency-v2` into the one interaction store.
 *
 * ⌘K used to keep its own memory of which AGENTS you open, in a localStorage
 * key of its own, scored with Slack's bucket algorithm. It could rank agents by
 * use and nothing else — no conversation, no channel — which is the whole
 * reason this store exists. This module is the last step of that consolidation:
 * it reads the retired key once, folds what it held into
 * {@link useInteractionStore}, and deletes it from the browser rather than
 * leaving it to sit there forever (spec `sidebar-now-today-library` P3 AC-4).
 *
 * **Why it needs the agent roster, and so cannot be a plain read on hydration.**
 * The two stores key agents differently: the retired one recorded the mesh
 * agent id, this one records the DIRECTORY a person opened
 * (`agent:<projectPath>`), because that is what every other surface in the
 * cockpit records. Translating one to the other needs the roster, which is a
 * query answer rather than a fact on disk — so the migration is a hook that
 * waits for the roster, in the same shape as the sidebar's
 * `useLegacyPinMigration`.
 *
 * **One-way, and safe to run twice.** Everything it writes goes through
 * `mergeUsage`, which takes the larger of each field, so two tabs racing on the
 * same payload converge instead of double-counting. There is no path back: the
 * key is gone once the roster has answered, and this module is a delete away
 * from being unnecessary once no browser plausibly still holds one.
 *
 * @module entities/interactions/model/legacy-frecency-migration
 */
import { useEffect, useRef } from 'react';
import { interactionKey, useInteractionStore, type InteractionUsage } from './interaction-store';

/**
 * The retired key, and the older one before it.
 *
 * Both are swept. `dorkos:agent-frecency-v2` is the one with data worth
 * keeping; `dorkos-agent-frecency` is its predecessor, which shipped a
 * different record shape and was already being ignored on read — so a browser
 * old enough to hold one has been carrying dead bytes through every release
 * since. Sweeping it costs one line and is the difference between retiring a
 * key and abandoning it.
 */
const LEGACY_KEYS = ['dorkos:agent-frecency-v2', 'dorkos-agent-frecency'] as const;

/** The key whose records are translated rather than only deleted. */
const LEGACY_FRECENCY_KEY = LEGACY_KEYS[0];

/**
 * One record as the retired key stored it.
 *
 * Deliberately re-declared here rather than imported: the module that defined
 * it is gone, and this is the only code left that needs to know the shape.
 */
interface LegacyFrecencyRecord {
  /** The MESH agent id — not the directory this store keys agents by. */
  agentId: string;
  /** Epoch-ms timestamps, most recent first. The retired store kept at most ten. */
  timestamps: number[];
  /** How many times the agent was opened, ever — uncapped, unlike `timestamps`. */
  totalCount: number;
}

/** Whether a parsed value is a record this migration can translate. */
function isLegacyRecord(value: unknown): value is LegacyFrecencyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<LegacyFrecencyRecord>;
  return (
    typeof record.agentId === 'string' &&
    Array.isArray(record.timestamps) &&
    record.timestamps.every((stamp) => typeof stamp === 'number' && Number.isFinite(stamp)) &&
    typeof record.totalCount === 'number' &&
    Number.isFinite(record.totalCount)
  );
}

/**
 * What the retired key holds, or an empty list when it holds nothing usable.
 *
 * Storage can throw outright (Safari private mode, a host that disables it) and
 * the payload is whatever an older release wrote, so every failure reads as
 * "no history": losing a ranking hint is not a reason to fail a render.
 */
function readLegacyRecords(): LegacyFrecencyRecord[] {
  try {
    const raw = localStorage.getItem(LEGACY_FRECENCY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLegacyRecord);
  } catch {
    return [];
  }
}

/** Remove every retired key. Best effort — a key we cannot reach reads as absent too. */
function removeLegacyKeys(): void {
  try {
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // Same rationale as the read: tidying up never fails a render.
  }
}

/** Just enough of an agent to translate a retired record onto its directory. */
export interface MigratableAgent {
  /** The mesh id, which is what the retired key recorded. */
  id: string;
  /** The directory, which is what this store records. */
  projectPath: string;
}

/**
 * Translate retired records into this store's key space.
 *
 * Pure, so the translation itself is assertable without a React tree or a
 * browser. A record whose agent the roster does not know is dropped: its mesh
 * id names an agent this cockpit cannot show, so there is no row for the
 * history to rank and no key to file it under.
 *
 * `lastUsedAt` is the newest stamp the record held, and `useCount` its
 * `totalCount` — which counts past the ten timestamps the retired store kept,
 * and is exactly the frequency half the new ranker asks for.
 *
 * @param records - What the retired key held.
 * @param agents - Every agent the cockpit can see.
 */
export function translateLegacyRecords(
  records: readonly LegacyFrecencyRecord[],
  agents: readonly MigratableAgent[]
): InteractionUsage[] {
  const pathById = new Map(agents.map((agent) => [agent.id, agent.projectPath]));
  const usage: InteractionUsage[] = [];
  for (const record of records) {
    const projectPath = pathById.get(record.agentId);
    if (projectPath === undefined) continue;
    const lastUsedAt = Math.max(...record.timestamps, Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(lastUsedAt)) continue;
    usage.push({
      key: interactionKey('agent', projectPath),
      lastUsedAt,
      useCount: Math.max(0, Math.trunc(record.totalCount)),
    });
  }
  return usage;
}

/**
 * Fold the retired agent-frecency key into this store, once, then forget it.
 *
 * **It waits for the roster and then commits.** With no agents on screen there
 * is nothing to translate a mesh id onto, and an empty roster is
 * indistinguishable from one that has not answered — so the migration holds
 * rather than deleting a history it could not read. A cockpit that genuinely
 * has no agents has no agent frecency worth keeping either, and the key is
 * swept the first time a roster appears.
 *
 * @param agents - Every agent the cockpit can see, from the mesh roster.
 */
export function useLegacyFrecencyMigration(agents: readonly MigratableAgent[]): void {
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    if (agents.length === 0) return;
    done.current = true;
    useInteractionStore.getState().mergeUsage(translateLegacyRecords(readLegacyRecords(), agents));
    removeLegacyKeys();
  }, [agents]);
}

/**
 * What survives a config wipe: the settings a person turned to the protective
 * side, carried across corrupt-recovery and a full reset so losing state never
 * loses a protection.
 *
 * ## The defect this exists for
 *
 * `~/.dork/config.json` gets replaced with defaults on two paths. The
 * `ConfigManager` constructor's recovery branch backs up a file `conf`'s Ajv
 * refused and starts a fresh one, and `ConfigManager.reset()` with no key clears
 * the store and re-seeds `USER_CONFIG_DEFAULTS`. Both were total: every stored
 * value went, including the ones that exist to protect the person.
 *
 * That is not hypothetical, and it is not rare. A config becomes Ajv-invalid
 * whenever a renaming migration is skipped, and migrations are skipped often —
 * `conf` runs a key only when `key > storedVersion && key <= projectVersion`, so
 * a dev tree (`SERVER_VERSION` resolves to `0.0.0`) runs none of them, and
 * shipping a schema below its migration key skips it for every user. See
 * `tolerateLegacySidebarEncoding` in `config-manager.ts` for the DOR-579
 * instance that made this concrete.
 *
 * The observed damage was a telemetry opt-out reverting to the opt-out-tier
 * defaults: `telemetry.userHasDecided` went `true` -> `false` while `install`
 * and `heartbeat` went `false` -> `true`. The person had answered "no", and the
 * recovery replaced their answer with "never asked, and the answer is yes".
 *
 * ## The rule
 *
 * A wipe may lose preferences. It must never lose a protection, and it must
 * never read absence as consent. So recovery re-applies, onto the fresh
 * defaults, exactly two things:
 *
 * 1. **A decision, whole.** {@link salvageTelemetryDecision} — when the stored
 *    file records that the person answered a consent prompt, their answer comes
 *    back intact, every channel together with the flag that says they answered.
 *    Atomically: carrying `userHasDecided` alone would open the Tier 1 send gate
 *    (`hasTier1SendGate`) onto default-ON channels, which is worse than carrying
 *    nothing.
 * 2. **A value more protective than the default.** {@link PROTECTIVE_CARRYOVERS}
 *    lists every leaf whose default sits on the permissive side, with the
 *    direction that protects. A stored value on the protective side is carried;
 *    a stored value on the permissive side is not, so recovery can only ever
 *    land at or below a fresh install's exposure.
 *
 * A leaf whose default is ALREADY the protective option needs no entry here:
 * the wipe lands on it for free (`tunnel.enabled`, `approvals.standingGrants`,
 * `extensions.approvedToRun`, `auth`-adjacent secrets, and the Tier 2 telemetry
 * channels are all in that group). Only the permissive-default leaves can lose
 * something, so only they are listed.
 *
 * ## Everything carried is re-validated
 *
 * The source is a file that just FAILED validation. Writing any of it back
 * unchecked would re-condemn the fresh store and loop the recovery forever, so
 * every salvaged value is parsed against its own narrow schema and dropped on
 * its own if it does not hold. One unreadable field never costs another field.
 *
 * @module services/core/safe-defaults/protected-state
 */
import { z } from 'zod';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../../lib/logger.js';

/**
 * The later of two posture-floor instants, treating a missing one as "no floor".
 *
 * Both values are `Date.prototype.toISOString()` output — fixed-width UTC — so
 * ordering them as text orders them as instants, the same property the grant
 * store's own comparison relies on. The schema pins the format
 * (`standingGrantsVoidBefore` is `z.string().datetime().nullable()`), so a value
 * that reaches here through any validated path is comparable this way.
 *
 * @param a - One instant, or `null`.
 * @param b - The other instant, or `null`.
 * @returns The later of the two, or `null` when both are absent.
 */
export function latestInstant(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * How a stored value is compared against the fresh default to decide which one
 * protects the person more.
 *
 * - `boolean` — one of the two values is the protective one, named outright.
 * - `lower` — a bound, where a smaller number is a tighter limit.
 * - `later` — a monotonic floor, where a later instant voids more.
 */
export type CarryoverDirection = 'boolean' | 'lower' | 'later';

/** One config leaf whose default is permissive, and the direction that protects. */
export interface ProtectiveCarryover {
  /** Dot-path of the leaf, as `configSchemaLeafPaths()` reports it. */
  path: string;
  /** How to compare the stored value against the fresh one. */
  direction: CarryoverDirection;
  /** For `direction: 'boolean'`, the value that protects the person. */
  protectiveValue?: boolean;
  /** Why losing this on a wipe would cost the person a protection. */
  reason: string;
}

/**
 * Every config leaf whose default sits on the permissive side and which a person
 * can therefore have moved to a protective value worth preserving.
 *
 * Deliberately short. A leaf earns a place here only when a wipe could
 * concretely take something away: data starts leaving the machine again, a gate
 * re-opens, or a bound the person tightened goes slack. Preferences do not
 * qualify — losing a theme is not losing a protection.
 *
 * The telemetry channels are deliberately ABSENT. They defaulted ON when this
 * list was written and each needed a rule; since ADR 260727-181825 they default
 * OFF, so a wipe lands on the protective value by itself and a rule here could
 * never fire. What still needs carrying is the opposite case — someone who chose
 * to keep sharing — and that travels as a whole decision through
 * {@link salvageTelemetryDecision}, not as a per-leaf comparison.
 */
export const PROTECTIVE_CARRYOVERS: readonly ProtectiveCarryover[] = [
  {
    path: 'auth.enabled',
    direction: 'boolean',
    protectiveValue: true,
    reason:
      'Login defaults OFF. Recovering into a logged-out instance silently drops the gate that makes every approval enforceable.',
  },
  {
    path: 'mcp.enabled',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'The external /mcp tool endpoint defaults ON. Someone who closed it should not have it re-opened by a wipe.',
  },
  {
    path: 'approvals.standingGrantsVoidBefore',
    direction: 'later',
    reason:
      'The void floor is the only durable record that standing permissions were revoked (DOR-520). Permissions live in SQLite and outlive the config file, so losing the floor wakes every one of them.',
  },
  {
    path: 'approvals.trustWindowMinutes',
    direction: 'lower',
    reason: 'A shortened trust window is a tightened bound; a wipe must not lengthen it.',
  },
  {
    path: 'rooms.maxAgentDepth',
    direction: 'lower',
    reason: 'How far agents may reply to each other before a room stops them; spends real money.',
  },
  {
    path: 'rooms.maxAutomaticTurnsPerRoomPerHour',
    direction: 'lower',
    reason: 'Per-room automatic-turn spend cap.',
  },
  {
    path: 'rooms.maxAutomaticTurnsTotalPerHour',
    direction: 'lower',
    reason: 'Install-wide automatic-turn spend cap.',
  },
] as const;

/**
 * The Tier 1 telemetry channels, and the value each takes for someone who
 * answered a consent prompt that did not yet mention the channel.
 *
 * A person's answer is only ever as wide as the question they were asked, so a
 * channel absent from the stored file comes back OFF rather than at its
 * schema default — the same reasoning `backfillTelemetryUsageChannel` applies on
 * the upgrade path.
 */
const TELEMETRY_CHANNELS = [
  'install',
  'heartbeat',
  'errorReporting',
  'usage',
  'linkAnalyticsToAccount',
  'aiMetadata',
] as const;

/**
 * The stored telemetry block, read defensively. Every field is optional because
 * the source file failed validation and may be from any prior schema, and every
 * field carries `.catch(undefined)` so an unreadable value is dropped ON ITS OWN
 * rather than taking the whole decision down with it — a single hand-edited
 * channel must not cost the person the rest of their answer. A dropped field
 * then falls to the protective OFF, never to the schema's permissive default.
 */
const StoredTelemetrySchema = z
  .object({
    userHasDecided: z.boolean().optional().catch(undefined),
    install: z.boolean().optional().catch(undefined),
    heartbeat: z.boolean().optional().catch(undefined),
    errorReporting: z.boolean().optional().catch(undefined),
    lastPromptedVersion: z.string().nullable().optional().catch(undefined),
    usage: z.boolean().optional().catch(undefined),
    linkAnalyticsToAccount: z.boolean().optional().catch(undefined),
    aiMetadata: z.boolean().optional().catch(undefined),
  })
  .loose();

/** The subset of a stored config this module knows how to carry across a wipe. */
export interface SalvagedProtections {
  /**
   * The person's whole telemetry answer, present only when the stored file
   * recorded that they gave one. Always complete: never a bare
   * `userHasDecided`.
   */
  telemetry?: UserConfig['telemetry'];
  /**
   * Per-leaf protective values, keyed by the dot-paths in
   * {@link PROTECTIVE_CARRYOVERS}. Only leaves whose stored value beat the
   * default appear.
   */
  leaves: Record<string, boolean | number | string>;
}

/** Read a dot-path out of an untyped stored object. */
function readPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Write a dot-path into a nested patch object, creating containers as needed. */
function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  const leaf = parts.pop();
  if (leaf === undefined) return;
  let cursor = root;
  for (const part of parts) {
    const next = cursor[part];
    if (next === null || typeof next !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[leaf] = value;
}

/**
 * Recover a person's telemetry answer from a stored config, whole or not at all.
 *
 * Returns a complete `telemetry` block only when the stored file says the person
 * answered a consent prompt (`userHasDecided === true`). Their channel values
 * come back exactly as they set them; a channel the file does not mention comes
 * back OFF, because their answer never covered it. `lastPromptedVersion` rides
 * along so the notice does not re-appear for someone who already decided.
 *
 * Returns `undefined` for a never-answered install. That is the safe direction:
 * without a decision to preserve, the fresh defaults apply and the
 * notice-before-first-send gate holds every Tier 1 channel until the first-run
 * notice is shown again.
 *
 * @param stored - The parsed contents of the config file being replaced.
 * @returns The person's answer, or `undefined` when they never gave one.
 */
export function salvageTelemetryDecision(stored: unknown): UserConfig['telemetry'] | undefined {
  const parsed = StoredTelemetrySchema.safeParse(readPath(stored, 'telemetry'));
  if (!parsed.success) return undefined;
  const telemetry = parsed.data;
  if (telemetry.userHasDecided !== true) return undefined;

  const channels = Object.fromEntries(
    TELEMETRY_CHANNELS.map((channel) => [channel, telemetry[channel] ?? false])
  ) as Record<(typeof TELEMETRY_CHANNELS)[number], boolean>;

  return {
    ...channels,
    userHasDecided: true,
    lastPromptedVersion: telemetry.lastPromptedVersion ?? null,
  };
}

/**
 * Decide, for one carryover leaf, whether the stored value protects the person
 * more than the value a fresh config would have.
 *
 * @param entry - The leaf's carryover rule.
 * @param stored - The value found in the file being replaced.
 * @param fresh - The value a fresh config carries at that path.
 * @returns The value to write, or `undefined` to leave the fresh one alone.
 */
function moreProtective(
  entry: ProtectiveCarryover,
  stored: unknown,
  fresh: unknown
): boolean | number | string | undefined {
  switch (entry.direction) {
    case 'boolean': {
      if (typeof stored !== 'boolean') return undefined;
      return stored === entry.protectiveValue && stored !== fresh ? stored : undefined;
    }
    case 'lower': {
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return undefined;
      if (typeof fresh !== 'number') return undefined;
      return stored < fresh ? stored : undefined;
    }
    case 'later': {
      if (typeof stored !== 'string') return undefined;
      // Only a real timestamp is comparable as text; anything else is dropped
      // rather than allowed to sort above every genuine floor.
      if (Number.isNaN(Date.parse(stored))) return undefined;
      const freshFloor = typeof fresh === 'string' ? fresh : null;
      const winner = latestInstant(freshFloor, stored);
      return winner !== null && winner !== fresh ? winner : undefined;
    }
  }
}

/**
 * Collect everything worth carrying from a config that is about to be replaced.
 *
 * Pure: reads the two inputs and returns a description of what to re-apply.
 * Never throws — a wholly unreadable input yields an empty result, because the
 * caller is already on a failure path and a throw here would take down the
 * boot it is trying to rescue.
 *
 * @param stored - The parsed contents of the file being replaced. Pass
 *   `undefined` when the file could not be parsed at all.
 * @param fresh - The config as it stands after the wipe, i.e. the defaults.
 * @returns The protections to re-apply on top of `fresh`.
 */
export function salvageProtectedState(stored: unknown, fresh: unknown): SalvagedProtections {
  const salvaged: SalvagedProtections = { leaves: {} };
  if (stored === null || typeof stored !== 'object') return salvaged;

  const telemetry = salvageTelemetryDecision(stored);
  if (telemetry) salvaged.telemetry = telemetry;

  for (const entry of PROTECTIVE_CARRYOVERS) {
    // A carried decision already restored the whole telemetry block verbatim;
    // re-deciding its channels leaf by leaf could only contradict it.
    if (salvaged.telemetry && entry.path.startsWith('telemetry.')) continue;
    const value = moreProtective(entry, readPath(stored, entry.path), readPath(fresh, entry.path));
    if (value !== undefined) salvaged.leaves[entry.path] = value;
  }

  return salvaged;
}

/**
 * The minimal store surface this module writes through — the same shape the
 * migration bodies take, so a test can drive it without a real `conf` instance.
 */
export interface ProtectedStateStore {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

/**
 * Re-apply salvaged protections onto a freshly-defaulted store.
 *
 * Writes whole top-level sections rather than dot-paths, because `conf`'s
 * dot-path setter and the Ajv `useDefaults` pass do not agree about partially
 * written nested objects; merging onto the section the fresh store already holds
 * keeps every sibling default intact.
 *
 * Logs one line per section it restored. A person whose config was just replaced
 * should be able to read the boot log and see which of their choices came back.
 *
 * @param store - The freshly-created store to write into.
 * @param salvaged - The output of {@link salvageProtectedState}.
 * @returns The dot-paths actually restored, for logging and tests.
 */
export function applyProtectedState(
  store: ProtectedStateStore,
  salvaged: SalvagedProtections
): string[] {
  const restored: string[] = [];
  const sections = new Map<string, Record<string, unknown>>();

  const section = (name: string): Record<string, unknown> => {
    const existing = sections.get(name);
    if (existing) return existing;
    const current = store.get(name);
    const draft =
      current !== null && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : {};
    sections.set(name, draft);
    return draft;
  };

  if (salvaged.telemetry) {
    // Merged onto the fresh section rather than replacing it, so a channel added
    // to the schema after this module was written still arrives with its own
    // default instead of going missing and re-condemning the file. The drift
    // test over {@link TELEMETRY_CHANNELS} is what stops such a channel from
    // quietly defaulting ON for someone who already answered.
    sections.set('telemetry', { ...section('telemetry'), ...salvaged.telemetry });
    restored.push('telemetry (your consent choice)');
  }

  for (const [path, value] of Object.entries(salvaged.leaves)) {
    const [top, ...rest] = path.split('.');
    if (top === undefined) continue;
    const draft = section(top);
    if (rest.length === 0) continue;
    writePath(draft, rest.join('.'), value);
    restored.push(path);
  }

  for (const [name, value] of sections) store.set(name, value);
  return restored;
}

/**
 * Restore protections onto a store that was just wiped, and say so in the log.
 *
 * The one entry point both wipe paths use, so corrupt-recovery and
 * `ConfigManager.reset()` can never drift apart on what survives.
 *
 * @param store - The freshly-defaulted store.
 * @param stored - The config as it was before the wipe, or `undefined` when it
 *   could not be read at all.
 * @param context - What wiped the config, for the log line.
 */
export function restoreProtectedState(
  store: ProtectedStateStore,
  stored: unknown,
  context: string
): void {
  const salvaged = salvageProtectedState(stored, readCarryoverSections(store));
  const restored = applyProtectedState(store, salvaged);
  if (restored.length > 0) {
    logger.warn(`[Config] ${context}: kept your safer settings — ${restored.join(', ')}`);
  }
}

/**
 * Read the top-level sections the carryover rules touch, as a plain object the
 * dot-path reader can walk.
 *
 * Reads section by section rather than through `conf`'s whole-store accessor so
 * the narrow {@link ProtectedStateStore} shape stays sufficient, which is what
 * lets a test drive this without a real `conf` instance.
 *
 * @param store - The store to read.
 * @returns The sections named by {@link PROTECTIVE_CARRYOVERS}, plus `telemetry`.
 */
function readCarryoverSections(store: ProtectedStateStore): Record<string, unknown> {
  const roots = new Set(PROTECTIVE_CARRYOVERS.map((entry) => entry.path.split('.')[0]!));
  roots.add('telemetry');
  const snapshot: Record<string, unknown> = {};
  for (const root of roots) snapshot[root] = store.get(root);
  return snapshot;
}

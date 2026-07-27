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
 *    (`hasTier1SendGate`) onto whatever the channels defaulted to, which is
 *    worse than carrying nothing.
 * 2. **A value more protective than the default.** {@link PROTECTIVE_CARRYOVERS}
 *    lists every leaf whose default sits on the permissive side, with the
 *    direction that protects.
 *
 * ## The one invariant: carryover is monotone toward protection
 *
 * **Recovery can only ever land at or below a fresh install's exposure.** A
 * stored value on the protective side is carried; a stored value on the
 * permissive side is not, and it does not matter which side the default happens
 * to sit on, because every comparison is against the fresh value rather than a
 * hardcoded constant. A decision that cannot be reproduced within that bound is
 * dropped entirely and the notice is left armed, so the person is asked again
 * rather than silently re-enrolled or silently opted out.
 *
 * A leaf whose default is ALREADY the protective option needs no entry in
 * {@link PROTECTIVE_CARRYOVERS} for its own sake — a wipe lands on it for free.
 * Some are listed anyway because a person can move PAST the default: a room
 * spend cap ships at a real bound and can still be tightened further.
 *
 * ## Everything carried is proved against the real schema
 *
 * The source is a file that just FAILED validation, and all of this runs inside
 * the recovery `catch` — the last-resort always-boots guarantee. A value written
 * back unchecked is re-validated by `conf`'s Ajv on `set()`, and that throw
 * escapes the catch and takes down the boot this code exists to rescue.
 *
 * A `typeof` check is not enough: `trustWindowMinutes: 1` is a number and
 * violates `.min(5)`; `standingGrantsVoidBefore: '2026-07-27'` is a string and
 * violates `.datetime()`. So every candidate is parsed against its real section
 * schema before being promised ({@link sectionSchemaAccepts}), each section is
 * re-checked as assembled, and each write is wrapped. Values are judged one at a
 * time, so one unreadable field never costs another, and a section that still
 * cannot be written is dropped and logged rather than left half-applied.
 *
 * @module services/core/safe-defaults/protected-state
 */
import { z } from 'zod';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../../lib/logger.js';

/**
 * The later of two posture-floor instants, treating a missing one as "no floor".
 *
 * Ordering fixed-width UTC strings as text orders them as instants, the same
 * property the grant store's own comparison relies on.
 *
 * That holds ONLY for genuine `Date.prototype.toISOString()` output, so **every
 * caller must validate first**. This is not a theoretical caveat: the salvage
 * path reads from a file that already failed validation, and
 * `'December 31, 2020'` sorts above every real 2026 timestamp as text, which
 * would LOWER a floor that had already voided standing permissions. The
 * `'later'` branch of `moreProtective` checks {@link IsoInstantSchema} before
 * calling for exactly that reason.
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
    path: 'agentContext.relayTools',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'Agent-to-agent messaging tools default ON. Someone who took them away from their agents should not have them handed back by a wipe.',
  },
  {
    path: 'agentContext.meshTools',
    direction: 'boolean',
    protectiveValue: false,
    reason: 'Agent discovery tools default ON; turning them off is a deliberate narrowing.',
  },
  {
    path: 'agentContext.adapterTools',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'Chat-adapter tools default ON and are the surface an agent uses to speak on an outside channel.',
  },
  {
    path: 'agentContext.tasksTools',
    direction: 'boolean',
    protectiveValue: false,
    reason: 'Scheduled-work tools default ON and are how an agent arranges unattended runs.',
  },
  {
    path: 'harness.autoSync',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'Harness Sync defaults ON and writes into the harness directories of projects on disk. Someone who stopped those writes should not have them resume silently.',
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
const PROTECTIVE_TELEMETRY_VALUE = false;

/**
 * The telemetry channels, and the value each takes for someone who answered a
 * consent prompt that did not yet mention the channel.
 *
 * Every one of them protects by being OFF, which is what
 * {@link PROTECTIVE_TELEMETRY_VALUE} states once for all of them. A new channel
 * that did NOT have that property could not be clamped by this code and would
 * need its own rule — the drift test over this list is what surfaces one.
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

/**
 * Whether a candidate top-level section would survive the real schema.
 *
 * This is the load-bearing check, and it has to be the SCHEMA rather than a
 * `typeof`. Everything here runs inside the recovery `catch`, so a value written
 * back unchecked is re-validated by `conf`'s Ajv on `set()`, and that throw
 * escapes the catch and takes down the boot this code exists to rescue. A
 * type-correct value is not a valid one: `approvals.trustWindowMinutes: 1` is a
 * number and violates `.min(5)`; `standingGrantsVoidBefore: '2026-07-27'` is a
 * string and violates `.datetime()`.
 *
 * Parses the whole assembled section rather than the leaf alone, which needs no
 * Zod-internals walk to find a leaf schema and catches cross-field rules for
 * free. The base is always the fresh section, which is valid by construction, so
 * a failure is attributable to the one carried value.
 *
 * @param section - Top-level config key (e.g. `approvals`).
 * @param draft - The candidate value for that whole section.
 */
function sectionSchemaAccepts(section: string, draft: unknown): boolean {
  const shape = UserConfigSchema.shape as Record<string, z.ZodType | undefined>;
  const schema = shape[section];
  // An unknown section is refused rather than trusted: carrying a value we
  // cannot validate is the exact failure this function exists to prevent.
  if (!schema) return false;
  return schema.safeParse(draft).success;
}

/** A strict ISO-8601 instant, matching `z.string().datetime()` on the leaf. */
const IsoInstantSchema = z.string().datetime();

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
 * Recover a person's telemetry answer from a stored config, clamped so that
 * recovery can never land above a fresh install's exposure.
 *
 * ## Carryover is monotone toward protection
 *
 * Every channel here protects by being OFF, so a stored `false` is carried and a
 * stored `true` is NOT — it falls back to whatever a fresh config carries. The
 * clamp is written against `fresh` rather than against a hardcoded `false`, so
 * it stays correct whichever way the defaults sit: it can only ever move the
 * result toward protection or leave it where a fresh install would be.
 *
 * ## Why a clamped "yes" drops the decision flag too
 *
 * If nothing had to be clamped, the person's answer is reproduced exactly and
 * `userHasDecided` rides along, so they are not asked again.
 *
 * If anything WAS clamped, their stored answer and the recovered state disagree.
 * Carrying `userHasDecided` then would record "this person has answered" over a
 * set of values they did not choose, silently converting a yes into a no and
 * suppressing the notice that would have let them say yes again. So the decision
 * flag is dropped and the notice stays armed: the honest outcome of losing a
 * consent decision is to ask, not to assume in either direction.
 *
 * A never-answered install returns `undefined` for the same reason — there is no
 * decision to preserve, and the notice gate holds every channel until it shows.
 *
 * Never returns a bare `userHasDecided`: the flag only ever travels with a full
 * set of channel values, so it cannot open the send gate onto defaults.
 *
 * @param stored - The parsed contents of the config file being replaced.
 * @param freshTelemetry - The `telemetry` block a fresh config carries.
 * @returns The recoverable answer, or `undefined` when none should be carried.
 */
export function salvageTelemetryDecision(
  stored: unknown,
  freshTelemetry: unknown
): UserConfig['telemetry'] | undefined {
  const parsed = StoredTelemetrySchema.safeParse(readPath(stored, 'telemetry'));
  if (!parsed.success) return undefined;
  const telemetry = parsed.data;
  if (telemetry.userHasDecided !== true) return undefined;

  const fresh = StoredTelemetrySchema.safeParse(freshTelemetry);
  if (!fresh.success) return undefined;

  let clamped = false;
  const channels = {} as Record<(typeof TELEMETRY_CHANNELS)[number], boolean>;
  for (const channel of TELEMETRY_CHANNELS) {
    // A channel the file does not mention was never covered by their answer, so
    // it takes the protective value rather than the schema default.
    const chosen = telemetry[channel] ?? PROTECTIVE_TELEMETRY_VALUE;
    const freshValue = fresh.data[channel] ?? PROTECTIVE_TELEMETRY_VALUE;
    const value = chosen === PROTECTIVE_TELEMETRY_VALUE ? chosen : freshValue;
    if (value !== chosen) clamped = true;
    channels[channel] = value;
  }

  // Their answer could not be reproduced as given: ask again rather than record
  // a decision they did not make.
  if (clamped) return undefined;

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
      // Validated as a strict ISO instant BEFORE comparing, not merely parsed as
      // a date. `latestInstant` orders fixed-width UTC strings as text, and that
      // only orders instants when both really are fixed-width UTC: `Date.parse`
      // accepts `'December 31, 2020'`, which sorts above every genuine 2026
      // floor and would lower a floor that had already voided permissions.
      if (!IsoInstantSchema.safeParse(stored).success) return undefined;
      const freshFloor = IsoInstantSchema.safeParse(fresh).success ? (fresh as string) : null;
      const winner = latestInstant(freshFloor, stored as string);
      return winner !== null && winner !== fresh ? winner : undefined;
    }
  }
}

/**
 * Collect everything worth carrying from a config that is about to be replaced.
 *
 * Pure: reads the two inputs and returns a description of what to re-apply.
 * Never throws, and the result is guaranteed to satisfy the real schema — a
 * candidate that would not is dropped here rather than written and rejected by
 * Ajv inside the recovery catch, where the throw would take down the boot this
 * is trying to rescue. Each leaf is judged on its own, so one unreadable value
 * never costs another.
 *
 * @param stored - The parsed contents of the file being replaced. Pass
 *   `undefined` when the file could not be parsed at all.
 * @param fresh - The config as it stands after the wipe, i.e. the defaults.
 * @returns The protections to re-apply on top of `fresh`.
 */
export function salvageProtectedState(stored: unknown, fresh: unknown): SalvagedProtections {
  const salvaged: SalvagedProtections = { leaves: {} };
  if (stored === null || typeof stored !== 'object') return salvaged;

  const telemetry = salvageTelemetryDecision(stored, readPath(fresh, 'telemetry'));
  if (telemetry && sectionSchemaAccepts('telemetry', telemetry)) salvaged.telemetry = telemetry;

  for (const entry of PROTECTIVE_CARRYOVERS) {
    // A carried decision already restored the whole telemetry block;
    // re-deciding its channels leaf by leaf could only contradict it.
    if (salvaged.telemetry && entry.path.startsWith('telemetry.')) continue;
    const value = moreProtective(entry, readPath(stored, entry.path), readPath(fresh, entry.path));
    if (value === undefined) continue;

    // Prove the carried value against the real schema before promising it. The
    // base is the fresh section, valid by construction, so a rejection here is
    // attributable to this one value.
    const [section, ...rest] = entry.path.split('.');
    if (section === undefined || rest.length === 0) continue;
    const freshSection = readPath(fresh, section);
    const draft =
      freshSection !== null && typeof freshSection === 'object'
        ? { ...(freshSection as Record<string, unknown>) }
        : {};
    writePath(draft, rest.join('.'), value);
    if (!sectionSchemaAccepts(section, draft)) continue;

    salvaged.leaves[entry.path] = value;
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
 * ## Nothing here may throw
 *
 * This runs inside the recovery `catch`, which is the last-resort always-boots
 * guarantee. {@link salvageProtectedState} has already proved every value
 * against the schema, so the checks below are the second half of a belt and
 * braces: the section is re-validated as assembled, and each `set` is wrapped,
 * because the whole point of this code path is that it runs when assumptions
 * have already failed. A section that still cannot be written is dropped and
 * logged, and the remaining sections are unaffected — no partial write, no
 * escaping throw.
 *
 * @param store - The freshly-created store to write into.
 * @param salvaged - The output of {@link salvageProtectedState}.
 * @returns The dot-paths actually restored, for logging and tests.
 */
export function applyProtectedState(
  store: ProtectedStateStore,
  salvaged: SalvagedProtections
): string[] {
  const labels = new Map<string, string[]>();
  const sections = new Map<string, Record<string, unknown>>();
  const label = (name: string, text: string): void => {
    labels.set(name, [...(labels.get(name) ?? []), text]);
  };

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
    label('telemetry', 'telemetry (your consent choice)');
  }

  for (const [path, value] of Object.entries(salvaged.leaves)) {
    const [top, ...rest] = path.split('.');
    if (top === undefined) continue;
    const draft = section(top);
    if (rest.length === 0) continue;
    writePath(draft, rest.join('.'), value);
    label(top, path);
  }

  const restored: string[] = [];
  for (const [name, value] of sections) {
    if (!sectionSchemaAccepts(name, value)) {
      logger.warn(`[Config] Could not keep your ${name} settings: they no longer fit the schema.`);
      continue;
    }
    try {
      store.set(name, value);
    } catch (error) {
      // Booting matters more than any one setting. Drop this section, say so,
      // and carry on with the rest.
      logger.warn(
        `[Config] Could not keep your ${name} settings: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    restored.push(...(labels.get(name) ?? []));
  }
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

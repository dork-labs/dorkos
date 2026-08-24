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
 * shipping a schema below its migration key skips it for every user. DOR-579's
 * sidebar rename is the instance that made this concrete: for one release
 * `config-manager.ts` widened the schema so such a file still loaded, and now
 * that the tolerance is gone (DOR-588) this salvage is the whole of what stands
 * between a stale file and a person's privacy choice.
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
 * "Tightened" is about exposure, not about the number going down. A cap tightens
 * by falling and a threshold tightens by rising, which is why
 * {@link CarryoverDirection} carries both `lower` and `higher` — reading that
 * shape off each field is what keeps the invariant above true for all of them.
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
 * - `higher` — a threshold, where a LARGER number is the quieter setting.
 * - `later` — a monotonic floor, where a later instant voids more.
 *
 * `higher` is not the odd one out it looks like. Most numbers here are caps, so
 * tightening means lowering; a few are thresholds something has to CROSS before
 * anything happens, and tightening those means raising them. Both are the same
 * question — "which of these two numbers lets less happen" — asked of a
 * differently-shaped bound, and a person who set one has protected themselves
 * either way. Reading the shape off the field rather than assuming every number
 * is a cap is what stops `welcomeBack.absenceThresholdMinutes` at a week being
 * silently reset to four hours by a recovery.
 */
export type CarryoverDirection = 'boolean' | 'lower' | 'higher' | 'later';

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
 * Two kinds of entry live here, and the second is easy to miss:
 *
 * 1. A default on the permissive side, where any protective value is worth
 *    keeping (`auth.enabled`, `mcp.enabled`, the `agentContext.*` tools).
 * 2. A default that is ALREADY a real bound but can be tightened past
 *    (`rooms.*`, `uploads.max*`, `mcp.rateLimit.maxPerWindow`,
 *    `approvals.trustWindowMinutes`). A `safe` verdict means the shipped value
 *    protects, not that it is the tightest a person might want, so recovery
 *    still has to preserve what they set.
 *
 * No telemetry channel appears in either kind. They default OFF since ADR
 * 260727-182651, so a wipe lands on the protective value unaided. The case that
 * still needs handling is the opposite one — someone who chose to keep sharing —
 * and that travels as a whole decision through
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
      'The agent-to-agent messaging tools are documented to every session by default. Turning that off is a deliberate narrowing of what a person tells their agents they can do, and a wipe must not undo it. Stated as documentation rather than as access on purpose: `resolveToolConfig` feeds the context blocks and nothing else, so these four never unregister a tool (DOR-1497).',
  },
  {
    path: 'agentContext.meshTools',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'The agent discovery tools, documented by default; turning them off is the same deliberate narrowing, and the same documentation-only caveat applies.',
  },
  {
    path: 'agentContext.adapterTools',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'The chat-adapter tools — how an agent speaks on an outside channel — documented by default. Narrowing it is a choice about what agents here are told they may reach for.',
  },
  {
    path: 'agentContext.tasksTools',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'The scheduled-work tools, documented by default; how an agent learns it can arrange an unattended run.',
  },
  {
    path: 'harness.autoSync',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'Harness Sync defaults ON and writes into the harness directories of projects on disk. Someone who stopped those writes should not have them resume silently.',
  },
  {
    path: 'uploads.maxFileSize',
    direction: 'lower',
    reason:
      'A tightened upload size cap. The default is a real bound, but a person can set a smaller one and a wipe must not raise it back.',
  },
  {
    path: 'uploads.maxFiles',
    direction: 'lower',
    reason: 'A tightened cap on how many files one upload may carry.',
  },
  {
    path: 'mcp.rateLimit.maxPerWindow',
    direction: 'lower',
    reason:
      'A tightened request ceiling on the external /mcp endpoint. Only the count is carried; `windowSecs` is deliberately not, because a shorter window with the same count allows MORE traffic, not less.',
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
    path: 'rooms.maxTurnsPerAgentPerCascade',
    direction: 'lower',
    reason:
      'How many TURNS any ONE agent may take in an exchange. The same bound read per agent instead of per chain, and a person can set a smaller one for the same reason: it spends real money.',
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
  {
    path: 'rooms.engagedWindowMinutes',
    direction: 'lower',
    reason:
      'How long an agent keeps answering after somebody addressed it. A shorter window is a tightened bound, and a wipe that lengthened it would put agents back into conversations a person had narrowed them out of.',
  },
  {
    path: 'rooms.engagedWindowPosts',
    direction: 'lower',
    reason: 'The same window, counted in messages from other members instead of minutes.',
  },
  {
    path: 'rooms.collectDebounceMs',
    direction: 'higher',
    reason:
      'How long a room gathers a burst of messages before answering it as one. Longer is the tightened bound here, not shorter: a person who lengthened it chose fewer, more considered replies, and a wipe that shortened it would buy them a turn per message.',
  },
  {
    path: 'rooms.collectMaxEntries',
    direction: 'higher',
    reason:
      'The most messages one gathered-up answer covers. Higher is the tightened bound for the same reason: raising it folds more of a busy room into one turn, and a wipe that lowered it would split that turn back into several.',
  },
  {
    path: 'welcomeBack.enabled',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'Welcome-back posts default ON. Someone who stopped their agents greeting them should not be greeted again by a wipe — and a greeting that carries a next-step offer spends a model turn.',
  },
  {
    path: 'welcomeBack.offersEnabled',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'Next-step offers default ON, and they are the one welcome-back leaf that spends a model turn. Turning them off is somebody declining a cost; a wipe that landed back on the default would start billing them again, and they would find out from the invoice rather than from the app. Carried separately from `welcomeBack.enabled` because the two are separate refusals — "greet me, but do not run anything" is a real position, and losing only the second half of it is the failure that would go unnoticed longest.',
  },
  {
    path: 'welcomeBack.maxPosts',
    direction: 'lower',
    reason:
      'How many agents may speak on one return. The default is a real cap, but a person can set a smaller one and a wipe must not raise it back.',
  },
  {
    path: 'welcomeBack.absenceThresholdMinutes',
    direction: 'higher',
    reason:
      'How long you have to be away before coming back counts as a return. The protective direction is HIGHER here — a longer threshold means fewer returns qualify — so someone who set a week and lands back on four hours is greeted several times as often as they chose, without ever being asked.',
  },
  {
    path: 'runtimes.claudeCode.persistentSession',
    direction: 'boolean',
    protectiveValue: false,
    reason:
      'Warm agents default ON (spec `full-power-defaults`). Holding a process open between messages costs memory — up to about 1 GB per warm agent — so somebody who turned it off did so to get that memory back, on a machine that presumably needed it. A wipe that handed the default back would take it away again with nothing on screen to say why.',
  },
  {
    path: 'scheduler.maxConcurrentRuns',
    direction: 'lower',
    reason:
      'How many scheduled runs may be in flight at once. It used to ship at its schema minimum, so there was nothing below the default to tighten to and the leaf was exempt; it ships at 4 now, and a person who set it back to 1 chose one run at a time on purpose — a wipe must not put three more alongside it.',
  },
] as const;

/**
 * The value every telemetry channel takes to protect the person: OFF.
 *
 * Stated once for all of them, because the clamp in
 * {@link salvageTelemetryDecision} has to know which side protects. It is also
 * what an unmentioned channel falls back to: a person's answer is only ever as
 * wide as the question they were asked, so a channel absent from the stored file
 * comes back OFF rather than at its schema default — the same reasoning
 * `backfillTelemetryUsageChannel` applies on the upgrade path.
 *
 * A future channel that did NOT protect by being off could not be clamped by
 * this code and would need its own rule.
 */
const PROTECTIVE_TELEMETRY_VALUE = false;

/**
 * Every telemetry channel, as the clamp and the whole-decision carryover
 * enumerate them.
 *
 * A channel added to the schema but missed here would keep its own default
 * through a wipe instead of being clamped, so `applyProtectedState` merges onto
 * the fresh section rather than replacing it — that way the miss costs the
 * clamp, never the whole block's validity.
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
  /**
   * Values found on the protective side that could NOT be carried, and why.
   *
   * Populated when a stored value is more protective than the default but fails
   * its own schema — a hand-edited `trustWindowMinutes: 1`, a `voidBefore` that
   * is not a real timestamp. Those are dropped rather than written, and an
   * operator whose tightened setting was discarded has to be able to find out
   * which one, so the caller logs these. An empty list is the normal case.
   */
  dropped: Array<{ path: string; reason: string }>;
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
    case 'higher': {
      // The mirror of `lower`, down to the guards: a stored `NaN`/`Infinity` or a
      // non-numeric fresh value is unusable in either direction, and a stored
      // value on the permissive side is left alone rather than written back.
      if (typeof stored !== 'number' || !Number.isFinite(stored)) return undefined;
      if (typeof fresh !== 'number') return undefined;
      return stored > fresh ? stored : undefined;
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
  const salvaged: SalvagedProtections = { leaves: {}, dropped: [] };
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
    if (!sectionSchemaAccepts(section, draft)) {
      // The person had moved this to the protective side, and we cannot honour
      // it. Recorded so the caller can say so rather than dropping it in
      // silence — see `SalvagedProtections.dropped`.
      salvaged.dropped.push({
        path: entry.path,
        reason: `the stored value ${JSON.stringify(value)} is not valid for this setting`,
      });
      continue;
    }

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
 * Logs what was kept AND what could not be. A setting the person had tightened
 * that we had to discard is the thing they most need told: it is silently back
 * at a looser value, and only the log says so.
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
  for (const { path, reason } of salvaged.dropped) {
    logger.warn(
      `[Config] Could not keep your ${path} setting: ${reason}. It is back at the default.`
    );
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

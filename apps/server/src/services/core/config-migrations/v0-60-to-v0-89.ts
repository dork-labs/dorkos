/**
 * Config migration helpers for the keys from `0.60.0` through `0.89.0`:
 * accounts, room limits, full power, memory, harness, canvas and identity
 * seeds.
 *
 * Each helper is a body that a key in `CONFIG_MIGRATIONS` (`./index.ts`)
 * calls, moved here verbatim from `config-manager.ts`. A body is frozen once
 * it merges: see `./index.ts` for the rules, and `contributing/configuration.md`
 * → Schema Migrations for the process.
 *
 * @module services/core/config-migrations/v0-60-to-v0-89
 */
import {
  USER_CONFIG_DEFAULTS,
  NOTIFICATION_PREFS_DEFAULTS,
  claudeAccountId,
} from '@dorkos/shared/config-schema';

/**
 * Migration body: seed `extensions.approvedSources: {}` for configs persisted
 * before an extension approval recorded WHICH copy of the extension it was for
 * (DOR-2383).
 *
 * Seeds the map EMPTY and binds nothing, on purpose. Which copy an existing
 * id-only approval was about is a question about the disk, and this runs before
 * anything has looked at the disk. `ExtensionManager.reload` answers it on the
 * first discovery instead, binding each such approval to the extension installed
 * directly under `{dorkHome}/extensions/<id>` — the only copy an id-only approval
 * ever let run. An approved id found only inside a plugin stays unbound, which
 * counts as not approved, so a plugin that carries an old approved id is asked
 * about first rather than inheriting the decision.
 *
 * Additive and idempotent: writes only when `approvedSources` is not already an
 * object, and never touches the other `extensions` members. A config with no
 * `extensions` key is skipped (the schema default supplies the object on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedExtensionsApprovedSources(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return;
  const sources = (ext as { approvedSources?: unknown }).approvedSources;
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) return;
  store.set('extensions', { ...(ext as Record<string, unknown>), approvedSources: {} });
}

/**
 * Migration body: remove `scheduler.timezone` (DOR-1482).
 *
 * The setting never did anything. Every schedule carries its own timezone —
 * `pulse_schedules.timezone` is NOT NULL DEFAULT 'UTC', and every write path
 * fills it — so the scheduler's `task.timezone ?? config.timezone` fallback
 * could not be reached, and a person who set a "default timezone for cron
 * expressions" in Settings changed nothing at all. Being honest by design means
 * a control that does nothing is removed, not left there looking functional.
 *
 * Idempotent: only deletes the key when it is present. Nothing is migrated onto
 * the schedules themselves — they already have the value they run on.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `has`/`delete`).
 */
export function dropSchedulerTimezone(store: {
  has: (key: string) => boolean;
  delete: (key: string) => void;
}): void {
  if (store.has('scheduler.timezone')) {
    store.delete('scheduler.timezone');
  }
}

/**
 * Migration body: raise the three shipped room bounds for installs still
 * carrying the values they were seeded with, and add the two leaves the new
 * bounds model introduced (DOR-1428, plan `room-turn-limits-overhaul`).
 *
 * **Only a value that still equals its old default moves.** 3 -> 30, 60 ->
 * 1000, 240 -> 5000, and anything else is left exactly where it stands: a
 * number somebody typed is a decision, and a migration that overwrote it would
 * be spending their money on their behalf (safe-defaults rule 3). The cost of
 * that rule is stated rather than hidden — a person who deliberately set 3
 * reads as never having touched it, and gets 30 like everybody else. There is
 * no way to tell the two apart from the file, and Settings is the remedy.
 *
 * The two new leaves are added here for the reason every `rooms` backfill in
 * this table exists: conf merges top-level defaults SHALLOWLY, so a `rooms`
 * block already on disk never inherits a nested field on its own. Without this
 * an upgraded install would run with `turnLimitsEnabled` undefined and fail
 * validation on the next write.
 *
 * Idempotent: a second run finds 30/1000/5000, none of which equal the old
 * defaults, and the two new keys already present.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function raiseRoomTurnLimits(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const rooms = store.get('rooms');
  if (rooms == null || typeof rooms !== 'object') return;
  const current = { ...(rooms as Record<string, unknown>) };
  let changed = false;

  /** The old shipped value, and what it becomes when nobody has moved it. */
  const RAISED: ReadonlyArray<readonly [string, number, number]> = [
    ['maxAgentDepth', 3, 30],
    ['maxAutomaticTurnsPerRoomPerHour', 60, 1000],
    ['maxAutomaticTurnsTotalPerHour', 240, 5000],
  ];
  for (const [key, was, becomes] of RAISED) {
    if (current[key] === was) {
      current[key] = becomes;
      changed = true;
    }
  }

  /** The leaves this release adds, seeded at the values the schema ships. */
  const ADDED: Readonly<Record<string, unknown>> = {
    turnLimitsEnabled: true,
    maxTurnsPerAgentPerCascade: 10,
  };
  for (const [key, value] of Object.entries(ADDED)) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }

  if (changed) store.set('rooms', current);
}

/**
 * Migration body: seed the `a2a` section at `{ enabled: false }` (DOR-1304).
 *
 * `a2a.enabled` moves the A2A gateway's gate off `DORKOS_A2A_ENABLED` alone and
 * onto a setting the Experiments section in Settings can switch, with the
 * environment variable still winning when it is present. Seeded `false`, which is
 * byte-for-byte the behavior before the field existed: nothing outside DorkOS
 * could reach these agents over A2A unless the variable said so, and nothing can
 * now either.
 *
 * Unlike the nested backfills above, this is a TOP-LEVEL section, and conf's
 * defaults-merge does reach those: it runs before the first migration key and
 * WRITES the merged result to the file, so `a2a` arrives on disk with or without
 * this body — measured with the body suppressed (DOR-1496). So this really is an
 * anchor, not the only thing standing between an upgrade and a missing key. It
 * earns its place because a gate that ships closed should say so somewhere a
 * reviewer looks, rather than only in a schema default.
 *
 * Additive + idempotent: written only when the section is absent, so re-running
 * never closes a gate somebody opened.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedA2aDisabled(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const current = store.get('a2a');
  if (current != null && typeof current === 'object') return;
  store.set('a2a', { enabled: false });
}

/**
 * Migration body: put `ui.promos` into its `{ dismissedIds: [] }` shape on an
 * existing `ui` block (spec `sidebar-simplification` D4).
 *
 * Which promo cards a person has waved away moved off `localStorage` and into
 * config, so the answer follows them between devices instead of being re-asked
 * on every browser. This body only reserves the shape; the cockpit imports
 * whatever the old browser key holds the first time it reads the new list, and
 * that import is per browser, which is the only place those ids exist.
 *
 * This body is the ONLY thing that puts `ui.promos` on disk, and this docblock
 * used to say the opposite — that it was a no-op anchor like
 * {@link backfillProfileDefaults} and {@link seedA2aDisabled}, because Ajv's
 * `useDefaults` writes the section into a stored `ui` block whether or not the
 * migration runs, "measured, not assumed". Re-measured in DOR-1496, that is
 * false, and the two it named are not comparable: `profile` and `a2a` are whole
 * TOP-LEVEL sections, which conf writes to the file from `defaults` before any
 * key runs, whereas `promos` is a leaf inside a `ui` object the file already
 * has. Conf's merge is shallow, so it never reaches that leaf, and Ajv's fill
 * lands in the throwaway copy the `store` getter is about to return, which is
 * discarded. Suppress this body and `ui.promos` is absent from `config.json`
 * for every upgrading install. See "Which of these bodies is a real no-op, and
 * which only looks like one" above `CONFIG_MIGRATIONS`.
 *
 * Additive + idempotent: seeds only when `promos` is missing, so re-running can
 * never erase a dismissal.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillPromoDismissals(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (ui == null || typeof ui !== 'object') return;
  if ('promos' in ui && (ui as { promos?: unknown }).promos != null) return;
  store.set('ui', { ...(ui as Record<string, unknown>), promos: { dismissedIds: [] } });
}

/**
 * Seed `notifications` — how DorkOS gets your attention (spec
 * `notification-system`, DOR-1385).
 *
 * A whole top-level section rather than a field inside one, so unlike
 * {@link backfillPromoDismissals} next door there is nothing on disk to merge
 * into: an install that predates this has no `notifications` key at any depth,
 * and the section is written through whole.
 *
 * Seeded from {@link NOTIFICATION_PREFS_DEFAULTS} rather than a literal, so the
 * table cannot drift from the schema it is seeding — the same reason the sidebar
 * and profile backfills read their defaults constants.
 *
 * Additive + idempotent: seeds only when the section is missing, so re-running
 * can never overwrite a choice somebody made.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillNotificationDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('notifications') != null) return;
  store.set('notifications', NOTIFICATION_PREFS_DEFAULTS);
}

/**
 * Migration body: rename `runtimes.claudeCode.activeAccount` to `defaultAccount`
 * and give every registered account a stable `id` (spec
 * `billing-account-ladder`, ADR 260821-205324).
 *
 * **Both halves are load-bearing, and neither is additive.**
 *
 * The rename carries the VALUE. `activeAccount` held the absolute path of the
 * Claude config directory the operator's work bills to; left behind under the
 * old key, the new one takes its `null` default and every new session silently
 * moves onto whatever account the environment happens to point at — a different
 * client's subscription, for the operator this feature was written for. The old
 * key is then deleted rather than left beside the new one so the file converges
 * on one spelling — NOT because leaving it would fail validation: Ajv would
 * accept it, since `tolerateUnknownKeys` (`config/version-skew.ts`) reopens
 * every generated object precisely so a key this build does not know cannot
 * condemn a file. Two keys for one setting is the hazard here, not a rejected
 * read: whichever one a later reader happens to consult decides who gets
 * billed.
 *
 * The id backfill makes existing accounts REFERENCEABLE. An agent manifest and a
 * session launch hint name an account by id, so a registry whose entries have no
 * ids can be pointed at by nothing at all — and the id is required by the
 * schema, so an un-backfilled entry fails validation outright. Ids come from
 * {@link claudeAccountId}: the operator's label slugified, else the directory's
 * basename, else `account`, uniquified against the ids already assigned. That is
 * the same function the settings UI registers new accounts with, so an id minted
 * here and an id minted there are minted by one rule.
 *
 * Idempotent in both halves: the rename runs only while the old key is present
 * and the new one is not, and an entry that already carries a non-empty `id`
 * keeps it, so a re-run cannot rename an account out from under an agent that
 * references it.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function migrateClaudeAccountRegistry(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const claudeCode = (runtimes as { claudeCode?: unknown }).claudeCode;
  if (claudeCode == null || typeof claudeCode !== 'object') return;

  const block = { ...(claudeCode as Record<string, unknown>) };
  let changed = false;

  if ('activeAccount' in block) {
    // A `null` under the new name does NOT outrank a value under the old one.
    //
    // The premise this once carried — "only a config written before this
    // migration carries the old key, so the two cannot disagree" — was false,
    // and the way it failed was expensive. On any install this migration is
    // skipped on, one unrelated settings write persists the whole parsed config
    // and lands `defaultAccount: null` beside the still-present `activeAccount`.
    // Preferring the new key there discards the operator's billing choice
    // permanently, by way of a theme change. `null` is the absence of a choice;
    // a real path under the new name is a decision made since the rename and
    // still wins.
    if (block.defaultAccount == null) block.defaultAccount = block.activeAccount;
    delete block.activeAccount;
    changed = true;
  }

  const accounts = block.accounts;
  if (Array.isArray(accounts)) {
    const taken = new Set<string>();
    for (const entry of accounts) {
      if (entry && typeof entry === 'object') {
        const id = (entry as { id?: unknown }).id;
        if (typeof id === 'string' && id.length > 0) taken.add(id);
      }
    }
    const next = accounts.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const account = entry as Record<string, unknown>;
      const existing = account.id;
      if (typeof existing === 'string' && existing.length > 0) return account;
      const id = claudeAccountId({
        label: typeof account.label === 'string' ? account.label : null,
        path: typeof account.path === 'string' ? account.path : '',
        taken,
      });
      taken.add(id);
      changed = true;
      return { ...account, id };
    });
    if (changed) block.accounts = next;
  }

  if (!changed) return;
  store.set('runtimes', { ...(runtimes as Record<string, unknown>), claudeCode: block });
}

/**
 * Migration body: rename a Claude account row whose id is `default` to the
 * next free `default-N` (spec `claude-account-fleet` D1, contract
 * `flow-cli-core` §1.1a revision 6d).
 *
 * `default` now names the runtime's default account everywhere, so a
 * REGISTERED row called `default` would be a second account answering to it.
 * Before this rule an account labelled "Default", or kept in a folder called
 * `default`, minted exactly that id. `claudeAccountId` no longer can, and this
 * is what moves a row an earlier build already minted.
 *
 * **Not additive, and deliberately so.** An id is a reference, so a rename has
 * followers: an agent manifest's `account`, a schedule's `account` and its
 * approval key, and a schedule `SKILL.md` saying `account: default`. None of
 * those live in this file, and a migration runs before the agent registry and
 * the task store exist, so this body cannot move them. It leaves a marker
 * instead: the renamed row carries `renamedFrom: 'default'`, a field rows keep
 * across every write (a registry row is a loose object), so the account
 * reconcile can move each reference to the new id and then drop the marker.
 * Until that runs, a reference that still says `default` resolves to the
 * default account, which is what the contract says `default` means.
 *
 * Idempotent: a second run finds no row called `default`. Every id already
 * present is reserved before any is chosen, so a rename never collides with a
 * row that already owns `default-2`.
 *
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function renameReservedClaudeAccountIds(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) return;
  const block = (runtimes as Record<string, unknown>).claudeCode;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return;
  const accounts = (block as Record<string, unknown>).accounts;
  if (!Array.isArray(accounts)) return;

  const taken = new Set<string>();
  for (const entry of accounts) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === 'string') taken.add(id);
  }
  let changed = false;
  const next = accounts.map((entry) => {
    if (!entry || typeof entry !== 'object' || (entry as { id?: unknown }).id !== 'default') {
      return entry;
    }
    let n = 2;
    while (taken.has(`default-${n}`)) n++;
    const id = `default-${n}`;
    taken.add(id);
    changed = true;
    return { ...(entry as Record<string, unknown>), id, renamedFrom: 'default' };
  });
  if (!changed) return;
  store.set('runtimes', {
    ...(runtimes as Record<string, unknown>),
    claudeCode: { ...(block as Record<string, unknown>), accounts: next },
  });
}

/**
 * Migration body: reserve both halves of the power-door answer on an existing
 * `ui` block (spec `full-power-defaults`, D2).
 *
 * `ui.fullPowerDecidedAt` records WHEN the person answered the door — either
 * way — and `ui.fullPowerChoice` records what they said. Seeded `null`, which
 * means "not asked yet", so the door goes up once on the next launch and never
 * again after they answer.
 *
 * **Nothing consent-gated is touched here, and that is the whole point of the
 * key** (the program's A1 invariant). `runtimes.defaultTrustStop`,
 * `ui.autonomyAcknowledgedAt`, `approvals.standingGrants`, the mesh access rules
 * and `canInitiate` are written by the door's ACCEPT and by nothing else. A
 * reviewer finding any of them in a migration should treat it as a defect.
 *
 * **This one is LOAD-BEARING, not an anchor**, and the distinction is worth
 * stating because several bodies above it really are anchors. Two facts about
 * `conf@15` combine here, and both were measured rather than read off the types:
 *
 * 1. Validation is skipped for the whole migration window (`#isInMigration`
 *    guards `_validate` in both the store getter and the store setter), so
 *    Ajv's `useDefaults` fills nothing while this runs. The only merge that
 *    happens first is `Object.assign({}, defaults, fileStore)`, which is
 *    TOP-LEVEL and shallow — a stored `ui` object wins wholesale, so it does not
 *    gain a leaf it has never held.
 * 2. After the migration, `useDefaults` still never reaches the file: the `store`
 *    getter re-reads and re-parses `config.json` on every access and validates
 *    that throwaway copy, so Ajv's mutation is discarded with it.
 *
 * Measured on an upgrade boot with this body suppressed: `ui` on disk keeps
 * exactly its stored keys and neither leaf appears, while `getDot` still answers
 * `null` — because the read is answered from the copy Ajv just filled. So a test
 * that only asserts the read is vacuous here; the one in
 * `config-full-power-defaults-migration.test.ts` asserts the FILE.
 *
 * Additive + idempotent: each leaf is written only when it is absent, so a
 * re-run can never erase an answer somebody already gave.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedFullPowerDecision(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (ui == null || typeof ui !== 'object') return;
  const block = ui as Record<string, unknown>;
  const next = { ...block };
  let changed = false;
  if (!('fullPowerDecidedAt' in block)) {
    next.fullPowerDecidedAt = null;
    changed = true;
  }
  if (!('fullPowerChoice' in block)) {
    next.fullPowerChoice = null;
    changed = true;
  }
  if (changed) store.set('ui', next);
}

/**
 * Migration body: move a stored `scheduler.maxConcurrentRuns` of exactly `1` up
 * to the new default of `4` (spec `full-power-defaults`, D1/D2).
 *
 * Needed because a schema default alone would reach nobody who has upgraded:
 * conf builds Ajv with `useDefaults`, so a declared default is written only
 * where the key is ABSENT, and every install that has ever booted carries this
 * key at `1`.
 *
 * **The honest caveat, recorded on purpose.** A stored `1` is indistinguishable
 * from an explicit choice of `1`, because `1` is what shipped — there is no
 * evidence anywhere on disk that separates "never touched it" from "set it back
 * deliberately". This body raises both. That trade is made with open eyes: the
 * setting is a resource throttle rather than a capability, four is still inside
 * the range the schema has always enforced (1–10), the changelog names the
 * change in plain words, and the number is already in front of the person in
 * Settings -> Advanced -> Tools, one field away from being set back.
 *
 * Additive + idempotent: only the exact value `1` moves, so a re-run changes
 * nothing and any other number — including one somebody lowered to `1` after
 * this ran — is left alone the second time.
 *
 * **This is the deliberate exception to the wipe floor** (DOR-1497,
 * `operator/config-write-policy.ts`), which otherwise says nothing may quietly
 * reverse a `PROTECTIVE_CARRYOVERS` value — this leaf is on that list. A
 * versioned, reviewed, append-only migration named in the changelog is allowed
 * to redefine a DEFAULT; the floor governs requests to change a SETTING, and it
 * is what stops an agent doing the same thing on any other day.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function raiseSchedulerConcurrencyFloor(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const scheduler = store.get('scheduler');
  if (scheduler == null || typeof scheduler !== 'object') return;
  const block = scheduler as Record<string, unknown>;
  if (block.maxConcurrentRuns !== 1) return;
  store.set('scheduler', { ...block, maxConcurrentRuns: 4 });
}

/**
 * Migration body: turn warm agents ON for an upgrade that stored them OFF (spec
 * `full-power-defaults`, D1/D2).
 *
 * `runtimes.claudeCode.persistentSession` graduated out of the experiments
 * registry and now ships `true`. The schema flip alone would reach nobody who
 * has upgraded, and for a sharper reason than usual: the `0.59.0` backfill
 * ({@link backfillClaudeCodePersistentSession}) explicitly wrote `false` into
 * every upgraded config, so the key is present and Ajv's `useDefaults` will
 * never revisit it.
 *
 * **Safety-neutral, which is why it may flip in a migration at all.** A warm
 * agent is the same executable with the same permissions and the same
 * per-dispatch boundary check, held open between messages; nothing about what it
 * may DO changes. What it spends is memory, bounded in code by the warm ceiling
 * and the idle reaper.
 *
 * **The same honest caveat as the scheduler bump above, and it bites harder
 * here:** a stored `false` is indistinguishable from a person who tried the
 * experiment and turned it off, because `false` is what shipped. This raises
 * both. The changelog says so — and says the other half too, which is that this
 * leaf did not lose its switch in the end — it moved to the Control Center
 * (`Warm agents`, #1209), which is the way back.
 *
 * Additive + idempotent: only the exact value `false` moves, so a re-run does
 * nothing and an off somebody chooses AFTER this key has run is permanent —
 * doubly so since DOR-1497, which made this leaf `operator-only`, so no agent
 * can undo that off either. Same deliberate exception as the scheduler bump
 * above: a versioned migration may redefine a default; nothing else may reverse
 * one of these values.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function warmClaudeCodeSessionsByDefault(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const current = runtimes as Record<string, unknown>;
  const claudeCode = current.claudeCode;
  if (claudeCode == null || typeof claudeCode !== 'object') return;
  const block = claudeCode as Record<string, unknown>;
  if (block.persistentSession !== false) return;
  store.set('runtimes', {
    ...current,
    claudeCode: { ...block, persistentSession: true },
  });
}

/**
 * Seed `memory` — which backend holds what your agents remember (spec
 * `agent-memory`, D7; DOR-1533).
 *
 * **This body is an anchor, and the honest thing to do is say so.** `memory` is
 * a whole TOP-LEVEL section, so conf's own pre-migration
 * `Object.assign({}, defaults, fileStore)` has already put it on the file by the
 * time this runs — on the upgrade path and the fresh-install path alike. The
 * absence guard therefore never passes and the `set` never executes. See "Which
 * of these bodies is a real no-op, and which only looks like one" in the
 * docblock above {@link CONFIG_MIGRATIONS}, and `.claude/rules/safe-defaults.md`
 * ("no test at this seam can attribute it to the body — write that down rather
 * than implying otherwise").
 *
 * It is kept anyway for one reason and not the other: it makes the intent of the
 * release reviewable in the one table that records what each version did to
 * somebody's config. It is NOT a second declaration of the default — it reads
 * {@link USER_CONFIG_DEFAULTS} rather than a literal, so it cannot drift from the
 * schema and then lose to it silently.
 *
 * Additive + idempotent: seeds only when the section is missing.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedMemoryProviderDefault(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('memory') != null) return;
  store.set('memory', USER_CONFIG_DEFAULTS.memory);
}

/**
 * Seed `rooms.repo` — whether a room may have files of its own, and the bounds
 * on them (spec `project-rooms` §3.12; DOR-1591).
 *
 * **This body is the mechanism, not an anchor.** `rooms.repo` is a nested leaf
 * inside a section every stored config already carries, and conf's
 * pre-migration `Object.assign({}, defaults, fileStore)` is SHALLOW: a stored
 * `rooms` object wins wholesale and never gains a member. Ajv's `useDefaults`
 * does fill it — but only into the copy conf's `store` getter just built and is
 * about to discard. So nothing else writes this leaf to the file, and deleting
 * this body leaves `rooms.repo` absent from disk on every upgraded install. See
 * "Which of these bodies is a real no-op, and which only looks like one" above
 * {@link CONFIG_MIGRATIONS}.
 *
 * Safety-neutral: it turns nothing on that was off. The block ships enabled,
 * but a room only gets a repo when a person gives it one, and this writes no
 * room's binding — only the defaults the enable route will be measured against.
 *
 * Additive + idempotent: the leaf is written only when absent, so a re-run after
 * corrupt recovery leaves an operator's own bounds alone. Reads
 * {@link USER_CONFIG_DEFAULTS} rather than a literal, so it cannot drift from
 * the schema.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedRoomRepoDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const rooms = store.get('rooms');
  if (rooms == null || typeof rooms !== 'object') return;
  const current = rooms as Record<string, unknown>;
  if (current.repo != null) return;
  store.set('rooms', { ...current, repo: USER_CONFIG_DEFAULTS.rooms.repo });
}

/**
 * Migration body: delete the retired `runtimes.dorkosTools` leaf (spec
 * `tool-only-room-replies` §A1, DOR-2099).
 *
 * The experiment graduated on 2026-09-19 and was removed rather than flipped:
 * every agent-bound Codex and OpenCode session carries the DorkOS tools, so
 * there is nothing left for a stored `true` or `false` to decide. This is the
 * migration half of the retired-key mechanism {@link tolerateRetiredSidebarKeys}
 * documents for `ui.sidebar`; the declaration half, which converges an install
 * this key never reaches, is {@link tolerateRetiredRuntimeKeys}.
 *
 * Idempotent, and quiet when there is nothing to do: the `set` happens only when
 * the key is really present, so a re-run after corrupt recovery writes nothing.
 *
 * Data loss on purpose, and it loses nothing that means anything: the value
 * chose between two behaviours, only one of which the code still has.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function dropRetiredDorkosTools(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const current = runtimes as Record<string, unknown>;
  if (!('dorkosTools' in current)) return;
  const { dorkosTools: _retired, ...rest } = current;
  store.set('runtimes', rest);
}

/**
 * Migration body: delete the retired `rooms.toolOnlyReplies` leaf, and seed
 * `rooms.maxPostsPerTurn` for any install that never got it (spec
 * `tool-only-room-replies` §A2, DOR-2099).
 *
 * **Two leaves, one body, because one key replaces another.** `'0.72.0'` seeded
 * both together and was REMOVED with the experiment (see the reasoning where it
 * used to sit): its helper read `USER_CONFIG_DEFAULTS.rooms.toolOnlyReplies`,
 * which no longer exists, and a shipped body may not be edited. So the surviving
 * half of its job moves here rather than being dropped — `maxPostsPerTurn` is a
 * tunable that outlived the experiment, and nothing else writes it to disk.
 *
 * **This body is the mechanism, not an anchor**, for the reason
 * {@link seedRoomRepoDefaults} states at length: both are nested leaves inside a
 * section every stored config already carries, and conf's pre-migration
 * `Object.assign({}, defaults, fileStore)` is SHALLOW — a stored `rooms` object
 * wins wholesale and never gains a member.
 *
 * The delete half is the migration half of the retired-key mechanism
 * {@link tolerateRetiredSidebarKeys} documents for `ui.sidebar`; the declaration
 * half, which converges an install this key never reaches, is
 * {@link tolerateRetiredRoomKeys}.
 *
 * Safety-neutral: `3` is what every install already behaves as, and the deleted
 * value chose between two behaviours only one of which the code still has.
 *
 * Idempotent, and quiet when there is nothing to do: the `set` happens only when
 * something really changes, so a re-run after corrupt recovery writes nothing
 * and leaves an operator's own ceiling alone. Reads {@link USER_CONFIG_DEFAULTS}
 * rather than a literal, so it cannot drift from the schema.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function retireToolOnlyReplies(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const rooms = store.get('rooms');
  if (rooms == null || typeof rooms !== 'object') return;
  const current = rooms as Record<string, unknown>;
  const { toolOnlyReplies: _retired, ...rest } = current;
  const next: Record<string, unknown> = { ...rest };
  let changed = 'toolOnlyReplies' in current;
  if (current.maxPostsPerTurn == null) {
    // @ts-expect-error -- `rooms.maxPostsPerTurn` left the schema (DOR-2739). This
    // shipped body is frozen and still names the default it seeded; that reads
    // `undefined` now, and the `'0.113.0'` key deletes the leaf either way.
    next.maxPostsPerTurn = USER_CONFIG_DEFAULTS.rooms.maxPostsPerTurn;
    changed = true;
  }
  if (!changed) return;
  store.set('rooms', next);
}

/**
 * Seed `profile.displayNameSource` — who wrote the display name that is stored
 * right now (DOR-1022).
 *
 * **This body is the mechanism, not an anchor**, for the reason
 * {@link seedRoomRepoDefaults} states: a nested leaf inside a section every
 * stored config already carries, and conf's pre-migration
 * `Object.assign({}, defaults, fileStore)` is SHALLOW — a stored `profile`
 * object wins wholesale and never gains a member. Nothing else writes this leaf,
 * so deleting this body leaves it absent on disk for every upgraded install.
 *
 * **It seeds `null`, and `null` is the honest answer rather than a placeholder.**
 * A name already stored when this field arrived could have come from either
 * hand: the person typed it in Settings, or DorkBot saved it for them mid-chat.
 * This install has no record and cannot get one. `null` is read as "no record"
 * everywhere and draws NO hint, so an upgrade is silent — which is the
 * conservative direction of the two, because labelling a name somebody has
 * answered to for months "Suggested by DorkBot" would be a confident guess in
 * exactly the case where guessing is worst.
 *
 * Absence is tested with `in` rather than `== null`, and that is load-bearing
 * here where it is cosmetic elsewhere: this leaf's DEFAULT is `null`, so a
 * `== null` guard would be true for a stored `null` too and rewrite the same
 * value on every corrupt-recovery re-run.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedDisplayNameSourceDefault(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const profile = store.get('profile');
  if (profile == null || typeof profile !== 'object') return;
  const current = profile as Record<string, unknown>;
  if ('displayNameSource' in current) return;
  store.set('profile', {
    ...current,
    displayNameSource: USER_CONFIG_DEFAULTS.profile.displayNameSource,
  });
}

/**
 * Seed `profile.identityPromptDismissedAt` — whether the one-time "what should
 * we call you?" question has been put (DOR-677).
 *
 * **The mechanism, not an anchor**, for the reason
 * {@link seedDisplayNameSourceDefault} gives: a nested leaf inside a section
 * every stored config already carries, and conf's pre-migration merge is
 * shallow, so nothing else writes it to disk for an upgraded install.
 *
 * **It seeds `null` — "never asked" — for everyone, including an install whose
 * operator already has a name and a handle.** That is honest (nobody was asked)
 * and harmless: every surface that asks also checks what is missing, so a
 * person with both never sees the question. Seeding a timestamp instead would
 * record a dismissal nobody made.
 *
 * Absence is tested with `in`, because the default is `null` and a `== null`
 * guard would rewrite a stored `null` on every corrupt-recovery re-run.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedIdentityPromptDismissedDefault(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const profile = store.get('profile');
  if (profile == null || typeof profile !== 'object') return;
  const current = profile as Record<string, unknown>;
  if ('identityPromptDismissedAt' in current) return;
  store.set('profile', {
    ...current,
    identityPromptDismissedAt: USER_CONFIG_DEFAULTS.profile.identityPromptDismissedAt,
  });
}

/**
 * Migration body: reserve `harness.refusedHooks: []` on a `harness` block that
 * predates durable refusals (DOR-1849).
 *
 * `harness` is a section most stored configs already carry (the `'0.44.0'` key
 * seeds it), and conf's pre-write merge is SHALLOW — so a stored `harness`
 * object wins wholesale and never gains a member. That makes this body the only
 * thing that puts the leaf on the file; see "Which of these bodies is a real
 * no-op" above {@link CONFIG_MIGRATIONS}.
 *
 * Seeds the list EMPTY, the mirror image of {@link backfillHarnessApprovedHooks}
 * and for the mirror reason: an upgrade must not hand out an approval nobody
 * gave, and it must not record a refusal nobody made. Everything undecided stays
 * undecided, so `dorkos harness sync --fix` withholds and asks rather than
 * assuming an answer.
 *
 * Additive and idempotent — it writes only when `refusedHooks` is not already an
 * array, so a corrupt-recovery re-run cannot erase refusals somebody made.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedHarnessRefusedHooks(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const harness = store.get('harness');
  if (harness == null || typeof harness !== 'object') return;
  const current = harness as Record<string, unknown>;
  if (Array.isArray(current.refusedHooks)) return;
  store.set('harness', { ...current, refusedHooks: [] });
}

/**
 * Migration body: reserve `harness.global` on a `harness` block that predates
 * global scope (DOR-1924).
 *
 * Same mechanism as {@link seedHarnessRefusedHooks} and load-bearing for the
 * same reason: `harness` is a section most stored configs already carry (the
 * `'0.44.0'` key seeds it), and conf's pre-write merge is SHALLOW, so a stored
 * `harness` object wins wholesale and never gains a member. Ajv's `useDefaults`
 * does fill the leaf — but only into the copy conf's `store` getter just built
 * and is about to discard, so nothing reaches the file without this. See "Which
 * of these bodies is a real no-op" above {@link CONFIG_MIGRATIONS}.
 *
 * The schema's own `.default(...)` factory covers fresh installs and every
 * in-memory parse; this covers the file of somebody who already had a `harness`
 * section. Neither covers the other.
 *
 * Seeds it CLOSED: an empty `harnesses` list means DorkOS shares nothing, and
 * `askedAt: null` means the question has never been asked. An upgrade must not
 * answer a question about writing into somebody's home directory on their
 * behalf, in either direction.
 *
 * Additive and idempotent — it writes only when `global` is not already an
 * object, so a corrupt-recovery re-run cannot forget an answer somebody gave.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedHarnessGlobal(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const harness = store.get('harness');
  if (harness == null || typeof harness !== 'object') return;
  const current = harness as Record<string, unknown>;
  if (current.global != null && typeof current.global === 'object') return;
  store.set('harness', { ...current, global: { harnesses: [], askedAt: null } });
}

/**
 * Migration body: reserve `harness.autoAdopt: false` on a `harness` block that
 * predates automatic adoption (DOR-1853).
 *
 * Same mechanism as {@link seedHarnessGlobal} and load-bearing for the same
 * reason: `harness` is a section most stored configs already carry (the
 * `'0.44.0'` key seeds it), and conf's pre-write merge is SHALLOW, so a stored
 * `harness` object wins wholesale and never gains a member. Ajv's `useDefaults`
 * does fill the leaf — but only into the copy conf's `store` getter just built
 * and is about to discard, so nothing reaches the file without this. See "Which
 * of these bodies is a real no-op" above {@link CONFIG_MIGRATIONS}.
 *
 * Seeds it OFF, which is the whole posture: an upgrade must never start moving
 * a person's own skill folders because they upgraded. Turning it on is a
 * decision somebody makes with `dorkos config set harness.autoAdopt true`, and
 * even then DorkOS acts on it only inside the agent folders it owns.
 *
 * Additive and idempotent — it writes only when `autoAdopt` is not already a
 * boolean, so a corrupt-recovery re-run cannot switch off something somebody
 * turned on.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedHarnessAutoAdopt(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const harness = store.get('harness');
  if (harness == null || typeof harness !== 'object') return;
  const current = harness as Record<string, unknown>;
  if (typeof current.autoAdopt === 'boolean') return;
  store.set('harness', { ...current, autoAdopt: false });
}

/**
 * Migration body: seed `rooms.maxCanvasOpsPerTurn` on a `rooms` block that
 * predates the room canvas (spec `room-canvas`, DOR-1999).
 *
 * Same mechanism as {@link seedToolOnlyReplyDefaults} and load-bearing for the
 * same reason: `rooms` is a section every stored config already carries, and
 * conf's pre-write merge is SHALLOW, so a stored `rooms` object wins wholesale
 * and never gains a member. Ajv's `useDefaults` does fill the leaf — but only
 * into the copy conf's `store` getter just built and is about to discard, so
 * nothing reaches the file without this body.
 *
 * Safety-neutral: `3` is a ceiling on something no install could do before this
 * shipped, so a bound that refuses a fourth canvas change inside one turn
 * refuses nothing that used to happen.
 *
 * Additive and idempotent — it writes only when the leaf is absent, so a
 * corrupt-recovery re-run leaves a number somebody chose exactly where it is.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedRoomCanvasOps(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const rooms = store.get('rooms');
  if (rooms == null || typeof rooms !== 'object') return;
  const current = rooms as Record<string, unknown>;
  if (current.maxCanvasOpsPerTurn != null) return;
  store.set('rooms', {
    ...current,
    // @ts-expect-error -- `rooms.maxCanvasOpsPerTurn` left the schema (DOR-2739).
    // Same frozen-body note as `retireToolOnlyReplies`: `'0.113.0'` deletes it.
    maxCanvasOpsPerTurn: USER_CONFIG_DEFAULTS.rooms.maxCanvasOpsPerTurn,
  });
}

/**
 * Migration body: seed `rooms.maxConcurrentTurnsPerAgent` on a `rooms` block
 * that predates the setting (DOR-2104).
 *
 * Load-bearing for the same reason as {@link seedRoomCanvasOps}: `rooms` is a
 * section every stored config already carries, and conf's pre-write merge is
 * SHALLOW, so a stored `rooms` object never gains a member without this body.
 *
 * **Not safety-neutral, and deliberately so.** Before this setting existed the
 * ceiling was a hard-coded one turn per agent folder; seeding `3` lets an
 * upgraded install run up to three at once, which is the default the issue
 * chose for everybody (DOR-500's damage curve was measured at six writers on
 * one tree). Anyone who wants the old behaviour sets it to `1` in Settings.
 * There is no earlier value a person could have chosen, so there is nothing
 * here to overwrite.
 *
 * Additive and idempotent — it writes only when the leaf is absent, so a
 * corrupt-recovery re-run leaves a number somebody chose exactly where it is.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedMaxConcurrentTurnsPerAgent(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const rooms = store.get('rooms');
  if (rooms == null || typeof rooms !== 'object') return;
  const current = rooms as Record<string, unknown>;
  if (current.maxConcurrentTurnsPerAgent != null) return;
  store.set('rooms', {
    ...current,
    maxConcurrentTurnsPerAgent: USER_CONFIG_DEFAULTS.rooms.maxConcurrentTurnsPerAgent,
  });
}

/**
 * The `conf` migration chain, keyed by the app version each entry ships in.
 *
 * ## Where a new migration goes
 *
 * Under a NEW key strictly greater than the newest `v*` tag in the repository
 * (`git tag -l 'v*' | sort -V | tail -1`). Nothing else is safe, for one reason:
 * `conf` runs a key only when `storedVersion < key <= projectVersion`. So a key
 * at or below a version that already shipped is skipped for everybody already on
 * it — no error, no warning, the backfill simply never happens (DOR-339).
 *
 * Three things follow, and all three have been got wrong here before:
 *
 * - **Never append to a key that has shipped.** The key being present is not the
 *   point; the BODY is what runs. Appending to an already-tagged composite key
 *   ships dead code that looks alive (DOR-988).
 * - **Never edit a shipped migration body.** Everyone who upgraded past it ran
 *   the old body, and no re-run is coming. Write a new, idempotent entry that
 *   corrects the state instead.
 * - **A body is frozen from the moment it MERGES, not from the moment it is
 *   tagged.** This one reads like a technicality and is not (DOR-1222). See
 *   below.
 *
 * ## "It is not released yet" is not a licence to edit
 *
 * The table used to carry the opposite rule: a key above the newest tag had run
 * for nobody, so its body could be amended freely. That was false, and it was
 * false on the machine of the person who wrote it. `projectVersion` is
 * `SERVER_VERSION` (`lib/version.ts`), which is the version compiled into a
 * built CLI bundle or the desktop app — and that version is bumped in the
 * repository BEFORE the tag exists. Only a raw dev tree is exempt, because
 * `apps/server/package.json` reads `0.0.0`. So anybody who builds and runs
 * during the merge-to-release window is stamped with the new version, has run
 * whatever the body said that day, and will never run the key again.
 *
 * `'0.59.0'` is the worked example. It was amended in place twice while
 * "unreleased" — `welcomeBack.offersEnabled` OFF to ON, then the composer prefs
 * seed — and the operator's own config had been stamped `0.59.0` on 2026-08-12
 * before either landed. Both amendments skipped him in silence. A change of mind
 * about a merged body opens a NEW key above the newest tag, written so it can
 * tell a value this body seeded from one a person chose.
 *
 * ## Both rules are enforced, and they are enforced differently
 *
 * - `__tests__/migration-safety.ts` compares a shipped key against the newest
 *   release TAG. Its TABLE SLICE must be byte-identical, and byte-identity is
 *   deliberate there: a rule that skipped comments would need a parser deciding
 *   which lines are code, and "an appended line the parser mis-read as a
 *   comment" is the same class of hole it exists to close. The consequence is
 *   that a stale sentence inside a shipped body cannot be corrected in place —
 *   `'0.57.0'` still carries one, pointing at the composition convention this
 *   docblock replaced. Correct that kind of thing HERE, or in the comment
 *   directly above a key (both sit outside every key's slice), not inside the
 *   body. It then follows the key into the code it CALLS and compares that too
 *   (DOR-1135), because most of this table is a composite and comparing the
 *   slice alone was comparing the call rather than what runs: a tamper seeded
 *   into `backfillAutonomyAcknowledgement`, which `'0.57.0'` calls, used to pass
 *   while the identical tamper written inline went red. Helpers are compared
 *   normalized, not byte for byte, so a helper's own prose stays correctable.
 * - `__tests__/migration-append-only.ts` pins a hash per merged key against
 *   `__tests__/merged-migration-hashes.ts`. It covers the same CLOSURE — the
 *   table slice plus every top-level function AND constant in this file the key
 *   reaches, including a list like `RETIRED_SIDEBAR_KEYS` that decides what a
 *   helper does — and it needs no tag, which is what lets it hold inside the
 *   window where no tag exists yet. Both rules read the file through
 *   `__tests__/migration-closure.ts`, and they differ in what they answer to: a
 *   pin is a value in this repository and repinning it is the escape hatch,
 *   while a tag cannot be edited at all.
 *
 * `config-manager.test.ts` runs both over the real repository on every CI run.
 *
 * ## Which of these bodies is a real no-op, and which only looks like one
 *
 * Several bodies below describe themselves as "no-op anchors": the claim is that
 * conf's own defaults would produce the same config, so the body exists to keep
 * the intent reviewable rather than to make the value reachable. That claim is
 * true for exactly one of the two shapes, and the difference is not the one the
 * older comments in this file assumed. Both halves are measured
 * (`config-manager.test.ts`, and the per-migration files beside it), not
 * reasoned from conf's documentation.
 *
 * - **A whole TOP-LEVEL section** (`a2a`, `notifications`, `profile`,
 *   `approvals`) really is covered. Before it runs a single key, conf's
 *   `#runMigrations` builds `Object.assign({}, defaults, fileStore)` and WRITES
 *   it when it differs from the file, so a section the file has never heard of
 *   arrives on disk whatever the table says. Delete such a body and nothing
 *   about the resulting file changes.
 *
 *   Sharper than "redundant", and worth stating because it has a consequence:
 *   such a body is **unreachable**. It guards on absence (`if (store.get('x') ==
 *   null)`), and by the time it runs, the pre-write has already put the section
 *   on the file it is about to read — on the upgrade path and the fresh-install
 *   path alike. The `set` never executes; measured by handing the body a probe
 *   store after a real boot and watching `set` go uncalled. So the value written
 *   in the table is not the value that reaches anybody: if it ever diverged from
 *   the object literal in `USER_CONFIG_DEFAULTS`, the file would silently take
 *   the literal and this table would document an intent that never ran. That is
 *   the defaults-declared-twice trap wearing a migration for a disguise — the
 *   per-field Zod default and the object literal are already two declarations,
 *   and an anchor body is a third that cannot win.
 * - **A nested leaf inside a section the file already has** (`ui.composer`,
 *   `ui.promos`, `runtimes.claudeCode.persistentSession`) is NOT covered, and a
 *   body that seeds one is the only thing that writes it. The merge above is
 *   shallow, so a stored `ui` object wins wholesale and never gains a new
 *   member. Ajv's `useDefaults` does fill the leaf in — but only into the object
 *   `conf`'s `store` GETTER just built: that getter re-reads and re-parses the
 *   file on every access, validates the copy it is about to hand back, and
 *   throws the copy away. A boot that only READS leaves the file sparse. (A
 *   later `set` of any kind does persist the fill, because `Conf.set` assigns
 *   the validated object straight back — see "`config.json` holds the effective
 *   config" in `contributing/configuration.md`. That is a different event from
 *   the upgrade this table is responsible for.)
 *
 * The consequence for tests is sharp enough to state here, because it is what
 * the DOR-1496 audit found: reading such a leaf back through
 * `configManager.get`/`getDot` proves NOTHING about a migration, since the fill
 * happens on the way out. One whole upgrade-boot suite (`ui.composer`) and two
 * further cases (`rooms`' two added leaves, and the `ui.statusBar` composition
 * check inside the approvals full-conf-path test) stayed green with their
 * bodies suppressed, and `ui.promos` had no on-disk case at all. An upgrade-boot
 * test for a nested seed has to read `config.json` itself.
 */
/** Persist the owner-qualified Community navigation block in an existing `ui` section. */
export function seedCommunityNavigationPrefs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return;
  if ('communityNavigation' in ui) return;
  store.set('ui', {
    ...(ui as Record<string, unknown>),
    communityNavigation: { version: 1, owners: [] },
  });
}

/**
 * Carry the first-run power choice into the permission preset (spec
 * `agent-permissions` D13, phase 1): `ui.fullPowerChoice: 'full'` becomes
 * `permissions.preset: 'full'`, `'supervised'` becomes `'careful'`, and an
 * unanswered door leaves the preset `null` (Unchanged, today's behaviour).
 *
 * `permissions` is a new TOP-LEVEL section, so conf's shallow pre-migration
 * defaults merge has already written it by the time this runs: there is no
 * absence case to guard. It never replaces a preset that is already set, so a
 * re-run, or a door answered through the permission routes first, is left
 * alone. It does not touch any trust stop; that coupling is later work.
 *
 * Runs before the Activity service exists, so it records nothing; the boot-time
 * permission upgrade sweep writes the audit event for its effect.
 *
 * @param store - The conf migration store.
 */
export function seedPermissionPresetFromDoor(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return;
  const choice = (ui as Record<string, unknown>).fullPowerChoice;
  const preset = choice === 'full' ? 'full' : choice === 'supervised' ? 'careful' : null;
  if (preset === null) return;
  const stored = store.get('permissions');
  const section =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : { preset: null, defaults: { areas: {}, actions: {} }, upgradeSweptVersion: null };
  if (section.preset !== null && section.preset !== undefined) return;
  store.set('permissions', { ...section, preset });
}

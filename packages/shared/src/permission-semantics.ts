/**
 * What a permission mode means, computed from what the runtime said it does.
 *
 * ## The table this replaces
 *
 * Every surface that warned about a permission mode used to answer from a list
 * of mode ids kept in the client — one list for "this is a bypass mode", another
 * for "tint this red". A list like that is right until a runtime ships a mode
 * nobody added to it, and then it is quietly, invisibly wrong: the status line
 * warns, the banner does not, and neither is checkable from the runtime's own
 * behavior.
 *
 * So the runtime declares its semantics on every mode it offers
 * (`PermissionModeDescriptor.stop` / `asks` / `reach` / `promise`), and these
 * functions are the only rules the client applies to them. No runtime names, no
 * mode-id membership — a new runtime is described correctly the day it declares
 * itself, without a client release (spec `trust-dial`, decision 2).
 *
 * Pure and descriptor-shaped on purpose: no hooks, no queries. The caller
 * resolves the descriptor from the runtime's capability profile and passes it
 * in, which is what lets one rule serve the status line, the banner, the scope
 * note, and the session rail.
 *
 * ## Why `shared` and not `apps/client`
 *
 * The rules are the client's to apply, but they are only *true* if they agree
 * with what the runtimes actually declare — and no test inside `apps/client` can
 * import a runtime's capability profile to check. Parking the rules here lets
 * the server's own test run every declared mode of every runtime through the
 * real functions instead of a restatement of them
 * (`apps/server/src/services/runtimes/__tests__/permission-semantics.test.ts`).
 * The client re-exports them from `layers/shared/lib`, so client code has one
 * import path as before.
 *
 * @module shared/permission-semantics
 */
import type {
  PermissionAsks,
  PermissionModeDescriptor,
  PermissionReach,
  PermissionStop,
  TurnPermissionBound,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from './agent-runtime.js';

/**
 * The dial's three positions, in the order a person reads them.
 *
 * Exported because a stop is now a value some surfaces have to enumerate rather
 * than merely read off a descriptor — Settings offers all three as a choice, and
 * the config schema stores one — and a second hand-written list would be the
 * exact id-table failure this module exists to end.
 */
export const PERMISSION_STOPS: readonly PermissionStop[] = ['ask', 'act', 'autonomy'];

/**
 * What each dial position promises about asking, before any runtime speaks.
 * The canonical expectation — a runtime that cannot meet it is not corrected,
 * it is reported ({@link isDivergent}).
 */
const STOP_EXPECTATION: Record<PermissionStop, PermissionAsks> = {
  ask: 'always',
  act: 'when-risky',
  autonomy: 'never',
};

/**
 * The asking behavior a dial position promises. The stop words are fixed across
 * runtimes, so this is the sentence a person is entitled to expect from the
 * position they picked, whichever agent is behind it.
 *
 * @param stop - A dial position.
 */
export function stopExpectation(stop: PermissionStop): PermissionAsks {
  return STOP_EXPECTATION[stop];
}

/**
 * How much asking each value represents, so two can be compared. Asking more
 * often is never the surprise a caption has to warn about; asking less is.
 */
const ASKS_RANK: Record<PermissionAsks, number> = {
  always: 2,
  'when-risky': 1,
  never: 0,
};

/**
 * How far each value lets an action travel, so two can be compared. Ordered as
 * {@link PermissionReach} documents them: least to most.
 */
const REACH_RANK: Record<PermissionReach, number> = {
  read: 0,
  edit: 1,
  workspace: 2,
  everything: 3,
};

/**
 * Whether moving from one mode to another TIGHTENS the leash — the agent must
 * ask more often, or may reach less far, than it could a moment ago.
 *
 * The direction is the whole point, because the two directions have different
 * consequences when a live mode change cannot be delivered to a turn already
 * running (DOR-1435). A loosening that never lands costs a person some extra
 * approval prompts for the rest of one turn, and fixes itself on the next. A
 * TIGHTENING that never lands leaves the agent running with the permissions the
 * person just took away — and under a mode that never asks, DorkOS cannot put
 * the prompts back mid-turn, because the CLI skips its approval callback
 * entirely. So a tightening that goes unconfirmed is a fact the product has to
 * say out loud; a loosening is not.
 *
 * Either half counts on its own. Asking more often is the obvious one
 * (`bypassPermissions` → `default`); reaching less far is the quieter one
 * (`default` → `plan`, where the turn keeps editing files a person has just
 * confined to reading).
 *
 * @param from - The mode the session was on.
 * @param to - The mode the person just chose.
 */
export function isTightening(
  from: PermissionModeDescriptor,
  to: PermissionModeDescriptor
): boolean {
  return ASKS_RANK[to.asks] > ASKS_RANK[from.asks] || REACH_RANK[to.reach] < REACH_RANK[from.reach];
}

/**
 * Whether `candidate` is NOT ABOVE `ceiling` — it asks at least as often, and
 * reaches no further. Identity is not above.
 *
 * The rule a chat starting another chat is held to (spec
 * `inherited-start-permission`, ADR "a started chat inherits its starter's live
 * permission level as a ceiling"): the new chat may run at the starter's own
 * level or lower, never higher. Descriptors, never ids, so it holds across
 * runtimes — Claude's `acceptEdits` and Codex's `acceptEdits` share an id and
 * not a level.
 *
 * Both halves must hold, the same two ranks {@link isTightening} reads. One
 * deliberate exception, the one {@link isDivergent} and
 * {@link actsWithoutAsking} already make: a mode that can only READ is judged
 * on reach alone. It never asks because it has nothing to ask about — Codex's
 * read-only sandbox declares `asks: 'never'` for exactly that reason — and
 * ranking that as "asks less than Accept edits" would put the safest mode on
 * offer above every ceiling but Full autonomy.
 *
 * @param ceiling - The level that may not be exceeded.
 * @param candidate - The level being asked for.
 */
export function isNoLooserThan(
  ceiling: Pick<PermissionModeDescriptor, 'asks' | 'reach'>,
  candidate: Pick<PermissionModeDescriptor, 'asks' | 'reach'>
): boolean {
  if (REACH_RANK[candidate.reach] > REACH_RANK[ceiling.reach]) return false;
  if (candidate.reach === 'read') return true;
  return ASKS_RANK[candidate.asks] >= ASKS_RANK[ceiling.asks];
}

/**
 * {@link isTightening}, asked about two mode IDS against the modes a runtime
 * declares — the form every adapter actually needs, because what a session
 * stores is an id and what the rule reads is a descriptor.
 *
 * **An id the runtime does not declare answers `true`.** This decides whether
 * the product ADMITS a change may not have reached the running turn, so "cannot
 * tell" has to read as "say so". The other default would let a mode nobody
 * described take the confident answer, and the `from` side is genuinely
 * reachable: a session persisted in a mode the runtime has since stopped
 * declaring still loads and runs (`PATCH /api/sessions/:id` gates the `to` side
 * only). The decision also needs to stay safe for direct runtime callers.
 *
 * @param declared - Every mode the runtime declares, in any order.
 * @param from - The mode the running turn started under.
 * @param to - The mode the person just chose.
 */
export function tightensDeclaredMode(
  declared: readonly PermissionModeDescriptor[],
  from: string,
  to: string
): boolean {
  const before = declared.find((mode) => mode.id === from);
  const after = declared.find((mode) => mode.id === to);
  if (!before || !after) return true;
  return isTightening(before, after);
}

/**
 * Whether this runtime's mode asks LESS than its dial position promises —
 * Codex's workspace-write sitting at "act, ask when risky" while never asking at
 * all, because Codex has no way to pause mid-turn.
 *
 * Divergence is a fact to SAY, not a thing to hide: the stop words stay fixed
 * and the caption carries the difference (spec `trust-dial`, decision 2A).
 *
 * Two deliberate narrowings, both of which exist so the caption's emphasis lands
 * only where a person could actually be caught out:
 *
 * 1. **Directional.** Only asking less than promised counts. A runtime that
 *    stops more often than its position pledged has over-delivered on safety,
 *    and flagging that would teach people the flag means "unusual" rather than
 *    "this will do more than you agreed to".
 * 2. **A mode that cannot act cannot break an asking promise.** Codex's
 *    read-only default technically never asks — because it has nothing to ask
 *    about; it cannot write a file, run a command, or reach the network. Plain
 *    inequality marks the safest setting on offer as promise-breaking, which
 *    would put the caption's amber on it. So `reach: 'read'` is excluded.
 *
 * The pairing that matters is pinned in the server's cross-runtime test: Codex's
 * `workspace-write` diverges, Codex's read-only default does not.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isDivergent(descriptor: PermissionModeDescriptor): boolean {
  if (descriptor.reach === 'read') return false;
  return ASKS_RANK[descriptor.asks] < ASKS_RANK[stopExpectation(descriptor.stop)];
}

/**
 * Whether a mode hands the agent the keys — runs any tool, anywhere, without
 * asking. The semantic replacement for the old id list, and the authoritative
 * answer wherever the runtime's profile is in hand: the standing banner, the
 * status line's severity, and the scope note beside every mode picker must all
 * agree, or one session warns on one surface and looks ordinary on another
 * (DOR-482, DOR-463, DOR-501).
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isBypassSemantics(descriptor: PermissionModeDescriptor): boolean {
  return descriptor.asks === 'never' && descriptor.reach === 'everything';
}

/**
 * Whether a mode sits at the dial's Full-autonomy stop — the one position a
 * person is asked to confirm before they can take it (spec `trust-dial`,
 * decision 5).
 *
 * The declared position, never the id. `bypassPermissions` is Claude's name for
 * this stop and Codex's is `danger-full-access`; a door that opened on a string
 * would stand wide open for the next runtime to declare a third spelling.
 *
 * Distinct from {@link isBypassSemantics} on purpose, and they can disagree.
 * That one asks what a mode DOES (never asks, reaches everything) and drives how
 * loudly a surface marks it. This one asks where a mode SITS on the dial, and
 * drives what the person is asked before selecting it. A runtime whose autonomy
 * stop is sandboxed still gets the door, because the door is about the position
 * a person is choosing, not about how far the blast reaches.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isAutonomyStop(descriptor: PermissionModeDescriptor): boolean {
  return descriptor.stop === 'autonomy';
}

/**
 * Whether this mode acts without ever stopping to ask: the autonomy stop,
 * whatever it can reach, or any mode that never asks and can do more than read.
 *
 * True for two shapes, and they are one question asked twice:
 *
 * 1. **The autonomy stop**, whatever it can reach.
 * 2. **Any mode that never asks and can do more than read**, wherever its
 *    runtime filed it. Codex's middle stop is the live case: `workspace-write`
 *    sits at "act, ask when risky" and runs shell commands with no way to pause.
 *
 * `reach: 'read'` is excluded for the reason {@link isDivergent} excludes it: a
 * mode that can only read never asks because it has nothing to ask about.
 *
 * It once decided which mode changes needed a consent ritual first; that
 * ritual is retired (ADR 261006-225605: full power is the default, and the
 * audit trail is the record). What still reads it: the rule that no runtime is
 * BORN at such a mode (`runtimeConformance`), the "Always allow" card that may
 * not adopt one for a whole session, `session_start`'s rule that such a level
 * is named rather than inherited, and the scope notes that say what such a mode
 * covers.
 *
 * {@link isBypassSemantics} is this same shape narrowed to `reach:
 * 'everything'`, a strict subset of clause 2; it drives a different question
 * and is not composed from this one.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function actsWithoutAsking(descriptor: PermissionModeDescriptor): boolean {
  if (isAutonomyStop(descriptor)) return true;
  return descriptor.asks === 'never' && descriptor.reach !== 'read';
}

/**
 * Whether a mode can neither change anything nor ask to — the dead end
 * (DOR-2019).
 *
 * A mode that only reads is not itself a problem; Claude's `plan` reads too. The
 * problem is reading with no approval channel behind it. Ask such a session to
 * edit a file and there is no card to answer and no prompt to allow: the request
 * is refused by the sandbox and the agent says it cannot, which reads like the
 * agent being broken rather than like the setting the person chose. Codex's
 * read-only sandbox is the live case, and every runtime without an approval
 * channel lands here the same way.
 *
 * Declared semantics only, never a runtime name or a mode id — a runtime that
 * gains an approval channel stops matching on the day it declares `asks` as
 * anything but `never`, with no edit here.
 *
 * The mirror of {@link actsWithoutAsking}'s `reach: 'read'` exclusion: that one
 * leaves this shape alone because it is the safest thing on offer, and this one
 * exists because being safe is not the same as being understood.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isSilentReadOnly(descriptor: PermissionModeDescriptor): boolean {
  return descriptor.reach === 'read' && descriptor.asks === 'never';
}

/**
 * Whether a mode is a way of WORKING rather than a level of trust — off the
 * dial, offered beside the composer instead (spec `trust-dial`, decision 1).
 *
 * Reads the runtime's declaration, never the mode's id: `plan` is Claude's name
 * for it, and the next runtime's will be something else.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isWorkingMode(descriptor: PermissionModeDescriptor): boolean {
  return descriptor.axis === 'working';
}

/** One position on the Trust Dial, resolved against a runtime's declared modes. */
export interface TrustStop {
  /** The dial position. */
  stop: PermissionStop;
  /** The mode selecting this position selects. */
  mode: PermissionModeDescriptor;
  /**
   * Further modes the runtime declares at the same position — settings INSIDE
   * the stop rather than stops of their own. Claude's `auto` is the only one
   * today: it sits where "act" sits and changes how the agent decides, not how
   * far the person has let it go.
   */
  refinements: PermissionModeDescriptor[];
}

/**
 * Turn a runtime's declared modes into the dial it can offer.
 *
 * Three rules, all uniform — no mode ids, no runtime names, so a runtime the
 * client has never heard of gets a correct dial the day it declares itself:
 *
 * 1. **Ways of working are not stops.** They come off the dial entirely.
 * 2. **A stop with no mode is absent, not disabled.** A dial that offers a
 *    position this runtime cannot take is a promise the product cannot keep, and
 *    greying it out just makes the person click it to find out why.
 * 3. **First declared wins the stop; the rest are refinements.** Where a runtime
 *    declares two modes at one position, its own ordering says which one the
 *    position means — Claude lists `acceptEdits` before `auto`, so picking "Act"
 *    picks `acceptEdits` and `auto` becomes a switch inside it.
 *
 * @param descriptors - Every mode the runtime declares, in its declared order.
 */
export function resolveTrustStops(descriptors: readonly PermissionModeDescriptor[]): TrustStop[] {
  const trust = descriptors.filter((d) => !isWorkingMode(d));
  return PERMISSION_STOPS.flatMap((stop) => {
    const [mode, ...refinements] = trust.filter((d) => d.stop === stop);
    return mode ? [{ stop, mode, refinements }] : [];
  });
}

/**
 * The mode id one runtime calls a given dial position.
 *
 * The single translation from a CONFIGURED stop (`'ask' | 'act' | 'autonomy'`,
 * which is what `runtimes.defaultTrustStop` and its per-runtime override
 * store) into an id that runtime actually declares. It reads
 * {@link resolveTrustStops}, so it lands on exactly the mode the dial would
 * show as selected — including the first-declared rule where a runtime files
 * two modes at one position.
 *
 * **It lives here because two sides have to agree about it.** The server
 * resolves the stop when it seeds a new session's row
 * (`resolve-session-defaults.ts`), and the client resolves the same stop to
 * say what a session with no row yet WOULD run at (`useSessionStartMode` in
 * `entities/session`) — the display half of the same question (DOR-2103). Two
 * copies of this mapping is how the dial and the seed come to disagree about
 * which mode a position means.
 *
 * `undefined` — "no preference, the runtime decides" — for three inputs that
 * are the same input: no stop configured, no descriptors in hand, or a runtime
 * that declares no mode at that stop. A stop a runtime cannot take is not an
 * error and not a near-miss to round off.
 *
 * @param stop - The configured dial position, or nullish for none.
 * @param descriptors - The runtime's declared modes, in declared order, or
 *   undefined when the caller has no profile yet.
 */
export function resolveStopMode(
  stop: PermissionStop | null | undefined,
  descriptors: readonly PermissionModeDescriptor[] | undefined
): string | undefined {
  if (!stop || !descriptors) return undefined;
  return resolveTrustStops(descriptors).find((s) => s.stop === stop)?.mode.id;
}

/**
 * The permission-mode declaration {@link startModeFor} reads — one runtime's
 * declared modes plus the one it falls back to.
 *
 * Structurally a `RuntimeCapabilities['permissionModes']`, narrowed to the two
 * keys this answer needs so a caller holding only a declaration (a test, a
 * capability projection) does not have to build a whole profile.
 */
export interface DeclaredPermissionModes {
  /** Every mode the runtime declares, in its declared order. */
  values: readonly PermissionModeDescriptor[];
  /** The mode it runs when a session has no stored preference (a NULL column). */
  default?: string;
}

/**
 * What a session with NOTHING stored for it will run its first turn at, on one
 * runtime, under one configured stop.
 *
 * {@link resolveStopMode} plus the one translation of its `undefined`: a stop
 * the runtime cannot take seeds no column, a NULL column means "the runtime
 * decides", and what it decides is the mode it declares as its default. Those
 * two steps are ONE answer and they live here rather than at each caller,
 * because a caller that composed them itself would be a second copy of the
 * answer the other side is checked against.
 *
 * Both sides of DOR-2103 call this: the client's `useSessionStartMode` renders
 * it, and `configured-stop-on-screen.test.ts` compares it against what
 * `resolveSessionDefaults` actually seeds, for every shipped profile and every
 * configurable stop. That comparison is only worth anything while the test and
 * the screen run the SAME function — which is why hand-composing the two steps
 * anywhere is a defect, not a style choice.
 *
 * `undefined` means the runtime declares no default either, so there is still
 * nothing honest to show.
 *
 * @param stop - The operator's configured dial position for this runtime, or
 *   nullish when they never set one.
 * @param modes - The runtime's own permission-mode declaration, or undefined
 *   before its profile has loaded.
 */
export function startModeFor(
  stop: PermissionStop | null | undefined,
  modes: DeclaredPermissionModes | undefined
): string | undefined {
  if (!modes) return undefined;
  return resolveStopMode(stop, modes.values) ?? modes.default;
}

/**
 * The way of working a runtime offers, if it offers one — the mode behind the
 * composer's Plan toggle.
 *
 * Answers with the first declared, because a runtime offering two ways of
 * working is not a shape anything renders yet; when one does, this is where that
 * decision belongs rather than in the component that draws the chip.
 *
 * @param descriptors - Every mode the runtime declares, in its declared order.
 */
export function findWorkingMode(
  descriptors: readonly PermissionModeDescriptor[]
): PermissionModeDescriptor | undefined {
  return descriptors.find(isWorkingMode);
}

/**
 * Whether a posture runs an agent with nobody left to ask.
 *
 * The rule the unattended-autonomy banner is built on, and the reason it is a
 * function rather than two calls at the call site: {@link isAutonomyStop} and
 * {@link isBypassSemantics} answer different questions and are allowed to
 * disagree, and on a surface nobody is watching BOTH answers are disqualifying.
 *
 * - The autonomy stop is the position a person deliberately took, behind the
 *   unattended door. Report it even if a future runtime sandboxes it — what was
 *   consented to is what should be visible.
 * - Bypass semantics is what a mode DOES. A mode that never asks and reaches
 *   everything belongs in this report whatever position its runtime filed it
 *   under; Codex's `workspace-write` is the live reminder that a runtime can put
 *   "never asks" at the middle stop.
 *
 * @param descriptor - A mode as its runtime declared it.
 */
export function isUnattendedAutonomy(descriptor: PermissionModeDescriptor): boolean {
  return isAutonomyStop(descriptor) || isBypassSemantics(descriptor);
}

/** Which kind of driver starts an agent turn with nobody in front of it. */
export type UnattendedDriverKind = 'binding' | 'task';

/**
 * One live driver that runs an agent without asking, on a surface nobody is
 * watching. Deliberately three small fields: enough to name the thing on a
 * banner and send a person to it, and nothing that would make this aggregate
 * expensive to compute or interesting to leak.
 *
 * There is no mode name here on purpose. The obvious fourth field is the
 * runtime's own word for the mode ("Bypass permissions"), and it was carried
 * for a while before anything rendered it. Two reasons it is gone: nothing on
 * screen needs it, and it is the WRONG vocabulary — the product speaks in the
 * dial's three stops, so a payload offering a runtime's private spelling only
 * invites a surface to print it. If a detail view ever wants one, it should
 * take the stop, not the label.
 */
export interface UnattendedAutonomyDriver {
  /** Which surface owns it — decides the word the banner uses and where it links. */
  kind: UnattendedDriverKind;
  /** The driver's own id (binding uuid, task ULID). */
  id: string;
  /** What to call it on screen. Never empty — the server resolves a fallback. */
  name: string;
}

/**
 * Every unattended surface currently set to run without asking.
 *
 * The whole answer, not a page of it: the count that matters is small by
 * construction (a person has to have walked through the unattended-autonomy
 * door for each one), and a banner that could only say "some" would be the kind
 * of alarm people learn to ignore.
 */
export interface UnattendedAutonomyState {
  /** The live drivers, bindings first, each in its store's own order. */
  drivers: UnattendedAutonomyDriver[];
}

/** Claude Code's Auto mode id: see `TurnPermissionLevel.auto`. */
const AUTO_MODE_ID = 'auto';

/**
 * The level that can only read and always asks: what a ceiling resolves to
 * when nothing better is known, so a broken lookup can only make a turn
 * stricter.
 */
export const READ_ONLY_LEVEL: TurnPermissionLevel = { asks: 'always', reach: 'read' };

/** The modes a runtime declares, as `RuntimeCapabilities.permissionModes` carries them. */
export interface DeclaredModes {
  /** Every mode the runtime declares. */
  readonly values: readonly PermissionModeDescriptor[];
  /** The id the runtime starts in when nobody chose one. */
  readonly default?: string;
}

/**
 * A declared mode as a {@link TurnPermissionLevel}, or `undefined` for an id the
 * runtime does not declare.
 *
 * @param declared - The runtime's declared modes.
 * @param modeId - A mode id on that runtime.
 */
export function levelOfMode(
  declared: DeclaredModes,
  modeId: string | null | undefined
): TurnPermissionLevel | undefined {
  if (!modeId) return undefined;
  const mode = declared.values.find((m) => m.id === modeId);
  if (!mode) return undefined;
  return mode.id === AUTO_MODE_ID
    ? { asks: mode.asks, reach: mode.reach, auto: true }
    : { asks: mode.asks, reach: mode.reach };
}

/**
 * A ceiling as a concrete level on one runtime: `'runtime-default'` becomes the
 * level of the runtime's own default mode, and {@link READ_ONLY_LEVEL} when the
 * runtime declares none.
 *
 * @param declared - The receiving runtime's declared modes.
 * @param ceiling - The ceiling a caller sent.
 */
export function resolveCeilingLevel(
  declared: DeclaredModes,
  ceiling: TurnPermissionCeiling
): TurnPermissionLevel {
  if (Array.isArray(ceiling)) {
    const bounds = ceiling as readonly TurnPermissionBound[];
    if (bounds.length === 0) return READ_ONLY_LEVEL;
    return bounds.map((bound) => resolveCeilingLevel(declared, bound)).reduce(stricterLevel);
  }
  if (ceiling !== 'runtime-default') return ceiling as TurnPermissionLevel;
  return levelOfMode(declared, declared.default) ?? READ_ONLY_LEVEL;
}

/**
 * Whether a level admits a mode: {@link isNoLooserThan}, plus the Auto rule:
 * Auto fits only under a level that is itself Auto or never asks.
 */
function admits(level: TurnPermissionLevel, mode: PermissionModeDescriptor): boolean {
  if (!isNoLooserThan(level, mode)) return false;
  return mode.id !== AUTO_MODE_ID || level.auto === true || level.asks === 'never';
}

/**
 * The stricter of two levels: one that is no looser than either. When one
 * bounds the other it is returned as is; when neither does (one asks less, the
 * other reaches further — Codex's read-only default against Claude's Default),
 * the two are combined: the more frequent asking and the shorter reach, and
 * Auto only when both are Auto.
 *
 * @param a - One level.
 * @param b - The other.
 */
export function stricterLevel(a: TurnPermissionLevel, b: TurnPermissionLevel): TurnPermissionLevel {
  const fits = (inner: TurnPermissionLevel, outer: TurnPermissionLevel) =>
    isNoLooserThan(outer, inner) && (!inner.auto || outer.auto === true || outer.asks === 'never');
  if (fits(a, b)) return a;
  if (fits(b, a)) return b;
  const asks = ASKS_RANK[a.asks] >= ASKS_RANK[b.asks] ? a.asks : b.asks;
  const reach = REACH_RANK[a.reach] <= REACH_RANK[b.reach] ? a.reach : b.reach;
  return a.auto && b.auto ? { asks, reach, auto: true } : { asks, reach };
}

/**
 * The mode a turn runs at under a ceiling (spec `trusted-by-default-flip` §4):
 * the session's own mode when the ceiling admits it; otherwise the loosest
 * trust-axis mode the ceiling admits (reaching furthest, then asking least), so
 * a turn another agent's post started runs at that agent's level rather than
 * below it; otherwise a working-axis mode it admits; otherwise the strictest
 * mode the runtime declares.
 *
 * Never writes anything: the caller runs one turn at the answer and leaves the
 * session's stored mode alone. An id the runtime does not declare never fits,
 * because nothing can say how far it reaches. A working-axis mode (Claude's
 * Plan) is kept when the session is in it and never chosen in its place.
 *
 * @param declared - The receiving runtime's declared modes.
 * @param modeId - The mode the session is set to.
 * @param ceiling - The loosest level this turn may run at.
 * @returns The mode id the turn runs at.
 */
export function clampModeToCeiling(
  declared: DeclaredModes,
  modeId: string,
  ceiling: TurnPermissionCeiling
): string {
  const level = resolveCeilingLevel(declared, ceiling);
  const own = declared.values.find((m) => m.id === modeId);
  if (own && admits(level, own)) return modeId;
  const loosest = declared.values
    .filter((m) => m.axis !== 'working' && admits(level, m))
    .sort(
      (a, b) =>
        REACH_RANK[b.reach] - REACH_RANK[a.reach] ||
        ASKS_RANK[a.asks] - ASKS_RANK[b.asks] ||
        // Auto and Accept edits declare the same level; the plainer one wins.
        Number(a.id === AUTO_MODE_ID) - Number(b.id === AUTO_MODE_ID)
    )[0];
  if (loosest) return loosest.id;
  // A ceiling below every trust-axis mode (a sender in Plan, say): a
  // working-axis mode it admits, and failing that the strictest mode the
  // runtime declares, never the default, which would be looser than asked.
  const working = declared.values.find((m) => admits(level, m));
  if (working) return working.id;
  const strictest = [...declared.values].sort(
    (a, b) => REACH_RANK[a.reach] - REACH_RANK[b.reach] || ASKS_RANK[b.asks] - ASKS_RANK[a.asks]
  )[0];
  return strictest?.id ?? modeId;
}

/**
 * One roster of every identity on this install (ADR 260806-222535, spec
 * `identity-consistency` §W2.2).
 *
 * A **read-only projection** over two registries that already exist: `authors`
 * for people, the mesh cache for agents. It mints nothing, writes nothing and
 * creates no row — every id it returns already existed. That is the decision,
 * not an implementation detail: a `members` table or a person entity would fork
 * a third identity model beside two the repo has already converged on.
 *
 * It lives in `services/identity/` rather than under `rooms/` or `mesh/`
 * because it reads both and belongs to neither — this domain answers "who is on
 * this install, and what do they look like".
 *
 * Degradation copies `aggregate-session-list.ts` exactly (ADR-0310): each
 * source is read under its own budget, a failure contributes a `warnings[]`
 * entry and zero rows, and the other sources still return. A source that is
 * entirely unreadable is a degraded roster, never a 500 — the person reading
 * the page is on it, so the roster is never empty for the reason that matters.
 *
 * **Every read is inside that envelope, not just the two registries.** The
 * account lookup, the two config reads and the owner predicate were once
 * outside it, and each was a 500 waiting for a corrupt `config.json` or a
 * locked database — a roster that cannot say your name should still be able to
 * list your agents. So a failure in any of them costs exactly what it knows and
 * nothing more: the roster degrades the operator's NAME, never the roster.
 *
 * **Whether an agent is mid-turn is now here too**, and it comes from the only
 * record of it: the room claim map (`services/rooms/room-claims.ts`), joined to
 * the agent's author row. It is a separate field from `recentlyActive` rather
 * than a better version of it — the mesh's `active` status means "seen within
 * the last hour" (`ACTIVE_THRESHOLD_MINUTES = 60`) and answers a different
 * question. See {@link TeamRosterSources.listClaims} and
 * {@link agentActivity} for which sources feed which half of `activity`.
 *
 * @module server/services/identity/aggregate-team
 */
import type {
  TeamAgentActivity,
  TeamAgentFacts,
  TeamMember,
  TeamRosterResponse,
  TeamSourceWarning,
} from '@dorkos/shared/team-schemas';
import type { AgentHealthStatus, AgentRuntime } from '@dorkos/shared/mesh-schemas';
import type { DisplayNameSource } from '@dorkos/shared/config-schema';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../lib/logger.js';
import { authorOrigin, isOwnerRecord, type AuthorRecord } from '../rooms/author-registry.js';
import type { ActiveClaimView } from '../rooms/room-claims.js';
import {
  resolveOperatorProfile,
  type OperatorAccount,
  type OperatorNameRung,
  type OperatorProfile,
} from './operator-profile.js';

/**
 * Per-source budget, mirroring `LIST_SESSIONS_TIMEOUT_MS`.
 *
 * Both registries behind this endpoint are synchronous `better-sqlite3` reads
 * today, so nothing here can exceed it yet. The budget is still applied rather
 * than assumed away: the sources are typed as possibly-async precisely because
 * the next one (a remote community backend, §W2.6) will be, and a source added
 * later must not be able to stall the whole roster by being slow.
 */
export const TEAM_SOURCE_TIMEOUT_MS = 2_000;

/** The `authors` source, named as it appears in a warning. */
export const AUTHORS_SOURCE = 'authors';

/** The mesh source, named as it appears in a warning. */
export const AGENTS_SOURCE = 'agents';

/**
 * The owner-account read, named as it appears in a warning.
 *
 * Its own source rather than folded into `authors` because it fails for its own
 * reasons and costs its own thing: the `authors` table can be perfectly readable
 * while the account lookup is not, and what you lose then is your NAME on your
 * own row — not the roster.
 */
export const OPERATOR_SOURCE = 'operator';

/**
 * The `~/.dork/config.json` reads, named as they appear in a warning.
 *
 * `config.profile.displayName` and `config.agents.defaultAgent` come from one
 * file through one manager, so one name covers both: a corrupt or locked config
 * loses the preferred name and the default-agent mark, and nothing else.
 */
export const CONFIG_SOURCE = 'config';

/**
 * The live claim map, named as it appears in a warning.
 *
 * Its own source because losing it costs exactly one thing: the roster stops
 * being able to say an agent is working RIGHT NOW. Everything else — who is on
 * this install, when each agent last did anything — is still answered.
 */
export const CLAIMS_SOURCE = 'claims';

/**
 * The room read that names the room a claim is held in, named as it appears in
 * a warning.
 *
 * Separate from {@link CLAIMS_SOURCE} because the two degrade to different
 * sentences: without the claims there is no "working" at all, while without the
 * rooms the agent is still reported as working, just without a room label.
 */
export const ROOMS_SOURCE = 'rooms';

/**
 * The cross-agent session fan-out, named as it appears in a warning.
 *
 * The one source here that is not a SQLite read — it walks each runtime's
 * session storage — so it is also the one most likely to spend its budget. It
 * costs `lastActiveAt` for agents whose last run was a session rather than a
 * room turn, and nothing else.
 */
export const SESSIONS_SOURCE = 'sessions';

/**
 * One agent as the roster reads it — structurally what `meshCore.listWithHealth()`
 * returns.
 *
 * Declared here rather than imported from `@dorkos/mesh` so the aggregation
 * depends on the shape it uses and not on the mesh package, which is the same
 * reason it is injected as a function below.
 */
export interface TeamAgentSource {
  id: string;
  name: string;
  displayName?: string;
  runtime: AgentRuntime;
  model?: string;
  icon?: string;
  color?: string;
  /**
   * The namespace used for cross-agent messaging permissions.
   *
   * **Nothing production serves fills this**, and the field is here anyway.
   * `meshCore.listWithHealth()` runs every entry through `toManifest()`
   * (`packages/mesh/src/mesh-agent-management.ts`), which strips `projectPath`,
   * `namespace` and `scanRoot` — they are internal registry fields, and a room is
   * a shared surface. Optional so a source entitled to carry it can, without this
   * module growing a second read of the mesh to fetch it. A test runs a real
   * registry entry through the real strip so this comment cannot go stale
   * silently.
   */
  namespace?: string;
  /**
   * Where the agent lives — stripped by that same `toManifest()` call, and
   * carried here anyway because the profile needs it (spec `profile-unification`
   * §3.1).
   *
   * The source is expected to put it back from the registry's own paths, which
   * is what `routes/team.ts` does. Optional rather than required so the day a
   * roster row comes from somewhere with no local directory behind it, the row
   * is still expressible.
   */
  projectPath?: string;
  isSystem?: boolean;
  registeredAt: string;
  healthStatus: AgentHealthStatus;
  /**
   * When the mesh last heard from this agent, or `null` when it never has.
   *
   * NOT stripped by `toManifest()` — the health-enriched listing carries it, and
   * `healthStatus` is computed from it. One of the two inputs to
   * `activity.lastActiveAt`; see {@link agentActivity} for the other and for why
   * neither alone is enough.
   */
  lastSeenAt?: string | null;
}

/**
 * One live claim as the roster reads it — a strict subset of
 * {@link ActiveClaimView}, so a real `RoomService.listActiveClaims()` satisfies
 * it and nothing here can start depending on a field a claim happens to carry.
 */
export type TeamClaimSource = Pick<ActiveClaimView, 'roomId' | 'authorId' | 'claimedAt'>;

/** One room, reduced to what naming a claim needs. */
export interface TeamRoomSource {
  id: string;
  /** The room's title. */
  name: string;
}

/**
 * Where the roster's rows come from. Every one of them is a read, and every one
 * of them may fail without failing the request.
 */
export interface TeamRosterSources {
  /** Active human authors — `authors` where `retired_at IS NULL` and `kind = 'human'`. */
  listPeople: () => AuthorRecord[] | Promise<AuthorRecord[]>;
  /**
   * Active AGENT authors, for their handles and nothing else.
   *
   * A separate read from {@link TeamRosterSources.listPeople} because it answers
   * a different question: the roster's agent rows come from the mesh, which
   * knows a fleet but not an address — an agent's handle lives on its author
   * row, minted the first time it is in a room. Joined on
   * `mintedForManifestId`, which is the manifest ULID the mesh row already
   * carries, so nothing has to reach for a directory path the wire never sees.
   *
   * It shares the `authors` source name in a warning, because it is the same
   * table failing for the same reasons.
   */
  listAgentAuthors: () => AuthorRecord[] | Promise<AuthorRecord[]>;
  /**
   * The fleet with health, each entry carrying the project directory the public
   * mesh listing strips (`routes/team.ts` joins `listWithHealth()` with
   * `listWithPaths()`).
   */
  listAgents: () => TeamAgentSource[] | Promise<TeamAgentSource[]>;
  /**
   * Every room turn in flight right now — `RoomService.listActiveClaims()`.
   *
   * The ONLY record that an agent is working; presence, `room_context.working`
   * and this field all read the same map, so they cannot disagree. Keyed on the
   * agent's AUTHOR id, which is why it joins through the same
   * `mintedForManifestId` stamp the handle and the photo already ride.
   */
  listClaims: () => TeamClaimSource[] | Promise<TeamClaimSource[]>;
  /**
   * Every room, for putting a name on the room a claim is held in.
   *
   * Read only when at least one claim exists — an install where nothing is
   * working pays nothing for this — and archived rooms are included by the
   * caller, because an agent really can be mid-turn in a room somebody archived
   * while it worked.
   */
  listRooms: () => TeamRoomSource[] | Promise<TeamRoomSource[]>;
  /**
   * Project directory → the `updatedAt` of that agent's newest session, across
   * every runtime — the `agentActivity` map of `listRecentSessions`.
   *
   * The half of `lastActiveAt` the mesh cannot see: mesh health is only stamped
   * by the claude-code runtime's own turn paths, so a codex or opencode agent
   * that ran an hour ago has no `lastSeenAt` at all.
   */
  sessionActivity: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * The account that owns this install, with its address, or `null` when nobody
   * has registered.
   *
   * Read ONCE per roster and used for two things — the operator's name, and
   * which author row is theirs. There is deliberately no injected "is this the
   * owner" predicate beside it: the answer is
   * {@link isOwnerRecord}, a pure comparison against a row this roster already
   * holds, so asking the registry again would be one query per person against
   * the table the list just came from.
   */
  account: () => OperatorAccount | null;
  /** `config.profile.displayName` — "what the user likes to be called". */
  configDisplayName: () => string | null;
  /**
   * `config.profile.displayNameSource` — who wrote that name (DOR-1022), or
   * `null` when this install has no record.
   *
   * Injected beside the name rather than derived from it, because the two are
   * one fact read from one place and a roster that fetched them separately could
   * show a stamp for a name it is no longer displaying.
   */
  configDisplayNameSource: () => DisplayNameSource | null;
  /** `config.agents.defaultAgent`, or `null` when nothing is configured. */
  defaultAgentName: () => string | null;
  /** Per-source budget; defaults to {@link TEAM_SOURCE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Reject `promise` if it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, source: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`reading ${source} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Read one source under its budget, degrading a failure into a warning and
 * `fallback`.
 *
 * The fallback is a parameter rather than always `[]` because not every source
 * is a list: the session fan-out answers with a map, and "what this read knows
 * when it knows nothing" is the source's own answer to give.
 */
async function readSource<T>(
  source: string,
  read: () => T | Promise<T>,
  fallback: T,
  timeoutMs: number
): Promise<{ value: T; warning?: TeamSourceWarning }> {
  try {
    // `Promise.resolve().then(read)` rather than `read()` so a source that
    // throws SYNCHRONOUSLY — which every one of today's `better-sqlite3` sources
    // does — rejects the promise instead of escaping this try in a later
    // refactor.
    const value = await withTimeout(Promise.resolve().then(read), timeoutMs, source);
    return { value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[aggregateTeamRoster] identity source degraded', { source, error: message });
    return { value: fallback, warning: { source, message } };
  }
}

/**
 * Read one value that decorates the roster, degrading a failure to `fallback`.
 *
 * The scalar counterpart of {@link readSource}, and the reason the five reads
 * that are not registries can no longer 500 the request. No timeout: these are
 * an in-memory config object and one indexed row, and a budget on them would be
 * ceremony.
 */
function readValue<T>(
  source: string,
  read: () => T,
  fallback: T,
  warnings: TeamSourceWarning[]
): T {
  try {
    return read();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[aggregateTeamRoster] identity source degraded', { source, error: message });
    warnings.push({ source, message });
    return fallback;
  }
}

/**
 * What the operator's own row says about their name beyond the name itself.
 *
 * Two facts a roster carries about one person, bundled because they travel
 * together and a fourth positional parameter on {@link personRow} would have
 * been the fifth.
 */
interface OperatorRowFacts {
  /** The name resolved for the operator. */
  name: string;
  /** Their address, when known. */
  email: string | undefined;
  /**
   * The `person.nameSuggestedBy` value for their row — see that field's doc for
   * why `undefined` and `null` mean different things.
   */
  nameSuggestedBy: string | null | undefined;
}

/**
 * Whether an agent suggested the stored display name, and which agent — in the
 * three states {@link TeamPersonFacts.nameSuggestedBy} carries (DOR-1022).
 *
 * **`operator` and "no record" collapse to the same answer, deliberately.** A
 * name a person saved needs no hint, and a name this install cannot attribute
 * must not get one: every install that had a name before provenance existed
 * reads `null` here, and labelling those "Suggested by DorkBot" would be a
 * confident guess exactly where there is nothing to be confident about.
 *
 * `undefined` rather than a boolean pair, so the field is simply ABSENT from the
 * payload in the common case rather than present and false.
 *
 * **The rung, never a string comparison.** The stamp is about
 * `profile.displayName`, so the hint only belongs on a roster that is actually
 * showing that rung — an account name outranks it. Asking "does the shown name
 * equal the stored one" answers that question wrong in BOTH directions, which is
 * why {@link resolveOperatorProfile} reports the rung instead:
 *
 * - False negative: the shown name has been through `sanitizeIdentity`, so a
 *   stored `'Dorian  C'` renders as `'Dorian C'` and compares unequal. An agent
 *   could set the name AND suppress the note in one `config_patch` by including
 *   a double space or one zero-width character.
 * - False positive: an account name that happens to equal the agent-written
 *   profile name compares equal, and the hint is drawn for a name the login
 *   supplied and no agent touched.
 *
 * @param source - The stored `profile.displayNameSource`.
 * @param nameRung - Which source the roster's name actually came from.
 * @returns The value for `person.nameSuggestedBy`.
 */
function nameSuggestedBy(
  source: DisplayNameSource | null,
  nameRung: OperatorNameRung
): string | null | undefined {
  if (nameRung !== 'profile') return undefined;
  if (source === null || source.kind !== 'agent') return undefined;
  // Sanitized on the way out as well as on the way in: the stored value is an
  // agent-chosen string headed for a sentence DorkOS wrote, and this is the
  // boundary that hands it to a renderer.
  return source.agentName ? (sanitizeIdentity(source.agentName) ?? null) : null;
}

/**
 * Project one active human author onto a roster row.
 *
 * @param record - The author row.
 * @param isSelf - Whether this is the operator reading the roster.
 * @param operator - The facts that belong to the operator's own row and to no
 *   other: their resolved name, their address, and whether an agent suggested
 *   that name.
 * @param now - The moment this roster was read, which is when the operator was
 *   last seen: they are here, by construction. Everybody else's `lastSeenAt` is
 *   `null` — see the field's doc for why the room log is not read for it.
 */
function personRow(
  record: AuthorRecord,
  isSelf: boolean,
  operator: OperatorRowFacts,
  now: string
): TeamMember {
  const { name: operatorName, email: operatorEmail } = operator;
  return {
    id: record.id,
    kind: 'human',
    // The divergence `operator-profile.ts` exists for: the operator's own row
    // carries their real name, everyone else carries the name their author row
    // was minted under.
    displayName: isSelf ? operatorName : record.displayName,
    // Straight off the author row — the same column the room roster, the mention
    // picker and the resolver all read. `null` until this person chooses one,
    // and nothing asks them to yet: the surface that does ships with the profile
    // work (DOR-979). The page renders the absence rather than inventing a name.
    handle: record.handle,
    ...(record.emoji ? { emoji: record.emoji } : {}),
    ...(record.color ? { color: record.color } : {}),
    ...(record.imageUrl ? { imageUrl: record.imageUrl } : {}),
    isSelf,
    // Nothing owns a person.
    ownerId: null,
    origin: authorOrigin(record.naturalKey),
    person: {
      // No backend on this install declares roles yet.
      role: null,
      ...(isSelf && operatorEmail ? { email: operatorEmail } : {}),
      // The operator's own row and no other: the stored display name is theirs,
      // so who wrote it is a fact about nobody else on this roster. Spread the
      // same way `email` is, so the key is absent rather than `undefined` — and
      // absent is a meaning here, not just a shape (DOR-1022).
      ...(isSelf && operator.nameSuggestedBy !== undefined
        ? { nameSuggestedBy: operator.nameSuggestedBy }
        : {}),
      lastSeenAt: isSelf ? now : null,
    },
  };
}

/**
 * The later of two possibly-absent, possibly-unparseable ISO timestamps.
 *
 * `Date.parse` answers `NaN` for anything it cannot read, and a corrupt stamp
 * loses to a good one **in either position**. The comparison alone does not get
 * there: every `>` against `NaN` is false, so a bare `b > a` keeps `a` even when
 * `a` is the unreadable one, and the roster would put `"not-a-date"` on the wire
 * for the client to render. Two bad stamps leave the first, which is as honest
 * as this function can be about input it cannot order.
 */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left)) return Number.isNaN(right) ? a : b;
  return right > left ? b : a;
}

/**
 * What one agent is doing, from the two questions that have different answers.
 *
 * **`working` has exactly one source and always will**: the live claim map. It
 * is the only record that a turn is in flight, and presence, `room_context` and
 * this field all read it, so none of them can say something the others deny.
 *
 * **`lastActiveAt` is the max over the two cheap sources**, and it needs both:
 *
 * - mesh `lastSeenAt` — stamped by the claude-code runtime's own turn paths
 *   (`message_sent`, `response_complete`) and by `POST /api/mesh/agents/:id/heartbeat`.
 *   Nothing stamps it for codex or opencode, so it is silent for those agents.
 * - the session fan-out's `agentActivity[projectPath]` — the newest session
 *   `updatedAt` across every runtime, which covers the agents mesh health does
 *   not, and needs the project path this roster now carries.
 *
 * The room log is deliberately NOT a third source. It would date a room turn the
 * claim map already reported while it ran, and dating it means an ungrouped scan
 * of the largest table on the install, on a request a profile repeats every 15
 * seconds.
 *
 * @param agent - The mesh's view of the agent.
 * @param claim - Its live claim, or `null` when it is not mid-turn.
 * @param roomName - The claimed room's title, or `null` when unresolved.
 * @param sessionActivity - Project directory → newest session `updatedAt`.
 */
function agentActivity(
  agent: TeamAgentSource,
  claim: TeamClaimSource | null,
  roomName: string | null,
  sessionActivity: Record<string, string>
): TeamAgentActivity {
  const sessionSeen = agent.projectPath ? (sessionActivity[agent.projectPath] ?? null) : null;
  return {
    working: claim ? { roomId: claim.roomId, roomName, since: claim.claimedAt } : null,
    lastActiveAt: laterOf(agent.lastSeenAt ?? null, sessionSeen),
  };
}

/**
 * Project one registered agent onto a roster row.
 *
 * @param agent - The mesh's view of the agent.
 * @param operatorId - The owner's author id, or `null`.
 * @param defaultAgentName - `config.agents.defaultAgent`, or `null`.
 * @param author - Its author row, or `null` when it has never been in a room and
 *   so has none. Two things live only there: the address it answers to, and any
 *   photo it has been given. Both ride the SAME row, so they cannot disagree
 *   about which occupancy generation of a directory they belong to.
 * @param activity - What it is doing (see {@link agentActivity}).
 */
function agentRow(
  agent: TeamAgentSource,
  operatorId: string | null,
  defaultAgentName: string | null,
  author: AuthorRecord | null,
  activity: TeamAgentActivity
): TeamMember {
  const isSystem = agent.isSystem === true;
  const facts: TeamAgentFacts = {
    manifestId: agent.id,
    runtime: agent.runtime,
    ...(agent.model ? { model: agent.model } : {}),
    healthStatus: agent.healthStatus,
    // `active` is the mesh's word for "seen within the last hour"
    // (ACTIVE_THRESHOLD_MINUTES = 60), which is the only liveness this endpoint
    // can read without a second query — hence the field's name. It is NOT
    // "mid-turn"; see the module doc for where that signal actually lives.
    recentlyActive: agent.healthStatus === 'active',
    ...(agent.namespace ? { namespace: agent.namespace } : {}),
    ...(agent.projectPath ? { projectPath: agent.projectPath } : {}),
    activity,
    isDefault: defaultAgentName !== null && agent.name === defaultAgentName,
    isSystem,
    registeredAt: agent.registeredAt,
  };
  return {
    id: agent.id,
    kind: 'agent',
    displayName: agent.displayName ?? agent.name,
    handle: author?.handle ?? null,
    ...(agent.icon ? { emoji: agent.icon } : {}),
    ...(agent.color ? { color: agent.color } : {}),
    // The mesh knows an agent's emoji and colour; only its author row knows a
    // photo, because that is the row an avatar store writes.
    ...(author?.imageUrl ? { imageUrl: author.imageUrl } : {}),
    isSelf: false,
    // A system agent belongs to the install, not to a person. Every other agent
    // on this machine belongs to the one operator — and when the operator's own
    // row could not be read, there is no id in THIS roster's space to point at,
    // so a dangling reference is refused in favour of `null`.
    ownerId: isSystem ? null : operatorId,
    origin: 'local',
    agent: facts,
  };
}

/**
 * Build the roster.
 *
 * Order is the contract the page renders against: the operator first, then
 * everyone else in the order `authors` returns them, then the agents in the
 * order the mesh returns them. Nothing re-sorts the fleet here — the page's
 * attention order is a client concern and a server-side sort would fight it.
 *
 * @param sources - The reads this roster is made of.
 */
export async function aggregateTeamRoster(sources: TeamRosterSources): Promise<TeamRosterResponse> {
  const timeoutMs = sources.timeoutMs ?? TEAM_SOURCE_TIMEOUT_MS;
  // One clock for the whole read: the operator's `lastSeenAt` is the moment the
  // roster was taken, not the moment their row happened to be projected.
  const now = new Date().toISOString();

  const [people, agents, agentAuthors, claims, sessionActivity] = await Promise.all([
    readSource(AUTHORS_SOURCE, () => sources.listPeople(), [] as AuthorRecord[], timeoutMs),
    readSource(AGENTS_SOURCE, () => sources.listAgents(), [] as TeamAgentSource[], timeoutMs),
    readSource(AUTHORS_SOURCE, () => sources.listAgentAuthors(), [] as AuthorRecord[], timeoutMs),
    readSource(CLAIMS_SOURCE, () => sources.listClaims(), [] as TeamClaimSource[], timeoutMs),
    readSource(SESSIONS_SOURCE, () => sources.sessionActivity(), {}, timeoutMs),
  ]);

  // Named only when something is actually working: on the install this endpoint
  // mostly serves, nothing is, and the room list is a read nobody needed.
  const rooms =
    claims.value.length > 0
      ? await readSource(ROOMS_SOURCE, () => sources.listRooms(), [] as TeamRoomSource[], timeoutMs)
      : { value: [] as TeamRoomSource[], warning: undefined };

  const warnings: TeamSourceWarning[] = [];
  if (people.warning) warnings.push(people.warning);
  if (agents.warning) warnings.push(agents.warning);
  // Only when `listPeople` did not already say the same thing about the same
  // table — one failure, one warning.
  if (agentAuthors.warning && !people.warning) warnings.push(agentAuthors.warning);
  if (claims.warning) warnings.push(claims.warning);
  if (rooms.warning) warnings.push(rooms.warning);
  if (sessionActivity.warning) warnings.push(sessionActivity.warning);

  // Every read below is degradable. Losing the account costs the operator's
  // name and their `isSelf` mark; losing the config costs the preferred name
  // and the default-agent mark. Neither costs a single row.
  const account = readValue(OPERATOR_SOURCE, sources.account, null, warnings);
  const configDisplayName = readValue(CONFIG_SOURCE, sources.configDisplayName, null, warnings);
  // Degrades to `null`, which is "no record" and draws no hint — the same
  // direction every other loss here takes: a config this roster could not read
  // costs a line of small print, never a row.
  const configNameSource = readValue(
    CONFIG_SOURCE,
    sources.configDisplayNameSource,
    null,
    warnings
  );
  const defaultAgentName = readValue(CONFIG_SOURCE, sources.defaultAgentName, null, warnings);

  // A pure comparison against rows already in hand — see `TeamRosterSources.account`
  // for why this is not an injected predicate.
  const self = people.value.find((record) => isOwnerRecord(record, account?.id ?? null)) ?? null;
  const operator: OperatorProfile = resolveOperatorProfile(
    { account: () => account, configDisplayName: () => configDisplayName },
    self?.displayName ?? null
  );

  const operatorRowFacts: OperatorRowFacts = {
    name: operator.displayName,
    email: operator.email,
    nameSuggestedBy: nameSuggestedBy(configNameSource, operator.nameRung),
  };
  const personRows = people.value.map((record) =>
    personRow(record, record.id === self?.id, operatorRowFacts, now)
  );
  // The operator first — and this really does move a row: `listActive` orders by
  // `created_at`, and a bridged group seen before login was enabled leaves an
  // external person minted BEFORE the owner. `sort` rather than a partition
  // because it is one row moving and the rest keep the order `authors` gave them.
  personRows.sort((a, b) => Number(b.isSelf) - Number(a.isSelf));

  // Keyed on the occupancy stamp rather than on the display name, so an agent
  // registered where a previous one lived does not inherit its address or its
  // face — the same generation boundary the author registry draws
  // (ADR 260801-003051). The whole row is carried rather than one field off it,
  // so everything an author row contributes joins the same way and once.
  const authorByManifestId = new Map(
    agentAuthors.value
      .filter((record) => record.mintedForManifestId !== null)
      .map((record) => [record.mintedForManifestId!, record])
  );

  // The claim an agent is holding, by AUTHOR id — the id a claim carries.
  //
  // At most one claim per agent is reachable in practice: the second claim
  // ceiling is the agent's directory, so a turn in one room refuses a trigger in
  // every other (`claimBusyWith`). The reduce is here for the day that stops
  // being true, and it keeps the one it has held LONGEST rather than whichever
  // the map iterated first, so two reads of the same state say the same thing.
  const claimByAuthorId = new Map<string, TeamClaimSource>();
  for (const claim of claims.value) {
    const held = claimByAuthorId.get(claim.authorId);
    if (!held || Date.parse(claim.claimedAt) < Date.parse(held.claimedAt)) {
      claimByAuthorId.set(claim.authorId, claim);
    }
  }
  const roomNameById = new Map(rooms.value.map((room) => [room.id, room.name]));

  const agentRows = agents.value.map((agent) => {
    const author = authorByManifestId.get(agent.id) ?? null;
    const claim = author ? (claimByAuthorId.get(author.id) ?? null) : null;
    return agentRow(
      agent,
      self?.id ?? null,
      defaultAgentName,
      author,
      agentActivity(
        agent,
        claim,
        claim ? (roomNameById.get(claim.roomId) ?? null) : null,
        sessionActivity.value
      )
    );
  });

  const members = [...personRows, ...agentRows];
  // Omitted entirely on a clean read, never `[]` — the ADR-0310 rule, so a
  // client can treat the key's presence as the degradation signal.
  return warnings.length > 0 ? { members, warnings } : { members };
}

/**
 * Scope, as a visible chip rather than a query language (design-decisions §15).
 *
 * §15 chose the shape before the code did: "`@agent` / `#channel` resolve into
 * visible chips; residual query searches within scope. Backspace pops the chip.
 * No `agent:foo before:bar` language." So there is nothing here that parses a
 * token out of what a person typed. A scope is a THING they picked — an agent
 * or a channel — carried as an object, drawn as a chip, and used as a filter.
 * A query language would have to be learned, remembered, and then reported back
 * to the person who typed it wrong; a chip is on screen the whole time.
 *
 * **It filters; it never ranks.** The scope decides what is in the list and
 * `palette-ranking` decides the order of what is left — the same composition
 * the prefixes already follow, so a row a scope excluded cannot come back
 * through a score.
 *
 * Pure and React-free, so what a scope admits is assertable against a fixed
 * corpus.
 *
 * @module features/command-palette/model/palette-scope
 */
import type { RoomSummary } from '@/layers/entities/room';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { interactionKey } from '@/layers/entities/interactions';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

/**
 * What the palette is scoped to, or `null` when it is scoped to nothing.
 *
 * A union over the two kinds §15 names, carrying the whole subject rather than
 * an id: the chip draws that subject's own face and name, and re-deriving them
 * from a list that has since refetched is how a chip ends up naming the wrong
 * agent.
 */
export type PaletteScope =
  | { kind: 'agent'; agent: AgentPathEntry }
  | { kind: 'room'; room: RoomSummary };

/**
 * The key a scope admits rows by — the same `type:id` space
 * {@link interactionKey} builds, and for the same reason.
 *
 * An agent is keyed by its DIRECTORY, not its mesh id: that is what a
 * conversation carries (`cwd`), and it is what the interaction store records.
 *
 * @param scope - The active scope.
 */
export function scopeKey(scope: PaletteScope): string {
  return scope.kind === 'agent'
    ? interactionKey('agent', scope.agent.projectPath)
    : interactionKey('room', scope.room.id);
}

/**
 * What the chip says.
 *
 * The subject's own name and nothing else — no `@`, no `agent:`, no type word.
 * The chip's shape already says it is a scope, and the prefix a person typed to
 * find it was a way in, not part of what they picked.
 *
 * @param scope - The active scope.
 */
export function scopeLabel(scope: PaletteScope): string {
  return scope.kind === 'agent'
    ? getAgentDisplayName(scope.agent)
    : scope.room.kind === 'channel' && scope.room.slug
      ? `#${scope.room.slug}`
      : scope.room.title;
}

/**
 * The heading over a scoped list of conversations.
 *
 * Two prepositions, because they are not the same relation and reading them as
 * one would be wrong in both directions: a conversation happens **with** an
 * agent, and **in** a channel. The noun is the product's word for the thing
 * (`Conversations`), not the mockup's `Sessions`.
 *
 * @param scope - The active scope.
 */
export function scopeHeading(scope: PaletteScope): string {
  const preposition = scope.kind === 'agent' ? 'with' : 'in';
  return `Conversations ${preposition} ${scopeLabel(scope)}`;
}

/**
 * What to say when a scope holds nothing.
 *
 * A chip a person picked and got an empty list from has to say why, or it reads
 * as a palette that broke. Both endings are true statements about the subject
 * rather than about the search.
 *
 * @param scope - The active scope.
 */
export function scopeEmptyMessage(scope: PaletteScope): string {
  return scope.kind === 'agent'
    ? `No conversations with ${scopeLabel(scope)} yet.`
    : `No conversations came from ${scopeLabel(scope)}.`;
}

/**
 * The label the SERVER stamps on a conversation that came from a room.
 *
 * An exact mirror of `RoomStore.resolveRoomOrigins`, which builds
 * `originLabel` as `#<slug>` for a channel and the title for a direct message.
 * The wire carries that label and not the room's id, so this string is the only
 * join available between a room and the conversations it started — see
 * {@link roomIdsByOriginLabel} for what that costs.
 *
 * **A rename is NOT a problem here**, which is worth saying because it is the
 * first thing it looks like. `resolveRoomOrigins` joins the `rooms` table live
 * and recomputes the label on every request, so a renamed channel's stamp and
 * this map move together. The join's real weakness is collision, below.
 *
 * @param room - The room to name the way the server names it.
 */
export function roomOriginLabel(room: RoomSummary): string {
  return room.kind === 'channel' && room.slug ? `#${room.slug}` : room.title;
}

/**
 * Every room this cockpit can see, keyed by the label a turn it started carries.
 *
 * **Two rooms can produce the same label, and the map has to pick one.** The
 * label is a name, and names are not unique here:
 *
 * - `rooms_channel_slug_unique` is a PARTIAL index (`archived = 0`), so an
 *   archived `#shipping` and a live `#shipping` are both legal and both appear
 *   in the palette — archived rooms are deliberately findable (DOR-1051).
 * - A direct message's label is its title, and nothing stops a title from being
 *   the literal string `#general`.
 *
 * So the precedence is stated rather than left to array order: **a live channel
 * beats an archived one, and a channel beats a direct message.** First write
 * wins after that. That makes the outcome deterministic and matches which room
 * a person is overwhelmingly likelier to mean — but it does not make it
 * *correct*, and the cost is worth naming plainly: in a collision, turns that
 * really came from the archived `#shipping` are offered under the live one, and
 * scoping to the archived room shows nothing at all.
 *
 * **The fix is a room id on the wire, and it is not this file's to make.** The
 * server already knows exactly which room started each session
 * (`room_sessions`, read by `resolveRoomOrigins`) and puts only the label on
 * `Session.originLabel`. Carrying `originRoomId` beside it turns this whole
 * function into a dictionary lookup that cannot collide. It is filed
 * separately because it crosses into the session-origin overlay.
 *
 * @param rooms - Every room the cockpit can see, in any order.
 */
export function roomIdsByOriginLabel(rooms: readonly RoomSummary[]): ReadonlyMap<string, string> {
  const byLabel = new Map<string, string>();
  const ranked = [...rooms].sort((a, b) => {
    const kindFirst = Number(a.kind === 'dm') - Number(b.kind === 'dm');
    if (kindFirst !== 0) return kindFirst;
    return Number(a.archived) - Number(b.archived);
  });
  for (const room of ranked) {
    const label = roomOriginLabel(room);
    if (!byLabel.has(label)) byLabel.set(label, room.id);
  }
  return byLabel;
}

/** Just enough of a conversation to say which scopes it belongs to. */
export interface ScopableSession {
  /** The directory it belongs to, which is how an agent claims it. */
  cwd: string | null;
  /** Where it came from, when the server could say. */
  origin?: string;
  /** The server's own wording for that origin — for a room turn, the room's label. */
  originLabel?: string;
}

/**
 * Which scopes one conversation belongs to, as {@link scopeKey} values.
 *
 * Two relations, and they are not equally solid, which is worth saying rather
 * than hiding behind a uniform-looking list:
 *
 * - **The agent relation is an identity join.** A conversation carries the
 *   directory it runs in and an agent IS a directory, so the two cannot drift.
 * - **The room relation is a label join**, because the server puts only
 *   `originLabel` on the wire. Two rooms can share a label, so the map it reads
 *   has to choose between them — see {@link roomIdsByOriginLabel} for which one
 *   it chooses, what that gets wrong, and why the fix lives on the server.
 *
 * @param session - The conversation.
 * @param roomIdByOriginLabel - Every room this cockpit can see, keyed by the
 *   label the server would have stamped on a turn it started
 *   ({@link roomIdsByOriginLabel}).
 */
export function scopesOfSession(
  session: ScopableSession,
  roomIdByOriginLabel: ReadonlyMap<string, string>
): string[] {
  const scopes: string[] = [];
  if (session.cwd !== null) scopes.push(interactionKey('agent', session.cwd));
  if (session.origin === 'room' && session.originLabel !== undefined) {
    const roomId = roomIdByOriginLabel.get(session.originLabel);
    if (roomId !== undefined) scopes.push(interactionKey('room', roomId));
  }
  return scopes;
}

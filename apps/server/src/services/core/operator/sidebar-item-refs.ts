/**
 * Turning what a model can SAY about an agent or a room into the exact string
 * the sidebar renders by (DOR-2055).
 *
 * ## The defect this exists to close
 *
 * A `SidebarItemRef` is resolved by the client with an exact string match:
 * `build-library-sections.ts` keys agents by the mesh `projectPath` and rooms by
 * id, and **stale references are never pruned by design**. So a stored
 * `{ kind: 'agent', path: 'scout' }` is not an error anywhere — it is a member
 * of the section forever, and it draws nothing, forever. Storing whatever the
 * caller typed therefore turns a typo into a permanent silent no-op with a
 * `success: true` beside it, which is the worst answer a tool can give.
 *
 * ## Why a ref may name an agent three ways
 *
 * Because a model usually cannot obtain a `projectPath` at all. `AgentManifest`
 * does not carry one (`packages/shared/src/mesh-schemas.ts`), so neither
 * `mesh_list` nor `mesh_inspect` returns it; `agents_recent_activity` does, but
 * it filters out every agent with no recent session — which is exactly the agent
 * somebody has just registered and wants to file. Demanding the one identifier
 * the surface does not hand out is how a capability becomes unusable in
 * practice.
 *
 * So a caller may name an agent by `path`, `agentId`, or `name` (its slug, or
 * its display name, matched without case), and every one of those — `path`
 * included — is resolved against `MeshCore.listWithPaths()`. What is STORED is
 * always the canonical `projectPath` off the roster, so the stored ref is the
 * string the sidebar will actually match, not the string somebody typed.
 *
 * Rooms are the same shape one identifier down: by `roomId`, or by name (slug or
 * title, without case) when exactly one non-archived room answers to it.
 *
 * ## Why an unresolved ref refuses the WHOLE call
 *
 * Partial success on a membership write is unreadable: the model reports three
 * agents filed, one of them is not there, and nothing on either side can say
 * which. A refusal naming the refs that did not resolve, with a few roster names
 * beside them, is one turn shorter than the alternative and cannot lie.
 *
 * @module services/core/operator/sidebar-item-refs
 */
import type { SidebarItemRef } from '@dorkos/shared/config-schema';

/** How a caller may name an agent: by its path, its id, or its name. */
export interface SidebarAgentRefInput {
  /** Discriminator. */
  kind: 'agent';
  /** The agent's project directory, as the roster stores it. */
  path?: string;
  /** The agent's ULID. */
  agentId?: string;
  /** The agent's slug, or its display name (matched without case). */
  name?: string;
}

/** How a caller may name a room: by its id, or by its name. */
export interface SidebarRoomRefInput {
  /** Discriminator. */
  kind: 'room';
  /** The room's id. */
  roomId?: string;
  /** The room's channel slug or its title (matched without case). */
  name?: string;
}

/** One thing a caller wants filed in, or taken out of, a sidebar section. */
export type SidebarItemRefInput = SidebarAgentRefInput | SidebarRoomRefInput;

/** One registered agent, as the mesh roster reports it. */
export interface SidebarRosterAgent {
  /** The agent's ULID. */
  id: string;
  /** The agent's immutable slug. */
  name: string;
  /** The agent's display name, when it has one. */
  displayName?: string;
  /** The directory the sidebar matches on — the only thing ever stored. */
  projectPath: string;
}

/** One room a person can still see: never archived, never a stale row. */
export interface SidebarRosterRoom {
  /** The room's id — the only thing ever stored. */
  roomId: string;
  /** The room's title. */
  name: string;
  /** The channel slug, or `null` for a direct message. */
  slug: string | null;
}

/**
 * What the install can currently see, as the two lists this module matches
 * against.
 *
 * `rooms: undefined` is not an empty roster and must not be read as one: it
 * means this process has no rooms seam wired, so "does that room exist" is a
 * question nobody here can answer. A room ref then refuses with that reason
 * rather than being waved through or reported as missing.
 */
export interface SidebarRoster {
  /** Every registered agent, or `[]` when Mesh is off. */
  agents: readonly SidebarRosterAgent[];
  /** Every non-archived room the operator can see, or `undefined` when rooms are not wired. */
  rooms: readonly SidebarRosterRoom[] | undefined;
}

/** Every ref resolved to what will be stored, or the reason one could not be. */
export type SidebarItemResolution =
  | { ok: true; items: SidebarItemRef[] }
  | { ok: false; code: 'SIDEBAR_ITEM_NOT_FOUND'; error: string; unresolved: string[] };

/** How many roster names a refusal offers as candidates. */
const SUGGESTION_LIMIT = 5;

/** Compare two paths ignoring a trailing separator, which no roster entry carries. */
function samePath(a: string, b: string): boolean {
  const strip = (value: string): string => value.replace(/[/\\]+$/, '');
  return strip(a) === strip(b);
}

/** Case-insensitive equality on trimmed text, for every name match here. */
function sameName(a: string | null | undefined, b: string): boolean {
  return a != null && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** How a ref reads back to the caller in a refusal, in the caller's own words. */
function describeRef(ref: SidebarItemRefInput): string {
  const named =
    ref.kind === 'agent'
      ? [
          ref.path && `path "${ref.path}"`,
          ref.agentId && `agentId "${ref.agentId}"`,
          ref.name && `name "${ref.name}"`,
        ]
      : [ref.roomId && `roomId "${ref.roomId}"`, ref.name && `name "${ref.name}"`];
  const parts = named.filter((part): part is string => Boolean(part));
  return parts.length === 0 ? `${ref.kind} (nothing named)` : `${ref.kind} ${parts.join(' + ')}`;
}

/**
 * Roster names worth offering after a miss, closest first.
 *
 * Not a real edit distance, deliberately. The failure being helped is a model
 * that typed a slug when the roster holds a display name, or shortened one, so
 * shared prefix and substring containment catch essentially all of it — and a
 * scoring function nobody can predict makes a refusal harder to read, not
 * easier. Ties keep roster order, so the same miss always suggests the same
 * names.
 *
 * @param agents - The roster.
 * @param query - What the caller typed, when it typed anything.
 * @returns At most {@link SUGGESTION_LIMIT} names.
 */
function closestAgentNames(
  agents: readonly SidebarRosterAgent[],
  query: string | undefined
): string[] {
  const labelled = agents.map((agent) =>
    agent.displayName && agent.displayName !== agent.name
      ? `${agent.name} ("${agent.displayName}")`
      : agent.name
  );
  if (!query) return labelled.slice(0, SUGGESTION_LIMIT);

  const wanted = query.trim().toLowerCase();
  const score = (agent: SidebarRosterAgent): number => {
    const candidates = [agent.name, agent.displayName ?? ''].map((c) => c.toLowerCase());
    let best = 0;
    for (const candidate of candidates) {
      if (candidate === wanted) return 1000;
      if (candidate.includes(wanted) || wanted.includes(candidate)) best = Math.max(best, 500);
      let shared = 0;
      while (shared < candidate.length && shared < wanted.length) {
        if (candidate[shared] !== wanted[shared]) break;
        shared += 1;
      }
      best = Math.max(best, shared);
    }
    return best;
  };
  return agents
    .map((agent, index) => ({ label: labelled[index]!, score: score(agent), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => entry.label);
}

/** Resolve one agent ref against the roster, or say why it did not resolve. */
function resolveAgentRef(
  ref: SidebarAgentRefInput,
  agents: readonly SidebarRosterAgent[]
): { ok: true; stored: SidebarItemRef } | { ok: false; why: string } {
  if (!ref.path && !ref.agentId && !ref.name) {
    return { ok: false, why: 'names no agent: send one of path, agentId or name' };
  }
  // Ordered by how exact the identifier is, so an agent whose display name
  // happens to equal another agent's slug can never beat an explicit id.
  const matches = ref.path
    ? agents.filter((agent) => samePath(agent.projectPath, ref.path!))
    : ref.agentId
      ? agents.filter((agent) => agent.id === ref.agentId)
      : agents.filter(
          (agent) => sameName(agent.name, ref.name!) || sameName(agent.displayName, ref.name!)
        );

  if (matches.length === 1) {
    // ALWAYS the roster's own path, never the caller's string: that is the whole
    // point — what is stored has to be what the sidebar will match on.
    return { ok: true, stored: { kind: 'agent', path: matches[0]!.projectPath } };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      why: `matches ${matches.length} agents (${matches
        .map((agent) => `"${agent.name}"`)
        .join(', ')}); send agentId instead`,
    };
  }
  return { ok: false, why: 'matches no registered agent' };
}

/** Resolve one room ref against the visible rooms, or say why it did not resolve. */
function resolveRoomRef(
  ref: SidebarRoomRefInput,
  rooms: readonly SidebarRosterRoom[]
): { ok: true; stored: SidebarItemRef } | { ok: false; why: string } {
  if (!ref.roomId && !ref.name) {
    return { ok: false, why: 'names no room: send roomId or name' };
  }
  const matches = ref.roomId
    ? rooms.filter((room) => room.roomId === ref.roomId)
    : rooms.filter((room) => sameName(room.slug, ref.name!) || sameName(room.name, ref.name!));

  if (matches.length === 1)
    return { ok: true, stored: { kind: 'room', roomId: matches[0]!.roomId } };
  if (matches.length > 1) {
    return {
      ok: false,
      why: `matches ${matches.length} rooms; send roomId instead`,
    };
  }
  // One sentence for both misses, because from here they are the same fact and
  // the difference leaks a room the caller may not be allowed to know about.
  return { ok: false, why: 'matches no room that is still open (archived rooms do not count)' };
}

/**
 * Resolve every ref a caller sent, or refuse the lot.
 *
 * @param refs - What the caller named, in the order it named them.
 * @param roster - What this install can currently see.
 * @returns The canonical refs to store, or the refusal to answer with.
 */
export function resolveSidebarItems(
  refs: readonly SidebarItemRefInput[],
  roster: SidebarRoster
): SidebarItemResolution {
  const items: SidebarItemRef[] = [];
  const unresolved: string[] = [];
  let sawAgentMiss = false;
  let agentQuery: string | undefined;

  for (const ref of refs) {
    if (ref.kind === 'room' && roster.rooms === undefined) {
      unresolved.push(`${describeRef(ref)} — rooms are not available on this DorkOS`);
      continue;
    }
    const outcome =
      ref.kind === 'agent'
        ? resolveAgentRef(ref, roster.agents)
        : resolveRoomRef(ref, roster.rooms!);

    if (outcome.ok) {
      items.push(outcome.stored);
      continue;
    }
    if (ref.kind === 'agent') {
      sawAgentMiss = true;
      agentQuery ??= ref.name ?? ref.path ?? ref.agentId;
    }
    unresolved.push(`${describeRef(ref)} — ${outcome.why}`);
  }

  if (unresolved.length === 0) return { ok: true, items };

  // Named rather than counted, because the caller has to know WHICH one to fix,
  // and nothing was written, because a half-filed section is unreadable.
  const suggestions =
    sawAgentMiss && roster.agents.length > 0
      ? ` The agents registered here are ${closestAgentNames(roster.agents, agentQuery).join(
          ', '
        )}${roster.agents.length > SUGGESTION_LIMIT ? ', and more' : ''}.`
      : '';
  return {
    ok: false,
    code: 'SIDEBAR_ITEM_NOT_FOUND',
    error:
      `Nothing was changed. ${unresolved.length === 1 ? 'This item' : 'These items'} could not ` +
      `be found: ${unresolved.join('; ')}.${suggestions} An item has to be one DorkOS already ` +
      'knows about, or the sidebar would show a row that points at nothing.',
    unresolved,
  };
}

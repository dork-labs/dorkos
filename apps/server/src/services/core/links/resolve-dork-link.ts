/**
 * What a `dork:` link opens, for one caller (DOR-5046, ADR 261122-124821 §5.3).
 *
 * A link names a thing by its reference (`dork:chat:<id>`, `dork:room:<id>`,
 * `dork:entry:<id>`, `dork:agent:<id>`). This reads the reference, finds the
 * thing on this server, and checks that the caller may see it, through the
 * same checks the thing's own read routes use. The answer is the kind and the
 * ids that open it; the app turns those into a screen.
 *
 * **One refusal for everything that opens nothing.** A thing that does not
 * exist, one the caller may not see, a kind this build does not open, an
 * address (`dork:acme/owl`) and a string that is no reference at all are all
 * `null` here and `LINK_NOT_FOUND` on the wire, so a link never confirms that
 * anything exists.
 *
 * @module services/core/links/resolve-dork-link
 */
import { AGENT_ID_PATTERN, parseDorkReference } from '@dorkos/shared/dork-ref';
import type { ResolvedDorkLink } from '@dorkos/shared/dork-link-schemas';
import type { CapabilityHandlerContext } from '../capabilities/index.js';

/** Where one message sits, as far as a link needs it. */
export interface LinkedEntry {
  /** The room the message is in. */
  roomId: string;
  /** Its place in that room's log. */
  seq: number;
  /** The message its thread hangs under, when it is a reply in one. */
  threadRootEntryId: string | null;
}

/**
 * The lookups a link resolves through. Each one that takes the call's context
 * answers for that caller: a thing the caller may not see is not found.
 */
export interface DorkLinkLookups {
  /** The id a chat answers under now, following a re-key from an older one. */
  followChatRekey(sessionId: string): string;
  /** Whether this caller may open the chat: it exists here and they may read it. */
  chatVisible(sessionId: string, context: CapabilityHandlerContext): Promise<boolean>;
  /** Whether this caller may open the room or DM. */
  roomVisible(roomId: string, context: CapabilityHandlerContext): boolean;
  /** Where the message is, when this caller may read it; `null` otherwise. */
  entryVisible(entryId: string, context: CapabilityHandlerContext): LinkedEntry | null;
  /** Whether an agent with this mesh id is registered here. */
  agentVisible(agentId: string): boolean;
}

/**
 * What a `dork:` reference opens for this caller.
 *
 * @param uri - The `dork:` string the link carried.
 * @param lookups - Where things are found and who may see them.
 * @param context - The call, for who is asking.
 * @returns The kind and ids that open it, or `null` when it opens nothing
 *   this caller may see.
 */
export async function resolveDorkLink(
  uri: string,
  lookups: DorkLinkLookups,
  context: CapabilityHandlerContext
): Promise<ResolvedDorkLink | null> {
  const parsed = parseDorkReference(uri);
  if (!parsed.ok) return null;
  const { kind, id } = parsed.value;
  switch (kind) {
    case 'chat': {
      const sessionId = lookups.followChatRekey(id);
      return (await lookups.chatVisible(sessionId, context)) ? { kind, sessionId } : null;
    }
    case 'room':
      return lookups.roomVisible(id, context) ? { kind, roomId: id } : null;
    case 'entry': {
      const entry = lookups.entryVisible(id, context);
      if (!entry) return null;
      return {
        kind,
        roomId: entry.roomId,
        entryId: id,
        seq: entry.seq,
        ...(entry.threadRootEntryId ? { threadRootEntryId: entry.threadRootEntryId } : {}),
      };
    }
    case 'agent':
      return AGENT_ID_PATTERN.test(id) && lookups.agentVisible(id) ? { kind, agentId: id } : null;
    default:
      // A kind DorkOS mints but no screen opens yet (a space, a person, a turn,
      // a to-do, a run): the same answer as a thing that is not there.
      return null;
  }
}

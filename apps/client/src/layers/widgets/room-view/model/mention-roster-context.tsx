/**
 * WHO a room's mentions name — the roster, made readable from inside the
 * markdown Streamdown has already drawn.
 *
 * The sibling of `agent-info-context`, and for the same reason: a mention pill
 * lives inside a Streamdown subtree, and Streamdown's top-level memo comparator
 * (2.5.0) compares `children`, the plugin arrays and a dozen display options and
 * then stops — `components` is not among them. So a rebuilt component map
 * re-renders nothing below it, and anything a pill needs that can change while
 * the message text does not has to arrive by context or it never arrives at all.
 * That is `agent-info-context` for how an agent RUNS, and this for who it IS.
 *
 * **Mounted per message, not per room.** `RoomEntryBody` already holds the
 * roster as a prop and is the only thing that draws a `<mention>`, so putting
 * the provider there keeps the roster a single prop chain with one extra hop at
 * the end — rather than a second thing every surface that renders a row (the
 * timeline, the thread panel, the Dev Playground's benches) has to remember to
 * mount. The value is the room's own `authors` map, which is memoised once per
 * room, so every row shares one reference and the extra providers cost nothing.
 *
 * @module widgets/room-view/model/mention-roster-context
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { RosterAuthor } from '../lib/room-timeline';

/** One shared empty roster, so a pill drawn with no provider above it costs nothing. */
const NOBODY: ReadonlyMap<string, RosterAuthor> = new Map();

const MentionRosterContext = createContext<ReadonlyMap<string, RosterAuthor>>(NOBODY);

/**
 * Make one room's roster readable to every mention pill drawn beneath.
 *
 * @param props.authors - The room's roster, keyed by author id.
 * @param props.children - The message body this answers for.
 */
export function MentionRosterProvider({
  authors,
  children,
}: {
  authors: ReadonlyMap<string, RosterAuthor>;
  children: ReactNode;
}) {
  return <MentionRosterContext.Provider value={authors}>{children}</MentionRosterContext.Provider>;
}

/**
 * The roster's entry for one mentioned author, as of right now.
 *
 * `undefined` for an id the roster no longer holds — somebody who has left —
 * for a tag that carried no id at all, and anywhere no provider is mounted. All
 * three mean the same thing to a caller: nobody here can vouch for this name,
 * so do not draw a pill that claims otherwise.
 *
 * @param authorId - The id the `<mention>` tag carried.
 */
export function useMentionAuthor(authorId: string | undefined): RosterAuthor | undefined {
  const authors = useContext(MentionRosterContext);
  return authorId === undefined ? undefined : authors.get(authorId);
}

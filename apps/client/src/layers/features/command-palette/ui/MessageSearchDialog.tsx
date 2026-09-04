/**
 * The message-search box — ⌘⇧F, the second search surface (spec
 * `message-search` §8, **G4**).
 *
 * **⌘K and this are different questions, and they stay different boxes.** ⌘K
 * finds a thing by what it is CALLED: an agent, a channel, a conversation, an
 * action. This finds a thing by what was SAID inside it. Slack keeps the two
 * apart, Teams merged them, and `specs/rooms` §13.2 recorded that separation as
 * load-bearing before there was an index to make this box possible. So this is
 * a sibling of the palette, sharing its keyboard model and none of its list.
 *
 * **The box says what it can and cannot see, in every state, on one line.**
 * That is G4, and it is a product commitment rather than a caption: tool output
 * is never indexed, transcripts lag a sweep behind, and a fragment that is not
 * a word matches nothing. A person has to be able to LEARN all three without
 * reading a spec — which is not the same as being made to read them before
 * typing, so the detail sits behind the line's own disclosure and opens itself
 * when a search comes back empty (DOR-1757).
 *
 * **Enter lands on the message in a channel, and opens the conversation for a
 * transcript** (DOR-687). The asymmetry is a coordinate one rather than a
 * priority one, and `message-search-target.ts` is where it is argued: a room
 * hit's `ordinal` is the entry `seq` a room already addresses its rows by, and
 * a transcript hit's `ordinal` counts only the messages the index kept, so it
 * points at nothing the session view can find. Landing in the conversation is
 * the promise this cockpit can keep there every time.
 *
 * @module features/command-palette/ui/MessageSearchDialog
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertCircle, Info } from 'lucide-react';
import type { SearchHit } from '@dorkos/shared/search-schemas';
import { cn, platformCanSearchMessages } from '@/layers/shared/lib';
import { useAppStore, useIsMobile, useTransport } from '@/layers/shared/model';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandList,
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTitle,
  ScrollArea,
} from '@/layers/shared/ui';
import { useRooms } from '@/layers/entities/room';
import { MessageSearchHitRow } from './MessageSearchHitRow';
import { MessageSearchScope } from './MessageSearchScope';
import { dialogVariants } from './palette-constants';
import { SEARCH_PLACEHOLDER, SEARCH_TOO_SHORT } from '../model/message-search-scope';
import { messageSearchContainerLabel, messageSearchTarget } from '../model/message-search-target';
import { useMessageSearch } from '../model/use-message-search';
import { useMessageSearchShortcut } from '../model/use-message-search-shortcut';

/** `<kbd>` styling, matching the palette's own footer. */
const KBD_CLASS = 'bg-muted rounded px-1 py-0.5 font-mono text-3xs' as const;

/**
 * The search box, where there is something behind it to search.
 *
 * **Only where there is an index behind it, and this is the gate rather than a
 * detail.** `App.tsx` is the Obsidian embed's shell as well as the browser's, so
 * mounting this unconditionally once put the box inside a window with no index:
 * `DirectTransport.search` rejects, and every line of the coverage statement is
 * false. What a person got there was a box that listed four kinds of thing it
 * searches, took two characters and a debounce to admit it searches none of
 * them, and advertised itself from ⌘K's last row on the way in. A surface that
 * cannot do the thing should not be offered, which is the same rule the
 * hand-off row was built on and the same one the demo-claim gate states.
 *
 * **What changed is who can answer yes** (DOR-1563). The question used to be
 * "are we in the embed"; it is now "does this window have an index", which the
 * Obsidian plugin answers for itself by opening one — or not, on a machine where
 * DorkOS has never run, or an Obsidian it carries no SQLite build for.
 *
 * The gate is a wrapper rather than an early return inside the component so no
 * hook is conditional — in particular ⌘⇧F is never BOUND where the box cannot
 * open, rather than bound and made to open something inert.
 *
 * Everything else lives in {@link MessageSearchBox}.
 */
export function MessageSearchDialog() {
  // Fixed at bootstrap (`setPlatformAdapter` in the Obsidian view, which opens
  // the index first) and never changes for the life of the app, so this branch
  // is stable and the hooks below it are not conditional in practice.
  if (!platformCanSearchMessages()) return null;
  return <MessageSearchBox />;
}

/**
 * The box itself.
 *
 * Mounted once beside {@link CommandPaletteDialog}. It holds no query while it
 * is closed — `useMessageSearch` is handed `enabled` — so a cockpit sitting
 * idle is not keeping a search subscription warm.
 */
function MessageSearchBox() {
  // ⌘⇧F lives with the surface it opens, the same way ⌘K lives with the
  // palette: one component owns the key and the box it raises, so neither can
  // ship without the other.
  useMessageSearchShortcut();

  const open = useAppStore((s) => s.messageSearchOpen);
  const seededQuery = useAppStore((s) => s.messageSearchQuery);
  const setOpen = useAppStore((s) => s.setMessageSearchOpen);
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const transport = useTransport();

  const [query, setQuery] = useState('');

  // Opening resets the box to whatever it was opened WITH — the words ⌘K's
  // hand-off row carried across, or nothing. A search box that reopened holding
  // last week's question would be answering nobody, and the alternative
  // (restoring the last query) is a stale answer wearing a fresh box.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seeding the box from the open signal that carried the query
    if (open) setQuery(seededQuery ?? '');
  }, [open, seededQuery]);

  const { results, warnings, tooShort, isSearching, error, submitted } = useMessageSearch(
    query,
    open
  );

  // The same cache entry `usePaletteRooms` reads, so naming a room costs no
  // request: archived rooms are included because a hit in a closed channel is
  // still a hit, and "which room was that in" is exactly the question somebody
  // has when the room is closed.
  const { data: rooms } = useRooms({ includeArchived: true });
  const roomTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const room of rooms ?? []) {
      // A channel is known by the name you would type; a direct message is
      // known by who it is with.
      titles.set(room.id, room.kind === 'channel' && room.slug ? `#${room.slug}` : room.title);
    }
    return titles;
  }, [rooms]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  /**
   * Go to the hit — the message itself in a channel, its conversation in a
   * transcript.
   *
   * A room's transcript and a conversation's transcript are both readable
   * whatever else has happened, so this navigates first and asks questions
   * after. The question it asks is §6.4's: a conversation whose working
   * directory has been deleted is still indexed and still readable, and what
   * changes is that the open action REPORTS the directory is gone rather than
   * failing on a path. The check is fired alongside the navigation rather than
   * in front of it, so a live directory costs nothing and a dead one costs a
   * line of explanation instead of a broken screen.
   *
   * **Only a 404 means "gone", and the distinction is not pedantry.**
   * `GET /api/directory` refuses for four different reasons: `404` for `ENOENT`
   * (the §6.4 case), `403` for a path outside the configured boundary or one
   * the server may not read, `400` for a path that is not a directory, and
   * `500` for anything else. Treating all four as "gone" told somebody their
   * folder had been deleted when it is sitting there — and the sentence's
   * second half, *you can still read this conversation*, is false in exactly
   * those cases, because the boundary that refused this probe refuses the
   * session stream too. It is reachable: a `/private/tmp` working directory is
   * outside a normal boundary, and nine of the thirty-three vanished paths the
   * spec measured were temp directories. So the narrow claim is made only on
   * the status that supports it, and everything else gets a sentence that is
   * true without knowing why.
   */
  const openHit = useCallback(
    (hit: SearchHit) => {
      const target = messageSearchTarget(hit);
      close();
      void navigate({ to: target.to, search: target.search });

      if (target.kind === 'session' && hit.containerPath !== null) {
        const path = hit.containerPath;
        void transport.browseDirectory(path).catch((err: unknown) => {
          // `HttpTransport` puts the response status on the thrown error; a
          // transport that does not (or a network failure, which has no status
          // at all) falls to the narrow sentence rather than to the confident
          // one.
          const status = (err as { status?: number } | null)?.status;
          if (status === 404) {
            toast.info('That folder is gone', {
              description: `You can still read this conversation, but ${path} no longer exists, so nothing new can run there.`,
            });
            return;
          }
          toast.info('DorkOS could not open that folder', {
            description: `Something stopped DorkOS reading ${path}. The conversation may not open.`,
          });
        });
      }
    },
    [close, navigate, transport]
  );

  const hasResults = results.length > 0;

  // A real question was asked and nothing came back. It is the one state where
  // the fine print is the answer rather than a caption — "search matches whole
  // words" explains an empty list, and nothing else on screen does — so the
  // scope statement opens itself here and stays one line everywhere else.
  const foundNothing =
    !hasResults && !tooShort && !isSearching && submitted.trim().length > 0 && error === null;

  // The disclosure's own open/closed state, deliberately NOT gated on
  // `isSearching` the way the sentence above it is. `submitted` and `results`
  // are already answered-query-only (`use-message-search.ts:143-152`), so
  // "no hits for the question now in the box" does not need to wait for the
  // in-flight request to settle before it is true. Gating this on `isSearching`
  // made every debounce round-trip an open/close cycle while someone was still
  // typing a query that never matches — an animated accordion, with the input
  // itself riding 44px up and down under the caret, on every keystroke. The
  // sentence keeps its own gate (a "no messages match" claim should wait for
  // the answer); the panel does not need to, because closing and reopening it
  // says nothing an open panel does not already say.
  const noAnswerYet = !hasResults && !tooShort && submitted.trim().length > 0 && error === null;

  return (
    <ResponsiveDialog open={open} onOpenChange={setOpen}>
      <ResponsiveDialogContent
        data-testid="message-search-dialog"
        className={cn(
          '!min-h-0 max-w-[560px] overflow-hidden p-0',
          '[&>button:last-child]:top-2 [&>button:last-child]:right-2.5',
          isMobile && 'h-[85vh]'
        )}
      >
        <ResponsiveDialogTitle className="sr-only">Search your messages</ResponsiveDialogTitle>
        <motion.div
          variants={dialogVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
          className={cn('flex overflow-hidden', isMobile && 'h-full flex-col')}
        >
          <Command
            loop
            // The route ranked these. cmdk's own filter would re-filter them by
            // the typed string and drop every hit whose excerpt does not
            // literally contain it — which is most of them, since matching is
            // by word stem.
            shouldFilter={false}
            className={cn(
              'min-w-0 flex-1',
              isMobile &&
                'flex flex-col [&_[cmdk-list]]:max-h-none [&_[cmdk-list]]:flex-1 [&_[cmdk-list]]:overflow-y-auto'
            )}
          >
            <CommandInput
              // Found by test id, never by placeholder: the placeholder is
              // user-facing copy and this cockpit has several other cmdk roots.
              data-testid="message-search-input"
              placeholder={SEARCH_PLACEHOLDER}
              value={query}
              onValueChange={setQuery}
            />
            {/*
             * Everything that is not a ROW lives outside `CommandList`, and
             * that is an accessibility fix rather than a layout preference.
             * cmdk renders the list as `role="listbox"`, whose only permitted
             * children are options and groups — a screen reader in listbox mode
             * walks options and skips the rest, so the scope statement, the
             * degradation notice and the empty-state sentences were all
             * inaudible from inside it. The G4 commitment is that a person can
             * LEARN what search does not cover; a paragraph a screen reader
             * refuses to read does not meet it.
             */}
            {error !== null && (
              <p className="text-destructive flex items-start gap-2 px-3 py-3 text-xs leading-relaxed">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{error.message}</span>
              </p>
            )}

            {/* A source that is behind gets ONE quiet line, not a toast. It
                qualifies an answer that is already on screen; a toast would
                interrupt somebody reading it to say the same thing.
                `role="status"` so it is announced when it appears, since it
                changes what the list on screen means. */}
            {warnings.map((warning) => (
              <p
                key={warning.source}
                role="status"
                className="text-muted-foreground text-2xs flex items-start gap-2 px-3 pt-2 leading-relaxed"
              >
                <Info className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span>{warning.message}</span>
              </p>
            ))}

            <CommandList>
              <ScrollArea className="h-full">
                {hasResults && (
                  <CommandGroup
                    // Dimmed, not replaced. The rows on screen answer the
                    // previous keystroke and are still useful; swapping them
                    // for a spinner would take away the only thing there is
                    // to read for the length of a request.
                    className={cn('transition-opacity duration-150', isSearching && 'opacity-60')}
                  >
                    {results.map((hit) => {
                      const key = `${hit.source}:${hit.container}:${hit.ordinal}`;
                      return (
                        <MessageSearchHitRow
                          key={key}
                          value={key}
                          hit={hit}
                          containerLabel={messageSearchContainerLabel(hit, roomTitles)}
                          onSelect={() => openHit(hit)}
                        />
                      );
                    })}
                  </CommandGroup>
                )}
              </ScrollArea>
            </CommandList>

            {/* One statement in every state, at one line unless somebody asks
                for more. Nothing to show has two different reasons and they get
                two different sentences, because an empty list looks identical
                in both. Capped and scrollable so a short window still reaches
                the footer. */}
            {error === null && (
              <div className="max-h-[45vh] min-h-0 shrink-0 overflow-y-auto">
                {tooShort && (
                  <p className="text-muted-foreground px-3 pt-3 text-xs">{SEARCH_TOO_SHORT}</p>
                )}
                {foundNothing && (
                  <p className="text-muted-foreground px-3 pt-3 text-xs">
                    No messages match “{submitted.trim()}”.
                  </p>
                )}
                <MessageSearchScope detailOpen={noAnswerYet} />
              </div>
            )}
            <div className="text-muted-foreground flex flex-shrink-0 items-center gap-3 border-t px-3 py-1.5 text-xs">
              <span className="inline-flex items-center gap-1">
                <kbd className={KBD_CLASS}>{'↑↓'}</kbd>
                Navigate
              </span>
              <span className="inline-flex items-center gap-1">
                <kbd className={KBD_CLASS}>Enter</kbd>
                Open
              </span>
              {/* Not the ⌘⇧F hint: you are already in the box it opens. That
                  key is announced where it is discovered — ⌘K's hand-off row
                  and the shortcuts panel. */}
              <span className="ml-auto inline-flex items-center gap-1">
                <kbd className={KBD_CLASS}>esc</kbd>
                Close
              </span>
            </div>
          </Command>
        </motion.div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

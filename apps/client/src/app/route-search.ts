import { z } from 'zod';
import { agentFilterSchema, ATTENTION_SORT_FIELD } from '@/layers/features/agents-list';
import { marketplaceSearchSchema } from '@/layers/features/marketplace';
import { mergeDialogSearch } from '@/layers/shared/model/dialog-search-schema';
import { DEFAULT_TEAM_VIEW, LEGACY_TABLE_VIEW, TEAM_VIEWS } from '@/layers/shared/lib';

// ── Search param schemas ────────────────────────────────────

/**
 * `?entry=` — the `seq` of the one message a room should land on.
 *
 * **Shared by both addresses a room is read at**, so it is written once here
 * rather than twice: `/channels?id=…&entry=…` and `/?entry=…` mean the same
 * thing, and the team-room redirect carries it from the first to the second.
 * A message-search hit is where it comes from — a room hit's `ordinal` IS the
 * entry's `seq` (`SearchHitSchema`), so the coordinate the index already
 * returns needs no new field to become an address.
 *
 * `.catch(undefined)` rather than throwing, for the reason every other enum on
 * these routes catches: a URL is something a person can hand-edit and a link
 * can outlive. `?entry=banana` lands in the room with nothing highlighted,
 * never on a Zod dump where the room should be.
 */
const roomEntrySeqParam = z.coerce.number().int().min(1).optional().catch(undefined);

/**
 * Search params for `/` — the home tab, which renders the #team room.
 *
 * `detail` + `itemId` are the attention deep links: a row in the pinned triage
 * header addresses `/?detail=failed-run&itemId=…`, and that URL opens the same
 * sheet for whoever it is pasted to.
 *
 * `thread` is the room's own param, spelled exactly as `/channels` spells it
 * (`channelsSearchSchema`) and meaning exactly the same thing — the entry a
 * thread hangs off. Home IS a room, so a thread opened here needs an address
 * for the same reason one opened there does: a refresh, or a link handed to
 * somebody, has to land on it.
 *
 * `entry` is the room's other shared param, spelled and meaning exactly what
 * `/channels` spells it: the `seq` of the message to land on. Home is reached
 * with one on it because `/channels?id=<team>&entry=…` redirects here, so a
 * search hit in #team has to keep its coordinate across the move.
 *
 * There is deliberately no room `id`: home is #team and nothing else. The room
 * is found by its well-known key, so a renamed channel — or a URL somebody
 * edited — cannot point Home at a different conversation.
 *
 * `detail` `.catch()`es rather than throwing, for the reason `teamSearchSchema`
 * gives below and one more: this is the address the app OPENS on. A stale
 * bookmark naming a sheet that no longer exists must show the room with no
 * sheet over it, not a "Something went wrong" page with a raw Zod dump where
 * the app should be.
 *
 * @internal Exported for testing only.
 */
export const homeSearchSchema = mergeDialogSearch(
  z.object({
    detail: z.enum(['dead-letter', 'failed-run', 'offline-agent']).optional().catch(undefined),
    itemId: z.string().optional(),
    thread: z.string().optional(),
    entry: roomEntrySeqParam,
  })
);

/** Search params available on the `/` (home) route. */
export type HomeSearch = z.infer<typeof homeSearchSchema>;

/**
 * Search params for `/team` — and, unchanged, for the `/agents` alias, so the
 * redirect hands on an object the destination has already validated.
 *
 * `view` accepts `'list'` and answers `'table'`. That is not politeness toward
 * an old spelling: `/agents?view=list` is an address this repo does not own —
 * the media-capture pipeline opens it by hand, and so do bookmarks and old
 * release notes — so it normalizes rather than 404s.
 *
 * `sort` and the `agentFilterSchema` params are retained from the route this
 * replaces: the table view is the same fleet table, and its filter bar reads
 * them straight out of the URL.
 *
 * **Every enum here `.catch()`es rather than throwing.** A URL is something a
 * person can hand-edit, a bookmark can preserve past a rename, and an old
 * release note can outlive. A value this route no longer knows is a stale
 * address, not a broken app, so it falls back to the default and shows the
 * roster — the same forgiving read `normalizeTeamView` documents. Without this
 * the route threw, and `?view=bogus` rendered a "Something went wrong" page
 * with a raw Zod dump on it.
 *
 * @internal Exported for testing only.
 */
export const teamSearchSchema = mergeDialogSearch(
  z
    .object({
      view: z.preprocess(
        (value) => (value === LEGACY_TABLE_VIEW ? 'table' : value),
        z.enum(TEAM_VIEWS).catch(DEFAULT_TEAM_VIEW)
      ),
      /** The filter chips: everyone, only people, only agents. */
      kind: z.enum(['all', 'people', 'agents']).catch('all'),
      /** A person's roster id — narrows to them and the agents they own. */
      owner: z.string().optional(),
      /** Whether agent cards cluster under the person they belong to. */
      group: z.enum(['none', 'manager']).catch('none'),
      /** The roster search box. */
      q: z.string().optional(),
      // No `member` param, despite spec §W2.1 listing one for the profile
      // drawer: the drawer shipped on the app-wide `?profile=` param that
      // `dialogSearchSchema` already merges in (§W3.2, DOR-977). A second
      // address for the same subject is one that can disagree with the first.
      //
      // Attention order is the table's default: the agents that need you lead,
      // and the rows group by state. Any other field flattens the groups.
      sort: z.string().optional().default(`${ATTENTION_SORT_FIELD}:asc`),
      agent: z.string().optional(), // selected agent ID for topology detail panel
    })
    .merge(agentFilterSchema.searchValidator)
);

export const marketplaceRouteSearchSchema = mergeDialogSearch(marketplaceSearchSchema);

/** Search params available on the `/marketplace` route. */
export type MarketplaceSearch = z.infer<typeof marketplaceRouteSearchSchema>;

export const channelsSearchSchema = mergeDialogSearch(
  z.object({
    id: z.string().optional(),
    community: z.string().min(1).optional(),
    thread: z.string().optional(),
    entry: roomEntrySeqParam,
  })
);

/** Search params available on the `/channels` route. */
export type ChannelsSearch = z.infer<typeof channelsSearchSchema>;
export const connectionsSearchSchema = mergeDialogSearch(
  z.object({
    app: z.string().min(1).optional(),
    review: z.string().min(1).optional(),
    flow: z.string().min(1).optional(),
    request: z.string().min(1).optional(),
  })
);
export const activitySearchSchema = mergeDialogSearch(
  z.object({
    categories: z.string().optional(),
    actorType: z.string().optional(),
    actorId: z.string().optional(),
    since: z.string().optional(),
  })
);

/** Search params available on the `/activity` route. */
export type ActivitySearch = z.infer<typeof activitySearchSchema>;

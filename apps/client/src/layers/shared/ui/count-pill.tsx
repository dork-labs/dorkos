/**
 * The one numbered pill: how many things are waiting, and for whom.
 *
 * `CountPill` lives in `@dork-labs/ui` so the app and the Space pages draw the
 * same count. This file re-exports it for the app's layers and adds the one
 * cap that needs the server's schemas.
 *
 * @module shared/ui/count-pill
 */
import { ROOM_MENTION_COUNT_CAP } from '@dorkos/shared/room-schemas';

export {
  CountPill,
  COUNT_PILL_CAP,
  CORNER_COUNT_CAP,
  formatPillCount,
  type CountPillProps,
  type CountPlacement,
  type CountTone,
} from '@dork-labs/ui/count-pill';

/**
 * The largest mention count a pill spells out. The server stops counting
 * mentions at {@link ROOM_MENTION_COUNT_CAP}, so its `10` means "10 or more",
 * and the pill draws that as `9+` rather than claim a number nobody measured.
 */
export const MENTION_COUNT_CAP = ROOM_MENTION_COUNT_CAP - 1;

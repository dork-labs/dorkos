/**
 * The board #team starts with — one pinned widget on the room's canvas
 * (spec `room-canvas` D13).
 *
 * **It is an example, not a primitive.** Nothing in DorkOS reads this document
 * back, nothing depends on its shape, and no schema was added for it: it is an
 * ordinary `widget` on an ordinary room canvas, pinned like anything else. What
 * it does is show a person what the canvas is FOR on the day they first open the
 * app, and give any agent in the room something concrete to change — the whole
 * board is one `update_canvas` away from saying whatever the room actually needs
 * it to say.
 *
 * **No invented numbers.** The one thing a board like this must never do is put
 * a figure on screen that nothing measured. So the seed is a checklist of things
 * a person can do next — the same openers the room already offers above the
 * composer — and not a dashboard of zeros waiting to be filled in.
 *
 * **Seeded exactly once, when #team is created.** Not "when the canvas is
 * empty": a person who takes the board off their table has decided something,
 * and a board that came back on the next restart would be the app arguing with
 * them. The room is created once per install, so the seed runs once per install.
 *
 * @module server/services/rooms/team-board
 */
import type { UiCanvasContent } from '@dorkos/shared/schemas';

/** What the board is called, on its tab and in its own heading. */
export const TEAM_BOARD_TITLE = 'Team board';

/**
 * The board as it ships.
 *
 * Three steps, in the order somebody actually takes them: find out what the
 * agents you already have are good for, get one of your own, then make it happen
 * without you. They are the same three the room offers above the composer on day
 * one, which is deliberate — one idea said twice in one place beats two lists
 * that drift apart.
 */
export function seedTeamBoard(): UiCanvasContent {
  return {
    type: 'widget',
    title: TEAM_BOARD_TITLE,
    definition: {
      version: 1,
      title: TEAM_BOARD_TITLE,
      root: {
        type: 'card',
        title: TEAM_BOARD_TITLE,
        description: 'Everyone in this room can see this, and any agent here can rewrite it.',
        children: [
          {
            type: 'checklist',
            items: [
              {
                label: 'Find out what your agents can do',
                note: 'Ask in the box below — they answer here, where everyone can see it.',
              },
              {
                label: 'Make your first agent',
                note: 'Say what you want it to be good at and one of them will set it up.',
              },
              {
                label: 'Set up a daily run',
                note: 'Give an agent something to do every morning without you.',
              },
            ],
          },
          {
            type: 'text',
            text: 'Tell an agent what this board should say and it will change it for everybody.',
          },
        ],
      },
    },
  };
}

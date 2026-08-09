/**
 * Day one in #team: what to say first.
 *
 * Onboarding here is a conversation, not a board of empty cards
 * (team-room-home spec D3.6). These are the opening lines, and they are lines —
 * pressing one writes it into the composer, where it can be edited, added to or
 * thrown away before anything is sent. None of them opens a wizard.
 *
 * @module widgets/home/lib/starter-chips
 */

/**
 * The four openers offered above the composer on a room with nothing in it yet.
 *
 * Four, because that is what the chip row draws before it starts wrapping, and
 * short, because a chip that truncates hides the very words it is offering. Each
 * one is something a person actually wants on their first morning: what this
 * thing does, how to get an agent of their own, what it can see, and how to make
 * it happen without them.
 */
export const HOME_STARTER_CHIPS: readonly string[] = [
  'What can you help with?',
  'Make my first agent',
  "What's in this project?",
  'Set up a daily run',
];

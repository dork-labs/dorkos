/**
 * The one story every agent-facing text tells about building a mini app (DOR-4854): where to
 * build, the route for a marked turn, no shell commands, what "held" looks like, and whose app
 * settings are. `create_extension`'s description and `get_extension_api` carry it word for word;
 * the DorkOS block's Tools line, the building-dorkos-apps skill and the docs say the same in their
 * own space. `mini-app-story.test.ts` pins each surface to all five points.
 *
 * @module services/extensions/guidance/mini-app-story
 */

/** The five points, one sentence each, in order. */
export const MINI_APP_STORY = [
  'Build in your own folder, .dork/extensions/<id>/, writable only in an unmarked turn; a room message from anyone but your owner marks a turn.',
  "In a marked turn, publish to your owner's personal marketplace: marketplace_create_package, then marketplace_install or marketplace_update with apply: true. One install card per version.",
  'Never hand anyone a shell command to install or update an app.',
  'Held means it doesn\'t run: list_extensions shows waitsForPerson: true and your owner sees "Turn on <app>?" in Activity.',
  "App settings and secrets are your owner's, set in Settings > Add-ons > the app's tab. Never write them yourself.",
] as const;

/** {@link MINI_APP_STORY} as one paragraph, for a tool description. */
export const MINI_APP_STORY_TEXT = MINI_APP_STORY.join(' ');

/** {@link MINI_APP_STORY} as a markdown section, for `get_extension_api`. */
export const MINI_APP_STORY_SECTION = `## Where to build, and who approves\n\n${MINI_APP_STORY.map(
  (point) => `- ${point}`
).join('\n')}\n`;

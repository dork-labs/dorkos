/**
 * The one story every agent-facing text tells about building a mini app (DOR-4854): where to
 * build, the route for a marked turn, no shell commands, what "held" looks like, and whose app
 * settings are. `create_extension`'s description and `get_extension_api` carry it word for word;
 * the DorkOS block's Tools line, the building-dorkos-apps skill and the docs say the same in their
 * own space. `mini-app-story.test.ts` pins one phrase per point on each surface but the Tools line,
 * which has room only to name the work.
 *
 * @module services/extensions/guidance/mini-app-story
 */

/** The five points, in order. */
export const MINI_APP_STORY = [
  'Build in your own folder, .dork/extensions/<id>/. It is writable only in an unmarked turn; words from outside your team (another person in the room, Telegram, Slack, a web page) mark one.',
  "In a marked turn, publish to your owner's personal marketplace: marketplace_create_package, write the app into it, raise version in plugin.json, manifest.json and extension.json, then marketplace_install or marketplace_update with apply: true. One install card per version.",
  'Never hand anyone a shell command to install or update an app.',
  'Held means some or all of it won\'t run: list_extensions shows waitsForPerson: true and your owner sees "Turn on <app>?" in Activity. Server code asks there after each version.',
  "App settings and secrets are your owner's, set in Settings > Add-ons on the app's tab once it runs. Never write them yourself.",
] as const;

/** {@link MINI_APP_STORY} as one paragraph, for a tool description. */
export const MINI_APP_STORY_TEXT = MINI_APP_STORY.join(' ');

/** {@link MINI_APP_STORY} as a markdown section, for `get_extension_api`. */
export const MINI_APP_STORY_SECTION = `## Where to build, and who approves\n\n${MINI_APP_STORY.map(
  (point) => `- ${point}`
).join('\n')}\n`;

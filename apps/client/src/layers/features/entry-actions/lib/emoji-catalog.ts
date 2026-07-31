/**
 * The emoji the picker offers, and how to search them.
 *
 * **A curated list rather than a dependency.** The obvious alternative is an
 * emoji-picker package, and every one of them brings the whole Unicode set with
 * localized keyword indexes — hundreds of kilobytes and a component with its own
 * theming, in an app whose picker needs a grid of buttons and a text field. What
 * is here is the set people actually reach for in a room: roughly two hundred
 * entries with the words they would type to find them, in one file a person can
 * read and add to. If a reaction someone wants is missing, adding it is one line
 * — which is the honest trade, and the one the server already assumes by storing
 * the emoji as a string rather than as an enum.
 *
 * Ordering inside a group is deliberate: the ones a reader is most likely to
 * want come first, so the grid reads top-left to bottom-right by usefulness.
 *
 * **The FIRST keyword of each line is that emoji's name**, and it has to be
 * unique across the whole catalog: {@link emojiLabel} hands it to `aria-label`,
 * so two emoji sharing one leads to two buttons in the same grid that a screen
 * reader announces identically — and to a "React with heart" that could mean
 * four different pills. `emoji-catalog.test.ts` pins it.
 *
 * @module features/entry-actions/lib/emoji-catalog
 */

/** One emoji and the words that find it. */
export interface EmojiEntry {
  /** The emoji itself, exactly as it will be stored. */
  emoji: string;
  /** Lowercase words a search matches against, most descriptive first. */
  keywords: string[];
}

/** A named run of emoji, as the picker draws them. */
export interface EmojiGroup {
  /** What the group is called above its grid. */
  name: string;
  /** Its emoji, in the order they are drawn. */
  entries: EmojiEntry[];
}

/**
 * The source form: one string per emoji, the emoji first and its search words
 * after. Written this way so the list stays readable and diffs stay one line per
 * emoji — the parsed shape is built once, below.
 */
const SOURCE: Record<string, string[]> = {
  'Yes, no, and thanks': [
    '👍 thumbsup thumbs up yes approve like agree ok good',
    '❤️ heart love red',
    '🎉 tada party celebrate congrats hooray confetti',
    '👀 eyes look watching seen reading review',
    '🚀 rocket ship launch ship-it fast deploy',
    '🙏 pray thanks thank you please folded hands',
    '🔥 fire lit hot flame burn',
    '💯 hundred perfect score full agree',
    '✅ check tick done complete yes correct',
    '❌ cross no wrong incorrect fail',
    '👎 thumbsdown thumbs down no disagree bad',
    '🙌 raised hands celebrate praise hooray',
    '👏 clap applause bravo well done',
    '🤝 handshake deal agreed partnership',
    '💪 muscle strong flex power',
    '🫡 salute yes sir acknowledged on it',
    '✨ sparkles shiny new magic nice',
    '⭐ star favourite favorite rating',
    '🏆 trophy win won champion award',
    '🎯 target bullseye exactly precise nailed it',
  ],
  Faces: [
    '😀 grin smile happy',
    '😄 smile happy laugh joy',
    '😂 joy laugh crying laughing funny lol',
    '🤣 rofl rolling laughing hilarious',
    '🙂 slight smile fine ok',
    '😊 blush smile warm happy',
    '😉 wink joking',
    '😍 heart-eyes love adore',
    '🤩 star-struck amazed wow',
    '😎 sunglasses cool smooth',
    '🥳 party face celebrate birthday',
    '🤔 thinking hmm consider wondering',
    '🧐 monocle inspect examine scrutiny',
    '😅 sweat smile nervous phew close call',
    '😬 grimace awkward yikes',
    '😱 scream shocked horror fear',
    '😮 surprised open mouth wow',
    '🤯 mind blown exploding head whoa',
    '😴 sleeping asleep tired zzz',
    '🥱 yawn bored tired',
    '😐 neutral meh straight face',
    '🙄 eye roll unimpressed whatever',
    '😤 triumph frustrated steam determined',
    '😢 cry sad tear upset',
    '😭 sob crying loudly devastated',
    '😡 angry rage mad furious',
    '🤒 sick ill fever unwell',
    '🤖 robot bot agent automation machine',
    '👻 ghost boo spooky',
    '🤡 clown silly foolish',
    '😇 innocent halo angel',
    '🥲 tear smile bittersweet',
    '🫠 melting overwhelmed hot dissolving',
    '🤷 shrug dunno who knows unsure',
  ],
  'Hands and people': [
    '👋 wave hello hi bye greeting',
    '🤙 call me shaka hang loose',
    '✌️ peace victory two',
    '🤞 fingers crossed hope luck',
    '🫰 finger heart love money',
    '👌 ok perfect fine good',
    '🤌 pinched fingers italian chef what',
    '☝️ point-up one first attention',
    '👇 point-down below beneath',
    '👉 point-right this next',
    '👈 point-left back previous',
    '✋ hand stop halt raised',
    '🖐️ open-hand five stop',
    '🫶 heart-hands love care',
    '🧠 brain smart thinking mind idea',
    '👨‍💻 developer coding programmer engineer',
    '🕺 dancing celebrate dance',
    '🏃 running run fast hurry',
  ],
  'Hearts and symbols': [
    '🧡 orange heart love',
    '💛 yellow heart love',
    '💚 green heart love',
    '💙 blue heart love',
    '💜 purple heart love',
    '🖤 black heart love dark',
    '🤍 white heart love',
    '💔 broken heart sad hurt',
    '💖 sparkling heart love shiny',
    '❣️ heart-exclamation love',
    '⚡ zap lightning fast power energy',
    '💥 boom explosion collision impact',
    '💫 dizzy stars sparkle',
    '⚠️ warning caution careful alert',
    '🚨 siren alert emergency urgent incident',
    '🛑 stop sign halt blocked',
    '♻️ recycle reuse refresh retry',
    '🔒 lock secure locked private',
    '🔓 unlock open unlocked',
    '💡 idea bulb lightbulb suggestion insight',
    '❓ question ask unknown what',
    '❗ exclamation important attention',
    '➕ plus add more increase',
    '➖ minus remove less decrease',
    '🆗 ok-button fine approved',
    '🆕 new fresh',
    '🔁 repeat loop again retry',
    '⏳ hourglass waiting time slow pending',
    '⏰ alarm clock time deadline reminder',
    '📈 chart-up growth increase improving',
    '📉 chart-down decline decrease regression',
  ],
  'Work and things': [
    '💻 laptop computer code work',
    '🖥️ desktop monitor screen',
    '📱 phone mobile device',
    '⌨️ keyboard typing input',
    '🐛 bug defect issue error broken',
    '🔧 wrench fix repair tool',
    '🔨 hammer build fix construct',
    '🛠️ tools build fix maintenance',
    '⚙️ gear settings config machinery',
    '🧪 test experiment lab trial',
    '🧹 broom clean cleanup sweep tidy',
    '📦 package box shipment release module',
    '🚢 ship shipping deploy release',
    '🗑️ trash delete remove bin',
    '📝 memo note write document',
    '📋 clipboard copy list checklist',
    '📌 pin pinned important stick',
    '📎 paperclip attach link',
    '🔍 magnifying search find look investigate',
    '🔗 link url chain reference',
    '🗓️ calendar date schedule plan',
    '⏱️ stopwatch timing performance speed',
    '🔔 bell notify notification alert ping',
    '🔕 bell-off mute silent quiet',
    '📮 mail post send inbox',
    '🧾 receipt invoice record log',
    '🗂️ files folders organise organize',
    '🔑 key access secret credential',
    '🧱 brick wall block foundation',
    '🪵 log wood timber',
    '🧯 extinguisher hotfix incident fire put out',
    '🩹 bandage patch fix quick',
    '🔮 crystal ball predict future guess',
    '🧭 compass direction navigate guide',
    '🪄 magic wand automatic magically',
  ],
  'Food and drink': [
    '☕ coffee cafe morning caffeine',
    '🍵 tea green matcha',
    '🍺 beer pint drink cheers',
    '🍻 cheers beers toast celebrate',
    '🥂 champagne toast celebrate cheers',
    '🍕 pizza food slice',
    '🍔 burger food hamburger',
    '🌮 taco food mexican',
    '🍜 noodles ramen soup food',
    '🍎 apple fruit food',
    '🍌 banana fruit food',
    '🍰 cake dessert birthday sweet',
    '🍪 cookie biscuit sweet snack',
    '🍩 donut doughnut sweet',
    '🧁 cupcake sweet dessert',
    '🍫 chocolate sweet treat',
    '🍿 popcorn watching drama entertainment',
    '🥑 avocado food green',
    '🌶️ chilli chili spicy hot pepper',
    '🧊 ice cold frozen chill',
  ],
  'Animals and nature': [
    '🐶 dog puppy pet',
    '🐱 cat kitten pet',
    '🦊 fox clever',
    '🐻 bear',
    '🐼 panda',
    '🐢 turtle slow tortoise',
    '🐌 snail slow',
    '🐝 bee busy buzz',
    '🦋 butterfly transform pretty',
    '🐙 octopus multitask arms',
    '🐳 whale big ocean',
    '🦄 unicorn rare magic special',
    '🦉 owl wise night',
    '🐘 elephant big memory',
    '🌱 seedling growth new sprout',
    '🌳 tree nature growth',
    '🌸 blossom flower spring',
    '🌊 ocean wave water sea',
    '🌈 rainbow colour color pride hope',
    '☀️ sun sunny bright day',
    '🌙 moon night late evening',
    '⛈️ storm thunder rain bad weather',
    '❄️ snowflake cold snow winter freeze',
    '🍂 leaves autumn fall',
  ],
  'Places and travel': [
    '🏠 house home',
    '🏢 office building work',
    '🌍 earth world globe europe africa',
    '🌎 earth-americas world globe',
    '🗺️ map plan route territory',
    '✈️ plane flight travel',
    '🚗 car drive travel',
    '🚲 bike bicycle cycle',
    '🚂 train rail',
    '⛺ tent camping outdoors',
    '🏝️ island holiday vacation beach',
    '🏔️ mountain peak climb summit',
  ],
};

/** The picker's groups, parsed once from {@link SOURCE}. */
export const EMOJI_GROUPS: EmojiGroup[] = Object.entries(SOURCE).map(([name, lines]) => ({
  name,
  entries: lines.map((line) => {
    const [emoji, ...keywords] = line.split(' ');
    return { emoji: emoji!, keywords };
  }),
}));

/** Every emoji in the catalog, flat and in group order. */
const ALL_ENTRIES: EmojiEntry[] = EMOJI_GROUPS.flatMap((group) => group.entries);

/**
 * The emoji matching what somebody typed.
 *
 * Matched on keyword PREFIXES rather than fuzzily: typing "fi" should offer 🔥
 * (fire) and 🔧 (fix), and a fuzzy matcher at this list size mostly offers
 * surprises. Every word of the query has to match something, so "red heart"
 * narrows rather than widens. An emoji pasted in as the query finds itself,
 * which is how somebody re-uses one they copied from elsewhere.
 *
 * @param query - What is in the search field. Blank returns nothing, because the
 *   caller draws the full grouped grid in that case.
 * @returns Matching emoji, in catalog order.
 */
export function searchEmoji(query: string): EmojiEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return ALL_ENTRIES.filter(
    (entry) =>
      entry.emoji === query.trim() ||
      terms.every((term) => entry.keywords.some((keyword) => keyword.startsWith(term)))
  );
}

/**
 * The entry for one emoji, when the catalog holds it.
 *
 * @param emoji - The emoji to look up — a frequent from the server, say.
 */
function emojiEntry(emoji: string): EmojiEntry | undefined {
  return ALL_ENTRIES.find((entry) => entry.emoji === emoji);
}

/**
 * How an emoji is named for a screen reader and a tooltip.
 *
 * The catalog's first keyword when it has one, and the emoji itself when it does
 * not — a person may react with anything the server accepts, including something
 * this list has never heard of, and "React with 🫥" is a better label than a
 * blank one.
 *
 * @param emoji - The emoji being labelled.
 */
export function emojiLabel(emoji: string): string {
  return emojiEntry(emoji)?.keywords[0] ?? emoji;
}

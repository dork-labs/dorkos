import type { Beat } from './stage/beats';

/** A headline block: mono kicker, headline, one supporting line. */
export interface Block {
  eyebrow: string;
  title: string;
  lede: string;
}

/**
 * Every word on the home page, in one file.
 *
 * The page's whole argument is about six sentences long, and several of them
 * are settled. The 2026-10-07 message stack is three levels: the tagline
 * ("You, multiplied.", which closes this page), the headline "Build and run
 * your business with an agent team.", and the supporting line under it. The
 * beats below the hero then carry the three differentiators in order (mini
 * apps, built for founders, ownership). Keeping them here rather than
 * scattered through the components means the word budget is one thing you can
 * read end to end, and `__tests__/home-copy.test.ts` can hold the settled
 * lines still while the rest stays editable.
 *
 * One exception, and it is deliberate. The clips rail's words live with its
 * cards in `tutorials/tutorials.ts`, because that section is built to be
 * lifted whole into a sibling page that renames it: its copy and its card
 * list are one config object, and splitting them across two files would mean
 * re-theming the section in two places. The copy test sweeps that object into
 * the same checks as everything here, so nothing escapes the gates.
 */
/**
 * The hero: the headline and supporting line of the message stack.
 *
 * The eyebrow stays "for founders" rather than repeating the tagline: "You,
 * multiplied." is the close's headline, and saying it at both ends of a page
 * this short spends it. The eyebrow is also the one place above the fold that
 * names the audience, the second differentiator, which no beat carries.
 */
export const HERO: Block = {
  eyebrow: 'for founders',
  title: 'Build and run your business with an agent team.',
  lede: 'Your agents join your team chat, take on real work, and build the custom tools your company runs on.',
};

/**
 * What the pinned stage says at each of its three moments.
 *
 * The talk beat is table stakes: every workspace for people and agents has
 * channels and DMs, so it says what happens and claims no edge. The other two
 * carry the differentiators in order. "yours" is mini apps (an agent builds
 * an extension and it opens only after a person says yes, which is what the
 * chat shows), and "computer" is ownership. The ownership headline says
 * "yours", never where DorkOS runs, because DorkOS Cloud runs it on a server
 * too; the laptop the stage draws is the one place the page shows a computer.
 */
export const BEATS: Record<Beat, Block> = {
  talk: {
    eyebrow: 'people + agents',
    title: 'Talk to your team.',
    lede: 'You talk to them. They talk to each other. Work happens out loud.',
  },
  yours: {
    eyebrow: 'mini apps',
    title: 'Ask for the tool you need.',
    lede: 'Your agents build it right inside DorkOS. It opens once you say yes.',
  },
  computer: {
    eyebrow: 'ownership',
    title: 'Yours to keep.',
    lede: 'Your agents, tools, files and data stay yours, wherever they run. Use the AI plan you already have. No DorkOS account needed.',
  },
};

/** The line that fades up once the laptop has formed around the chat. */
export const LOCALHOST_CAPTION = 'home sweet localhost';

/**
 * The film, which this page puts second and treats as the main event.
 *
 * Every word here is one of the four lines the film's own campaign settled on,
 * used in the film's order: "Meet Dave." / "Dave wasn't winning..." above the
 * player, {@link FILM_TURN} under it, and {@link BRIDGE} carrying the last one
 * into the product. The page never invents a new sentence about Dave and never
 * explains what happens in the film. A page that narrates a joke has spent it.
 *
 * The second line was "Dave is not winning." until the operator edited it in
 * the 2026-08-25 review. The past tense and the trailing dots do the work the
 * present tense could not: they say the story is already over and its ending
 * is one scroll away, which is the whole reason to press play. The apostrophe
 * is the typographic one, to match "Dave isn’t" in {@link BRIDGE}.
 */
export const FILM: Block = {
  eyebrow: '56 seconds · sound on',
  title: 'Meet Dave.',
  lede: 'Dave wasn’t winning...',
};

/** The turn, under the player: what the next 56 seconds are about. */
export const FILM_TURN = 'Then Dave got DorkOS.';

/**
 * The hand-off from Dave's story to the visitor's.
 *
 * The two halves are one approved line broken over a heading and its
 * supporting sentence, so the pivot from "him" to "you" lands on the heading.
 */
export const BRIDGE: Block = {
  eyebrow: 'now for real',
  title: 'Dave isn’t smarter than you.',
  lede: 'He just has help. Here is what that help looks like.',
};

/** The close. */
export const CLOSE = {
  title: 'You, multiplied.',
  lede: 'We built it for ourselves. Now it’s yours.',
  /**
   * The bill, said once and plainly.
   *
   * "free" is true of DorkOS and false of running agents, and this page
   * says it more than once. `/` can afford to answer it in a FAQ
   * entry; a page with a word budget this small has to answer it in a line,
   * or the cheerful half stands alone.
   */
  cost: 'DorkOS is free. Your agents call whichever AI company powers them, and that is the only bill.',
  /** The one link out of the close, to every other way of installing. */
  otherWays: 'other ways to install',
  /**
   * The Marketplace, beside that link rather than in the pill.
   *
   * The floating pill now steers this page's own sections, and browsing
   * packages is not one of them: it is somewhere you go once you already run
   * DorkOS, which puts it at the end of the page rather than in the reading
   * path. It is still one click from every screen via the pill's overflow
   * menu.
   *
   * It sits on the close's own quiet line because the site footer underneath
   * does not carry it, and it is the one destination that would otherwise
   * vanish with the colophon that used to hold it.
   */
  marketplace: 'marketplace',
} as const;

/** What the download button offers, and what it costs. */
export const DOWNLOAD = {
  label: 'Download for Mac',
  terms: 'free · mit license · apple silicon',
} as const;

/** Introduces the terminal install, wherever the download button appears. */
export const INSTALL_ASIDE = 'or run';

/**
 * What the terminal install needs, next to the command itself.
 *
 * `/install` says this too, but someone who copies the command straight off
 * this page never gets there, and the failure it saves them from is opaque.
 */
export const NPX_REQUIREMENT = 'needs node 22+';

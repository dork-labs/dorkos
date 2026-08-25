import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { features } from '@/layers/features/marketing/lib/features';
import { CAST, DAVE, RUNTIMES } from '../cast';
import { CHAT_SCRIPT, PART_ONE_COUNT } from '../chat-script';
import {
  BEATS,
  BRIDGE,
  CLOSE,
  DOWNLOAD,
  FILM,
  FILM_TURN,
  HERO,
  INSTALL_ASIDE,
  LOCALHOST_CAPTION,
} from '../copy';
import { DOCK, findDockApp, type DockAppId } from '../dock-apps';
import { PAGE_SECTIONS } from '../sections';
import {
  HANDOFF_STILL,
  PROMO_CAPTIONS,
  PROMO_CUTS,
  PROMO_POSTER_ALT,
  ROOM_PLATE,
} from '../promo-cuts';
import { INSTALL_COMMAND } from '../theme';
import { TUTORIALS } from '../tutorials';

/** The page's own words about Dave, in the order a visitor meets them. */
const FILM_COPY: string[] = [...Object.values(FILM), FILM_TURN, ...Object.values(BRIDGE)];

/** The clips rail's words, which live with its cards rather than in `copy.ts`. */
const TUTORIAL_COPY: string[] = [
  TUTORIALS.eyebrow,
  TUTORIALS.title,
  TUTORIALS.lede,
  TUTORIALS.pendingChip,
  ...Object.values(TUTORIALS.endCard).filter((value) => !value.startsWith('/')),
  ...TUTORIALS.cards.map((card) => card.title),
];

/** Every string `/new` renders, flattened, for the sweeps below. */
const ALL_COPY: string[] = [
  ...Object.values(HERO),
  ...Object.values(BEATS).flatMap((beat) => Object.values(beat)),
  LOCALHOST_CAPTION,
  ...FILM_COPY,
  ...TUTORIAL_COPY,
  ...Object.values(CLOSE),
  ...Object.values(DOWNLOAD),
  INSTALL_ASIDE,
  INSTALL_COMMAND,
  PROMO_POSTER_ALT,
  HANDOFF_STILL.alt,
  ...DOCK.map((app) => app.label),
  ...PAGE_SECTIONS.map((section) => section.label),
  ...CHAT_SCRIPT.map((line) => line.text),
];

/** The nearest `public/promo` above `from`, or null if this file has drifted out of the site. */
function findPublicDir(from: string): string | null {
  for (let dir = from; dirname(dir) !== dir; dir = dirname(dir)) {
    const candidate = join(dir, 'public');
    if (existsSync(join(candidate, 'promo'))) return candidate;
  }
  return null;
}

/** The page's own assembly, read as text, so the order it renders in can be pinned. */
const HOME_EXPERIENCE = readFileSync(join(import.meta.dirname, '..', 'HomeExperience.tsx'), 'utf8');

/** Every dock tile the conversation actually puts to work. */
const NAMED_IN_CHAT: DockAppId[] = CHAT_SCRIPT.map((line) => line.dockApp).filter(
  (id): id is DockAppId => Boolean(id)
);

describe('the settled lines', () => {
  // These six are not editorial choices a passing build should be free to
  // change. "All your agents. One place." is the category line the operator
  // fixed (AGENTS.md, DOR-1517) and "You, multiplied." is the tagline; the
  // rest were approved word for word in the design session this page came
  // out of. Anything else on the page is fair game to rewrite.
  it('says the category line, unedited', () => {
    expect(HERO.title).toBe('All your agents. One place.');
  });

  it('keeps the three beat headlines', () => {
    expect(BEATS.talk.title).toBe('Talk to your team.');
    expect(BEATS.yours.title).toBe('Make it yours.');
    expect(BEATS.computer.title).toBe('It all happens on your computer.');
  });

  it('keeps the localhost caption and the tagline', () => {
    expect(LOCALHOST_CAPTION).toBe('home sweet localhost');
    expect(CLOSE.title).toBe('You, multiplied.');
  });

  it('leads with the Mac app and offers the terminal underneath', () => {
    expect(DOWNLOAD.label).toBe('Download for Mac');
    expect(INSTALL_COMMAND).toBe('npx dorkos@latest');
  });

  it('says what running agents costs, since the page says "free" twice', () => {
    // `/` answers this in its FAQ; a page this short has to say it in a line,
    // or "free · open source" stands alone, which is true of DorkOS and false
    // of running agents.
    expect(DOWNLOAD.terms).toContain('free');
    expect(CLOSE.cost).toMatch(/free/i);
    expect(CLOSE.cost).toMatch(/only bill|costs?|pay/i);
  });
});

describe('the demo-claim gate', () => {
  // AGENTS.md: a surface that is not verified is never described as working.
  // The Windows build is an early alpha, the Obsidian plugin is built but
  // under-tested, and the marketplace's Claude-Code-superset compatibility is
  // the unverified part of that pillar. None of the three may appear here,
  // because this page has no room to caveat them.
  const UNVERIFIED = /\b(windows|obsidian|linux|superset|drop-?in replacement)\b/i;

  it('names no unverified surface', () => {
    expect(ALL_COPY.filter((line) => UNVERIFIED.test(line))).toEqual([]);
  });

  it('only animates capabilities the feature catalog calls shipped', () => {
    // The page shows each dock tile being used. `DockApp.feature` names the
    // catalog entry each one depicts, and this resolves every one of them.
    // Connections is the catalog's single `beta` entry, so nothing here may
    // point at it — which is also what keeps "It all happens on your
    // computer." true, since its sign-in is held in a third party's vault.
    const bySlug = new Map(features.map((feature) => [feature.slug, feature]));

    for (const app of DOCK) {
      const backing = bySlug.get(app.feature);
      expect(backing, `dock tile "${app.id}" names no feature "${app.feature}"`).toBeDefined();
      expect(backing?.status, `dock tile "${app.id}" depicts a non-GA feature`).toBe('ga');
    }
  });

  it('shows the agents asking before they act', () => {
    // The promo film this page hosts promises the agents suggest and the
    // person approves, and Tool Approval / Action Approvals are what actually
    // ships. A script of completed actions with no approval would oversell it.
    const daveSaidGo = CHAT_SCRIPT.filter((line) => line.from === 'dave');
    const askedFirst = CHAT_SCRIPT.filter(
      (line) => line.from !== 'dave' && line.text.includes('?')
    );

    expect(askedFirst.length).toBeGreaterThanOrEqual(2);
    expect(daveSaidGo.length).toBeGreaterThanOrEqual(3);

    // Each approval must follow a question, not float free.
    for (const approval of daveSaidGo.slice(1)) {
      const at = CHAT_SCRIPT.indexOf(approval);
      const before = CHAT_SCRIPT[at - 1];
      expect(before.text, `"${approval.text}" answers nothing`).toContain('?');
    }
  });

  it('leaves the film’s own joke to the film', () => {
    // Dave never ordered the flowers, Pip did, and the callback only works
    // cold. The page hosts the film; it must not narrate it, caption the
    // flowers as a feature, or name Betty at all.
    const chat = CHAT_SCRIPT.map((line) => line.text).join(' ');
    expect(chat).not.toMatch(/flower|betty|birthday/i);
    expect(ALL_COPY.join(' ')).not.toMatch(/flower|betty|birthday/i);
  });
});

describe('the film leads', () => {
  // This page's whole bet: the 56 seconds are the strongest asset, so they run
  // second, while a visitor still has patience, and everything after them is
  // there to answer "was any of that real". Two things hold that bet in place.

  it('puts the film above the story that proves it', () => {
    // Order is the argument here, so it is pinned rather than left to a
    // reviewer's memory. Moving the player below the stage, or the stage above
    // the hand-off, turns this page back into a different one. Past the close
    // of the argument the order is a different kind of promise: clips, then
    // the catalogue, then the objections, then the ask — what an interested
    // visitor goes looking for, in the order they go looking.
    const order = [
      '<Hero',
      '<FilmSection',
      '<CastBridge',
      '<StageSection',
      '<TutorialsSection',
      '<FeatureCatalogSection',
      '<FAQSection',
      '<CloseSection',
    ].map((tag) => [tag, HOME_EXPERIENCE.indexOf(tag)] as const);

    for (const [tag, at] of order) {
      expect(at, `${tag} is not on the page`).toBeGreaterThan(-1);
    }
    const positions = order.map(([, at]) => at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('renders the two catalogue sections rather than reimplementing them', () => {
    // They are the published home page's, imported from the marketing barrel
    // and rendered unmodified. A local copy of either would fork the feature
    // list or the FAQ into two that drift, and editing the originals would
    // change `/`, which is byte-frozen.
    const shared = HOME_EXPERIENCE.match(
      /import \{([^}]*)\} from '@\/layers\/features\/marketing'/
    );
    expect(shared, 'nothing is imported from the marketing barrel').not.toBeNull();
    expect(shared?.[1]).toContain('FAQSection');
    expect(shared?.[1]).toContain('FeatureCatalogSection');
  });

  it('says nothing about Dave the film did not approve', () => {
    // The four lines below are the film campaign's own, approved word for word.
    // The page may arrange them; it may not write a fifth. Narrating a film in
    // the copy above it spends the film before it plays. Scoped to the page's
    // authored film copy: the poster and still descriptions are alt text, which
    // has to describe the picture rather than sell it.
    // "Dave wasn't winning..." replaced "Dave is not winning." in the
    // operator's 2026-08-25 review of this page. It is the same approved beat
    // in the past tense: the story is over, and its ending is one press away.
    expect(FILM_COPY.filter((line) => /\bDave\b/.test(line))).toEqual([
      'Meet Dave.',
      'Dave wasn’t winning...',
      'Then Dave got DorkOS.',
      'Dave isn’t smarter than you.',
    ]);
  });

  it('lets no later section write a fifth line about him', () => {
    // The clips rail is the one section below the hand-off that mentions Dave
    // at all, and it does it by reusing "Meet Dave." from `copy.ts` rather
    // than titling its tile itself. Anything else here would be the page
    // narrating the film after the film has played. The chat script and the
    // still's alt text are exempt: the script is the film's cast talking to
    // each other, and alt text has to describe the picture.
    expect(TUTORIAL_COPY.filter((line) => /\bDave\b/.test(line))).toEqual([FILM.title]);
  });

  it('finishes the approved line it breaks in half', () => {
    // "Dave isn't smarter than you. He just has help." is one line, split so
    // the pivot from him to you lands on the heading. Dropping the second half
    // leaves an insult where an argument was.
    expect(`${BRIDGE.title} ${BRIDGE.lede}`).toContain(
      'Dave isn’t smarter than you. He just has help.'
    );
  });

  it('ships the two film frames the hand-off needs', () => {
    const publicDir = findPublicDir(import.meta.dirname);
    for (const asset of [ROOM_PLATE, HANDOFF_STILL.src]) {
      expect(existsSync(join(publicDir ?? '', asset)), asset).toBe(true);
    }
  });

  it('describes the hand-off frame for anyone who cannot see it', () => {
    expect(HANDOFF_STILL.alt.length).toBeGreaterThan(30);
    expect(HANDOFF_STILL.width / HANDOFF_STILL.height).toBeCloseTo(16 / 9, 2);
  });
});

describe('the clips rail', () => {
  const PUBLIC_DIR = findPublicDir(import.meta.dirname);

  it('only names capabilities the feature catalog calls shipped', () => {
    // Same law as the dock, applied to a section where most of the tiles are
    // empty. A card that names a capability makes the promise whether or not
    // there is footage behind it, so a placeholder is held to the finished
    // card's standard: `feature` resolves, and it resolves to `ga`.
    const bySlug = new Map(features.map((feature) => [feature.slug, feature]));

    for (const card of TUTORIALS.cards) {
      const backing = bySlug.get(card.feature);
      expect(backing, `card "${card.id}" names no feature "${card.feature}"`).toBeDefined();
      expect(backing?.status, `card "${card.id}" depicts a non-GA feature`).toBe('ga');
    }
  });

  it('says out loud that most of the shelf is empty', () => {
    // The honest state has to be readable, not inferred from a dashed border.
    // Every card without a clip wears the pending chip, and the chip is about
    // the clip rather than the feature, which is the distinction that keeps
    // "Add a skill from the marketplace · clip coming" from reading as a
    // marketplace that has not shipped.
    const pending = TUTORIALS.cards.filter((card) => !card.clip);
    expect(pending.length).toBeGreaterThan(0);
    expect(TUTORIALS.pendingChip).toMatch(/clip|video|soon/i);
    expect(TUTORIALS.lede).toMatch(/coming|on the way|being made|soon/i);
  });

  it('leads with the one clip that exists', () => {
    // The rail's first tile is the film's vertical cut. A rail whose first
    // frame is a placeholder is a rail nobody scrolls.
    const [first, ...rest] = TUTORIALS.cards;
    expect(first.clip).toBeDefined();
    expect(first.clip?.src).toBe(PROMO_CUTS.tall.src);
    expect(
      rest.every((card) => !card.clip),
      'a second clip appeared without a test'
    ).toBe(true);
  });

  it('reuses the film’s own title rather than writing a fifth Dave line', () => {
    expect(TUTORIALS.cards[0].title).toBe(FILM.title);
  });

  it('ships every still the rail points at', () => {
    const stills = TUTORIALS.cards.flatMap((card) =>
      [card.clip?.poster, card.plate?.src].filter((src): src is string => Boolean(src))
    );
    expect(stills).toHaveLength(TUTORIALS.cards.length);
    for (const still of stills) {
      expect(existsSync(join(PUBLIC_DIR ?? '', still)), still).toBe(true);
    }
  });

  it('keeps the generated stills small enough to be background texture', () => {
    // They sit at 42% opacity behind a scrim on a card 256px wide. Anything
    // heavier is bandwidth spent on something nobody looks at directly.
    for (const card of TUTORIALS.cards) {
      if (!card.plate) continue;
      const bytes = statSync(join(PUBLIC_DIR ?? '', card.plate.src)).size;
      expect(bytes, `${card.plate.src} is ${Math.round(bytes / 1024)}KB`).toBeLessThan(300 * 1024);
    }
  });
});

describe('the pill and the page’s own stops', () => {
  it('points every pill entry at a section the page renders', () => {
    // The pill scrolls rather than navigates now, and an anchor pointing at an
    // id nothing carries is a press that silently does nothing. Two of the
    // five ids live on wrappers in `HomeExperience`; the other three are on
    // the sections themselves.
    const sources = [
      HOME_EXPERIENCE,
      readFileSync(join(import.meta.dirname, '..', 'FilmSection.tsx'), 'utf8'),
      readFileSync(join(import.meta.dirname, '..', 'StageSection.tsx'), 'utf8'),
      readFileSync(join(import.meta.dirname, '..', 'tutorials', 'TutorialsSection.tsx'), 'utf8'),
    ].join('\n');

    for (const section of PAGE_SECTIONS) {
      expect(sources, `nothing renders id="${section.id}"`).toContain(`id="${section.id}"`);
    }
  });

  it('gives every anchor target a focus stop, so the page moves the reader too', () => {
    // Scrolling without moving focus leaves a keyboard visitor's next Tab
    // resuming three screens behind what they are now looking at. Each target
    // carries tabIndex={-1} for the nav to focus.
    const anchored = [
      HOME_EXPERIENCE,
      readFileSync(join(import.meta.dirname, '..', 'FilmSection.tsx'), 'utf8'),
      readFileSync(join(import.meta.dirname, '..', 'StageSection.tsx'), 'utf8'),
      readFileSync(join(import.meta.dirname, '..', 'tutorials', 'TutorialsSection.tsx'), 'utf8'),
    ].join('\n');

    for (const section of PAGE_SECTIONS) {
      const at = anchored.indexOf(`id="${section.id}"`);
      // tabIndex sits within a few attributes of the id on the same element.
      expect(anchored.slice(at, at + 200), `id="${section.id}" has no focus stop`).toContain(
        'tabIndex={-1}'
      );
    }
  });

  it('keeps the Marketplace out of the pill and in the footer', () => {
    // The operator moved it. The pill steers the page now, and browsing
    // packages is somewhere you go once you already run DorkOS.
    expect(PAGE_SECTIONS.map((section) => section.label)).not.toContain('marketplace');
    expect(CLOSE.marketplace).toBe('marketplace');
    const close = readFileSync(join(import.meta.dirname, '..', 'CloseSection.tsx'), 'utf8');
    expect(close).toContain('href="/marketplace"');
  });

  it('leaves the shared nav alone, because `/` renders it', () => {
    // The published home page is byte-frozen against origin/main. This page's
    // pill is a fork under `nav/`; the moment it imports the shared component
    // instead, a change here is a change to every marketing page.
    const page = readFileSync(join(import.meta.dirname, '..', '..', 'page.tsx'), 'utf8');
    expect(page).toContain('<HomeNav />');
    // Naming the shared component in a comment is how the fork explains
    // itself; rendering or importing it is the thing that must not happen.
    expect(page).not.toContain('<MarketingNav');
    expect(page).not.toMatch(/^import .*MarketingNav/m);
  });
});

describe('the cast from the film', () => {
  // These are locked by the film's `characters.md` and are not the site's to
  // re-pick. The colours come from `chat-ui.tsx`, which is the screen truth;
  // two of the four are deliberately absent from `brand.tokens.json`.
  it('carries the film’s three agents, in the film’s colours', () => {
    expect(CAST.map((member) => member.name)).toEqual(['Otto', 'Pip', 'Hal']);
    expect(CAST.map((member) => member.ring)).toEqual(['#e8801f', '#4a90a4', '#c9b458']);
  });

  it('renders Pip smaller, which is narrative and not a layout tweak', () => {
    const pip = CAST.find((member) => member.key === 'pip');
    expect(pip?.sizeScale).toBe(0.86);
    for (const other of CAST.filter((member) => member.key !== 'pip')) {
      expect(other.sizeScale).toBe(1);
    }
  });

  it('marks Dave as the person, in the brand accent rather than a lane colour', () => {
    expect(DAVE.ring).toBe('#e85d04');
    expect(CAST.map((member) => member.ring)).not.toContain(DAVE.ring);
  });

  it('gives each agent a distinct runtime, so the badges say the real story', () => {
    const runtimes = CAST.map((member) => RUNTIMES[member.key].runtime);
    expect(new Set(runtimes).size).toBe(CAST.length);
    expect(runtimes.sort()).toEqual(['Claude Code', 'Codex', 'OpenCode']);
  });

  it('ships a loop and a still for every face', () => {
    const publicDir = findPublicDir(import.meta.dirname);
    for (const member of [...CAST, DAVE]) {
      expect(existsSync(join(publicDir ?? '', member.loop)), member.loop).toBe(true);
      expect(existsSync(join(publicDir ?? '', member.still)), member.still).toBe(true);
    }
  });

  it('only puts the film’s cast in the chat', () => {
    const known = new Set<string>([...CAST.map((member) => member.key), DAVE.key, 'system']);
    for (const line of CHAT_SCRIPT) {
      expect(known.has(line.from), `unknown speaker "${line.from}"`).toBe(true);
    }
  });
});

describe('the /new voice', () => {
  // Retired and soft-banned vocabulary, per .claude/rules/site-marketing-copy.md.
  // The two CI scripts cover prose files and render-path JSX; neither reads a
  // data module like `copy.ts`, which is where this page keeps its words.
  const RETIRED =
    /\b(mission control|cockpit|orchestrat\w*|coordinat\w*|multi-agent|fleet|platform|seamless\w*|powerful|workflows?|AI-powered|10x)\b/i;

  it('uses none of the retired words', () => {
    expect(ALL_COPY.filter((line) => RETIRED.test(line))).toEqual([]);
  });

  it('has no em dashes, which the plain-language contract rules out', () => {
    expect(ALL_COPY.filter((line) => line.includes('—'))).toEqual([]);
  });
});

describe('the promo assets the page points at', () => {
  // Found by walking up rather than by counting `..`, because a relative depth
  // is silently wrong the moment the route moves — which is exactly what
  // happened when this page went from `/` to `/new`, and five asset checks
  // went red at once for a reason none of them named.
  const PUBLIC_DIR = findPublicDir(import.meta.dirname);

  it('finds the site’s public directory at all', () => {
    expect(PUBLIC_DIR, 'no apps/site/public above this test').not.toBeNull();
  });

  it.each([
    PROMO_CUTS.wide.src,
    PROMO_CUTS.wide.poster,
    PROMO_CUTS.tall.src,
    PROMO_CUTS.tall.poster,
    PROMO_CAPTIONS,
  ])('ships %s', (assetPath) => {
    expect(existsSync(join(PUBLIC_DIR ?? '', assetPath))).toBe(true);
  });

  it('serves a different file for each shape', () => {
    expect(PROMO_CUTS.wide.src).not.toBe(PROMO_CUTS.tall.src);
    expect(PROMO_CUTS.wide.poster).not.toBe(PROMO_CUTS.tall.poster);
  });
});

describe('the chat script and the dock', () => {
  it('uses every tile on the dock exactly once', () => {
    // The animation's whole point is that each icon flies out of its slot and
    // lands in the message that uses it. A tile nobody names never leaves the
    // dock; a tile named twice tries to fly to two places at once.
    expect(NAMED_IN_CHAT).toHaveLength(DOCK.length);
    expect(new Set(NAMED_IN_CHAT)).toEqual(new Set(DOCK.map((app) => app.id)));
  });

  it('names only tiles the dock carries', () => {
    for (const id of NAMED_IN_CHAT) {
      expect(findDockApp(id), `no dock tile called "${id}"`).toBeDefined();
    }
  });

  it('holds the dock back until the second beat', () => {
    // Part one is the conversation; the tiles arrive with "Make it yours."
    const early = CHAT_SCRIPT.slice(0, PART_ONE_COUNT).filter((line) => line.dockApp);
    expect(early).toEqual([]);
  });
});

import { existsSync, readFileSync } from 'node:fs';
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
import {
  HANDOFF_STILL,
  PROMO_CAPTIONS,
  PROMO_CUTS,
  PROMO_POSTER_ALT,
  ROOM_PLATE,
} from '../promo-cuts';
import { INSTALL_COMMAND } from '../theme';

/** The page's own words about Dave, in the order a visitor meets them. */
const FILM_COPY: string[] = [...Object.values(FILM), FILM_TURN, ...Object.values(BRIDGE)];

/** Every string `/new` renders, flattened, for the sweeps below. */
const ALL_COPY: string[] = [
  ...Object.values(HERO),
  ...Object.values(BEATS).flatMap((beat) => Object.values(beat)),
  LOCALHOST_CAPTION,
  ...FILM_COPY,
  ...Object.values(CLOSE),
  ...Object.values(DOWNLOAD),
  INSTALL_ASIDE,
  INSTALL_COMMAND,
  PROMO_POSTER_ALT,
  HANDOFF_STILL.alt,
  ...DOCK.map((app) => app.label),
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
    // the hand-off, turns this page back into a different one.
    const source = readFileSync(join(import.meta.dirname, '..', 'HomeExperience.tsx'), 'utf8');
    const order = ['<Hero', '<FilmSection', '<CastBridge', '<StageSection', '<CloseSection'].map(
      (tag) => [tag, source.indexOf(tag)] as const
    );

    for (const [tag, at] of order) {
      expect(at, `${tag} is not on the page`).toBeGreaterThan(-1);
    }
    const positions = order.map(([, at]) => at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('says nothing about Dave the film did not approve', () => {
    // The four lines below are the film campaign's own, approved word for word.
    // The page may arrange them; it may not write a fifth. Narrating a film in
    // the copy above it spends the film before it plays. Scoped to the page's
    // authored film copy: the poster and still descriptions are alt text, which
    // has to describe the picture rather than sell it.
    expect(FILM_COPY.filter((line) => /\bDave\b/.test(line))).toEqual([
      'Meet Dave.',
      'Dave is not winning.',
      'Then Dave got DorkOS.',
      'Dave isn’t smarter than you.',
    ]);
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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAT_SCRIPT } from '../chat-script';
import { BEATS, CLOSE, DOWNLOAD, HERO, INSTALL_ASIDE, LOCALHOST_CAPTION, PROMO } from '../copy';
import { findIntegration } from '../integrations';
import { PROMO_CAPTIONS, PROMO_CUTS, PROMO_POSTER_ALT } from '../promo-cuts';
import { INSTALL_COMMAND } from '../theme';

/** Every string the home page renders, flattened, for the sweeps below. */
const ALL_COPY: string[] = [
  ...Object.values(HERO),
  ...Object.values(BEATS).flatMap((beat) => Object.values(beat)),
  LOCALHOST_CAPTION,
  ...Object.values(PROMO),
  ...Object.values(CLOSE),
  ...Object.values(DOWNLOAD),
  INSTALL_ASIDE,
  INSTALL_COMMAND,
  PROMO_POSTER_ALT,
  ...CHAT_SCRIPT.map((line) => line.text),
];

describe('the settled home page lines', () => {
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
    // Demo-claim gate: the signed Mac build is the verified desktop surface,
    // so it is the one the page names. Windows is alpha and stays off it.
    expect(DOWNLOAD.label).toBe('Download for Mac');
    expect(INSTALL_COMMAND).toBe('npx dorkos@latest');
    expect(ALL_COPY.join(' ')).not.toMatch(/windows/i);
  });
});

describe('the home page voice', () => {
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
  const PUBLIC_DIR = join(import.meta.dirname, '../../../../../public');

  it.each([
    PROMO_CUTS.wide.src,
    PROMO_CUTS.wide.poster,
    PROMO_CUTS.tall.src,
    PROMO_CUTS.tall.poster,
    PROMO_CAPTIONS,
  ])('ships %s', (assetPath) => {
    expect(existsSync(join(PUBLIC_DIR, assetPath))).toBe(true);
  });

  it('serves a different file for each shape', () => {
    expect(PROMO_CUTS.wide.src).not.toBe(PROMO_CUTS.tall.src);
    expect(PROMO_CUTS.wide.poster).not.toBe(PROMO_CUTS.tall.poster);
  });
});

describe('the chat script', () => {
  it('names an app the dock actually carries, every time it names one', () => {
    // A typo here is silent in the browser: the icon simply never flies out
    // of its dock slot and into the message.
    const named = CHAT_SCRIPT.map((line) => line.integration).filter(
      (id): id is NonNullable<typeof id> => Boolean(id)
    );

    expect(named.length).toBeGreaterThan(0);
    for (const id of named) {
      expect(findIntegration(id), `no dock app called "${id}"`).toBeDefined();
    }
  });
});

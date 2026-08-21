import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  PLAYGROUND_REGISTRY,
  TOKENS_SECTIONS,
  FORMS_SECTIONS,
  COMPONENTS_SECTIONS,
  CONVERSATION_SECTIONS,
  ENTRY_ACTIONS_SECTIONS,
  FEATURES_SECTIONS,
  IDENTITY_SECTIONS,
  PROMOS_SECTIONS,
  COMMAND_PALETTE_SECTIONS,
  SIMULATOR_SECTIONS,
  TOPOLOGY_SECTIONS,
  FILTER_BAR_SECTIONS,
  ERROR_STATES_SECTIONS,
  ONBOARDING_SECTIONS,
  TABLES_SECTIONS,
  SETTINGS_SECTIONS,
  MARKETPLACE_SECTIONS,
  GEN_UI_SECTIONS,
  ROOMS_SECTIONS,
  TOUR_SPOTLIGHT_SECTIONS,
  SIDEBAR_MODEL_SECTIONS,
  ONE_BAR_SECTIONS,
} from '../playground-registry';
import { slugify } from '../lib/slugify';
import {
  PAGE_CONFIGS,
  PAGE_ORDER,
  PAGE_LABELS,
  IDENTITY_CROSS_LISTED,
  getPageFromPath,
} from '../playground-config';

describe('playground-registry', () => {
  it('has no duplicate section IDs across the full registry', () => {
    const ids = PLAYGROUND_REGISTRY.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all IDs have no spaces (matching anchor generation pattern)', () => {
    for (const section of PLAYGROUND_REGISTRY) {
      expect(section.id).not.toMatch(/\s/);
    }
  });

  it('all sections have a valid page assignment', () => {
    const validPages = new Set(['overview', ...PAGE_CONFIGS.map((c) => c.id)]);
    for (const section of PLAYGROUND_REGISTRY) {
      expect(validPages.has(section.page)).toBe(true);
    }
  });

  it('PLAYGROUND_REGISTRY equals the union of all page-level arrays', () => {
    const combined = [
      ...TOKENS_SECTIONS,
      ...FORMS_SECTIONS,
      ...COMPONENTS_SECTIONS,
      ...CONVERSATION_SECTIONS,
      ...ENTRY_ACTIONS_SECTIONS,
      ...FEATURES_SECTIONS,
      ...IDENTITY_SECTIONS,
      ...PROMOS_SECTIONS,
      ...COMMAND_PALETTE_SECTIONS,
      ...SIMULATOR_SECTIONS,
      ...TOPOLOGY_SECTIONS,
      ...FILTER_BAR_SECTIONS,
      ...ERROR_STATES_SECTIONS,
      ...ONBOARDING_SECTIONS,
      ...TABLES_SECTIONS,
      ...SETTINGS_SECTIONS,
      ...MARKETPLACE_SECTIONS,
      ...GEN_UI_SECTIONS,
      ...ROOMS_SECTIONS,
      ...TOUR_SPOTLIGHT_SECTIONS,
      ...SIDEBAR_MODEL_SECTIONS,
      ...ONE_BAR_SECTIONS,
    ];
    expect(PLAYGROUND_REGISTRY).toEqual(combined);
  });

  it('every section has at least one keyword', () => {
    for (const section of PLAYGROUND_REGISTRY) {
      expect(section.keywords.length).toBeGreaterThan(0);
    }
  });

  it('every section ID matches slugify(title)', () => {
    for (const section of PLAYGROUND_REGISTRY) {
      expect(section.id).toBe(slugify(section.title));
    }
  });
});

describe('playground-config', () => {
  it('every PAGE_CONFIG has a label and description', () => {
    for (const config of PAGE_CONFIGS) {
      expect(config.label).toBeTruthy();
      expect(config.description).toBeTruthy();
    }
  });

  it('PAGE_ORDER matches PAGE_CONFIGS ids', () => {
    expect(PAGE_ORDER).toEqual(PAGE_CONFIGS.map((c) => c.id));
  });

  it('PAGE_LABELS has an entry for every PAGE_CONFIG', () => {
    for (const config of PAGE_CONFIGS) {
      expect(PAGE_LABELS[config.id]).toBe(config.label);
    }
  });

  it('no duplicate page IDs in PAGE_CONFIGS', () => {
    const ids = PAGE_CONFIGS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every page with sections has those sections in PLAYGROUND_REGISTRY', () => {
    for (const config of PAGE_CONFIGS) {
      for (const section of config.sections) {
        expect(PLAYGROUND_REGISTRY).toContainEqual(section);
      }
    }
  });

  it('resolves a live page path, and the one path a rename retired', () => {
    expect(getPageFromPath('/dev/conversation')).toBe('conversation');
    // `/dev/chat` was the Conversation page until DOR-1332. Without the alias
    // it falls through to Overview with the URL unchanged, so every saved
    // `/dev/chat#…` link lands on the wrong page without saying so.
    expect(getPageFromPath('/dev/chat')).toBe('conversation');
    expect(getPageFromPath('/dev/chat#composer')).toBe('conversation');
    expect(getPageFromPath('/dev/nothing-here')).toBe('overview');
  });
});

/**
 * The registry is a hand-maintained index of components rendered somewhere else, so
 * the two drift silently in both directions: a showcase added without an entry is
 * invisible to the TOC and to ⌘K, and an entry left behind by a rename or a deletion
 * points both of them at an anchor that no longer exists. The assertions above can
 * only ever check the registry against itself, which is why this drift kept shipping
 * (`UsageStatusItem` rendered unregistered from DOR-109 to DOR-452; `SessionRow` and
 * `Full Agent Dialog` outlived the showcases they named).
 *
 * So this block reads the showcase sources. `<PlaygroundSection title="…">` is the
 * only thing that emits an anchor, and its title is what `slugify` turns into the
 * anchor id, so the tag is the ground truth and the registry is what must match it.
 */
const DEV_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories whose `.tsx` files may render a `<PlaygroundSection>`. */
const SECTION_DIRS = ['showcases', 'pages'];

/**
 * Registered for search but rendering no `<PlaygroundSection>`, because the whole
 * page *is* the section — the simulator is a full-height app rather than a card, so
 * ⌘K takes you to the page itself. Everything else must have a rendered anchor.
 */
const PAGE_LEVEL_SECTIONS = new Set(['Chat Simulator']);

/** Matches one `<PlaygroundSection …>` opening tag; group 1 is its props. */
const SECTION_TAG = /<PlaygroundSection\b([\s\S]*?)>/g;

/** One rendered section: where it lives, and its literal title if it has one. */
interface RenderedSection {
  file: string;
  title: string | null;
}

/** Every `<PlaygroundSection>` the playground renders, read from source. */
function readRenderedSections(): RenderedSection[] {
  const found: RenderedSection[] = [];
  for (const dir of SECTION_DIRS) {
    const dirPath = join(DEV_DIR, dir);
    for (const file of readdirSync(dirPath).filter((f) => f.endsWith('.tsx'))) {
      const source = readFileSync(join(dirPath, file), 'utf8');
      for (const match of source.matchAll(SECTION_TAG)) {
        const title = /title="([^"]*)"/.exec(match[1]);
        found.push({ file: `${dir}/${file}`, title: title ? title[1] : null });
      }
    }
  }
  return found;
}

describe('the registry matches what the playground actually renders', () => {
  const rendered = readRenderedSections();

  it('parses the showcase sources at all — a parse that matches nothing proves nothing', () => {
    // Every section below is only as strong as this: if the tag regex or the source
    // layout changes, the drift checks would pass by finding nothing to check.
    expect(rendered.length).toBeGreaterThan(100);
  });

  it('gives every rendered section a literal title, the only kind a registry can match', () => {
    const computed = rendered.filter((s) => s.title === null).map((s) => s.file);
    expect(
      computed,
      'a <PlaygroundSection> needs title="A Literal String" so it can be registered and searched'
    ).toEqual([]);
  });

  it('registers every rendered section', () => {
    const registered = new Set(PLAYGROUND_REGISTRY.map((s) => s.title));
    const missing = rendered
      .filter((s) => s.title !== null && !registered.has(s.title))
      .map((s) => `${s.file} renders "${s.title}"`);
    expect(
      missing,
      "add an entry to that page's sections file in dev/sections/, or the TOC and ⌘K cannot see the section"
    ).toEqual([]);
  });

  it('renders every registered section, so no entry points at an anchor that is gone', () => {
    const renderedTitles = new Set(rendered.map((s) => s.title));
    const dangling = PLAYGROUND_REGISTRY.filter(
      (s) => !renderedTitles.has(s.title) && !PAGE_LEVEL_SECTIONS.has(s.title)
    ).map((s) => s.title);
    expect(
      dangling,
      'drop the entry, or retitle it to match the showcase that replaced it'
    ).toEqual([]);
  });
});

/**
 * Cross-listing has a blind spot the checks above cannot see.
 *
 * They ask whether a section is rendered ANYWHERE — so a borrowed section keeps
 * them green from its owning page alone. Delete `<RoomAvatarShowcase />` from
 * `IdentityPage` and every assertion above still passes while the Identity
 * page's TOC offers a link to an anchor that page no longer draws. This block
 * is the only thing that asks the second question: does the page that BORROWS a
 * section actually render it, and in the order its TOC promises?
 */
const CROSS_LISTED_RENDERERS: Record<string, string> = {
  identityavatar: 'IdentityAvatarShowcase',
  // Three ids, one component: `IdentityShowcases` draws MentionPill, the hover
  // card and the in-message mention together, so they share a source position
  // and their order relative to EACH OTHER is not asserted here — only that the
  // block as a whole sits where the TOC puts it.
  mentionpill: 'IdentityShowcases',
  identityhovercard: 'IdentityShowcases',
  'a-mention-in-a-real-message': 'IdentityShowcases',
  messageauthoravatar: 'MessageAuthorAvatarShowcase',
  agentidentitychip: 'AgentIdentityChipShowcase',
  roomavatar: 'RoomAvatarShowcase',
  roommemberrow: 'RoomMemberRowShowcase',
};

describe('the Identity page renders every section it borrows', () => {
  const source = readFileSync(join(DEV_DIR, 'pages', 'IdentityPage.tsx'), 'utf8');
  const positionOf = (id: string): number => source.indexOf(`<${CROSS_LISTED_RENDERERS[id]} />`);

  it('names a renderer for every cross-listed id', () => {
    expect(
      Object.keys(CROSS_LISTED_RENDERERS).sort(),
      'a new entry in IDENTITY_CROSS_LISTED needs the component that draws it named here'
    ).toEqual([...IDENTITY_CROSS_LISTED].sort());
  });

  it('renders each borrowed section, so no TOC link points at nothing', () => {
    const missing = IDENTITY_CROSS_LISTED.filter((id) => positionOf(id) === -1);
    expect(
      missing,
      'IdentityPage borrows these ids for its TOC but does not render the showcase that draws them'
    ).toEqual([]);
  });

  it('renders them in the order its TOC lists them', () => {
    const positions = IDENTITY_CROSS_LISTED.map(positionOf);
    expect(
      positions,
      'the page renders the borrowed showcases in a different order than IDENTITY_CROSS_LISTED promises'
    ).toEqual([...positions].sort((a, b) => a - b));
  });
});

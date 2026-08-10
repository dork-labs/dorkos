/**
 * **P2 AC-7: exactly one create surface exists.**
 *
 * A scattered create menu grows back the way it grew the first time — one
 * section at a time, each addition reasonable on its own. So the invariant is
 * checked against the source rather than against a rendered tree: a `+` wired
 * to its own handler in a component nobody thought to test still fails here.
 *
 * Three claims, and each is written so it can fail:
 *
 * 1. **Vocabulary.** Every `new-*` action id anywhere in the feature is one of
 *    {@link NEW_MENU_ITEM_IDS}. A section that invents `new-thread` reddens.
 * 2. **Surfaces.** The four modal create surfaces — the channel dialog, the
 *    direct-message picker, the agent-creation store, the smart-group rule form
 *    in `create` mode — are referenced by exactly ONE module, `NewMenu.tsx`.
 *    Putting `ChannelCreateDialog` back into `useSectionChrome` reddens.
 * 3. **The version number** (BC-44) is rendered by exactly one module,
 *    `SidebarHeaderBlock`'s menu builder.
 *
 * Every claim is paired with its positive half — the file it names is scanned,
 * exists, and really does contain what it is supposed to. A guard whose regexes
 * name modules that no longer exist passes forever and proves nothing; that
 * exact failure has already happened once in this programme, so the fixtures
 * below assert their own subjects before asserting anyone's absence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { NEW_MENU_ITEM_IDS } from '../model/create-flow-store';

const FEATURE_DIR = join(__dirname, '..');

/** Every source file in the feature, tests excluded — relative to the feature root. */
function sourceFiles(dir = FEATURE_DIR, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'fixtures') return [];
      return sourceFiles(full, `${prefix}${entry}/`);
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) return [];
    return [`${prefix}${entry}`];
  });
}

const FILES = sourceFiles();
const SOURCE = new Map(FILES.map((f) => [f, readFileSync(join(FEATURE_DIR, f), 'utf8')]));

/** Which files mention a pattern. */
function filesMatching(pattern: RegExp): string[] {
  return [...SOURCE]
    .filter(([, text]) => pattern.test(text))
    .map(([file]) => file)
    .sort();
}

describe('the scan itself', () => {
  it('reads the feature, and reads the files these claims are about', () => {
    // Without this, every "no file does X" below is true of an empty scan.
    expect(FILES.length).toBeGreaterThan(20);
    for (const file of [
      'ui/NewMenu.tsx',
      'ui/SidebarHeaderBlock.tsx',
      'ui/useSectionChrome.tsx',
      'ui/SectionHeaderMenuItems.tsx',
      'ui/AgentRowMenuItems.tsx',
      'model/create-flow-store.ts',
    ]) {
      expect(FILES).toContain(file);
      expect(SOURCE.get(file)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('no longer finds the menus this task deleted', () => {
    expect(FILES).not.toContain('ui/AddAgentMenu.tsx');
  });
});

describe('AC-7 — one create vocabulary', () => {
  /** Every `id: 'new-…'` literal in the feature, with the file it sits in. */
  const declared = [...SOURCE].flatMap(([file, text]) =>
    [...text.matchAll(/id:\s*'(new-[a-z0-9-]+)'/g)].map((m) => ({ file, id: m[1]! }))
  );

  it('declares all five of the menu’s own items', () => {
    const inMenu = declared.filter((d) => d.file === 'ui/NewMenu.tsx').map((d) => d.id);
    for (const id of NEW_MENU_ITEM_IDS) expect(inMenu).toContain(id);
  });

  it('uses no create id outside the New menu’s vocabulary', () => {
    // The New menu names its own sub-items (`new-group-empty`, the preset rows,
    // the `↵` note) and is allowed to: they are that menu's insides, not a
    // second door. Everywhere else, an id must be one of the five.
    const elsewhere = declared.filter((d) => d.file !== 'ui/NewMenu.tsx');

    // Observable first: there ARE create ids outside the menu — the agent row's
    // "New session" and its "Move to group ▸ New group". Without this, the
    // subset check below would pass on an empty list.
    expect(elsewhere.map((d) => `${d.file}: ${d.id}`).sort()).toEqual([
      'ui/AgentRowMenuItems.tsx: new-group',
      'ui/AgentRowMenuItems.tsx: new-session',
      'ui/rooms/RoomRowMenuItems.tsx: new-group',
    ]);

    const strays = elsewhere
      .filter((d) => !(NEW_MENU_ITEM_IDS as readonly string[]).includes(d.id))
      .map((d) => `${d.file}: ${d.id}`);
    expect(strays).toEqual([]);
  });
});

describe('AC-7 — one create surface', () => {
  /**
   * Each create surface, how to spot it in source, and every module allowed to
   * reach it — asserted as an EXACT list, so a new caller reddens and a stale
   * exemption reddens too.
   */
  const SURFACES: [name: string, pattern: RegExp, callers: string[]][] = [
    ['the channel dialog', /\bChannelCreateDialog\b/, ['ui/NewMenu.tsx']],
    ['the direct-message picker', /\bNewDirectMessageMenu\b/, ['ui/NewMenu.tsx']],
    ['the smart-group rule form in create mode', /mode="create"/, ['ui/NewMenu.tsx']],
    [
      'the agent-creation flow',
      /\buseAgentCreationStore\b/,
      [
        'ui/NewMenu.tsx',
        // The day-one invitation, not a create surface: a computed
        // Getting-started suggestion that appears once, when the Library has
        // nothing in it at all, and retires the moment it does (§8). It opens
        // the SAME flow this menu's "Agent" item opens — one destination, and
        // the id it stands for is in the vocabulary above. P2.2 owns the zone
        // it will live in.
        'ui/SidebarZones.tsx',
      ],
    ],
  ];

  it.each(SURFACES)('reaches %s from exactly these modules', (_name, re, callers) => {
    // Positive half first: the pattern still matches something, so a rename
    // that broke the regex fails here instead of passing silently.
    expect(filesMatching(re)).toEqual([...callers].sort());
  });

  it('leaves the inline group editor where the group will live, reached from the menu', () => {
    // BC-45's one survivor: `GroupCreateInput` keeps its editor, but its
    // trigger is the New menu's item, not a button of its own.
    expect(filesMatching(/<GroupCreateInput/)).toEqual(['ui/useSectionChrome.tsx']);
    expect(SOURCE.get('ui/useSectionChrome.tsx')).toMatch(/openNewMenu\(item\)/);
  });

  it('gives every section “+” the same deep link and no handler of its own', () => {
    const chrome = SOURCE.get('ui/useSectionChrome.tsx') ?? '';
    const actions = [...chrome.matchAll(/deepLinkAction\('([a-z-]+)'/g)].map((m) => m[1]!);
    expect(actions).toEqual(['new-channel', 'new-message', 'new-agent']);
    // …and there is exactly one `SidebarGroupAction` in the file, the shared
    // one those three all go through.
    expect(chrome.match(/<SidebarGroupAction/g)).toHaveLength(1);
  });
});

describe('BC-44 — the version number leaves the chrome', () => {
  const VERSION_RENDER = /v\$\{|v\{version|`v\$\{model\.version\}/;

  it('renders a version string in the header block’s menu, and in no other module', () => {
    expect(filesMatching(VERSION_RENDER)).toEqual(['ui/header-block-menu.ts']);
  });
});

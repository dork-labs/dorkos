/**
 * **P2 AC-7: exactly one create surface exists.**
 *
 * A scattered create menu grows back the way it grew the first time — one
 * section at a time, each addition reasonable on its own. So the invariant is
 * checked against the source rather than against a rendered tree: a `+` wired
 * to its own handler in a component nobody thought to test still fails here.
 *
 * Four claims, and each is written so it can fail:
 *
 * 1. **Vocabulary.** Every `new-*` action id anywhere in the feature is one of
 *    {@link NEW_MENU_ITEM_IDS}. A section that invents `new-thread` reddens.
 * 2. **Surfaces.** The four modal create surfaces — the channel dialog, the
 *    direct-message picker, the agent-creation store, the smart-group rule form
 *    in `create` mode — are referenced by exactly ONE module, `NewMenu.tsx`.
 *    Putting `ChannelCreateDialog` back into `useSectionChrome` reddens.
 * 3. **The version number** (BC-44). The scan for it deliberately covers the
 *    WHOLE sidebar — this feature plus the footer strip beside it — because the
 *    one place BC-44 is still violated sits outside this feature, and a scan
 *    that could not reach it would state a satisfied contract that is not
 *    satisfied. It is listed with the task that owes its removal instead.
 * 4. **The close-focus guard** (DOR-329). The two menus here that render their
 *    own `DropdownMenuContent` — rather than going through `SidebarMenuSurface`,
 *    which arms it for them — arm it themselves. Forgetting is invisible: the
 *    inline group-name field mounts and is blurred away a commit later, with
 *    nothing logged. The browser suite found it; this catches it in 3ms.
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

/**
 * The whole sidebar as an operator sees it: this feature, plus the footer strip
 * `AppShell` mounts under it.
 *
 * BC-44's claim is about the panel, not about one directory. Scanning only the
 * directory this task happens to own would have made the claim unfalsifiable,
 * because the one place BC-44 is still violated lives in the other one.
 */
const SIDEBAR_DIRS: [label: string, dir: string][] = [
  ['dashboard-sidebar', FEATURE_DIR],
  ['session-list', join(__dirname, '..', '..', 'session-list')],
];

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

/** Every sidebar source file, labelled by the feature it belongs to. */
const SIDEBAR_SOURCE = new Map(
  SIDEBAR_DIRS.flatMap(([label, dir]) =>
    sourceFiles(dir).map((f) => [`${label}/${f}`, readFileSync(join(dir, f), 'utf8')] as const)
  )
);

/** Which files in THIS feature mention a pattern. */
function filesMatching(pattern: RegExp): string[] {
  return [...SOURCE]
    .filter(([, text]) => pattern.test(text))
    .map(([file]) => file)
    .sort();
}

/** Which files across the WHOLE sidebar mention a pattern. */
function sidebarFilesMatching(pattern: RegExp): string[] {
  return [...SIDEBAR_SOURCE]
    .filter(([, text]) => pattern.test(text))
    .map(([file]) => file)
    .sort();
}

describe('the scan itself', () => {
  it('reads the feature, and reads the files these claims are about', () => {
    // Without this, every "no file does X" below is true of an empty scan.
    // A real floor, not a token one: the feature has 57 source files, so a
    // scan that lost half of them would still have cleared a threshold of 20.
    expect(FILES.length).toBeGreaterThanOrEqual(50);
    expect(SIDEBAR_SOURCE.size).toBeGreaterThan(FILES.length);
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

describe('DOR-329 — a menu that opens something does not blur it on the way out', () => {
  /**
   * Every menu in this feature that renders `SidebarMenuNodes` into its own
   * `DropdownMenuContent` rather than through `SidebarMenuSurface`.
   *
   * `SidebarMenuSurface` arms the close-focus guard for its callers. These two
   * do not go through it, so each has to arm it itself — and the cost of
   * forgetting is invisible in a unit test and silent in review: Radix's
   * focus restore lands a commit after the item runs and blurs whatever it
   * opened, so the inline group-name field appeared and vanished with nothing
   * logged. The browser suite is what caught it; this is the cheap guard that
   * would have caught it first.
   */
  const OWN_MENU_CONTENT = ['ui/NewMenu.tsx', 'ui/SidebarHeaderBlock.tsx'];

  /** How many times `pattern` appears in `text`. */
  const count = (text: string, pattern: RegExp): number =>
    [...text.matchAll(new RegExp(pattern, 'g'))].length;

  it.each(OWN_MENU_CONTENT)('arms the close-focus guard on every menu in %s', (file) => {
    const text = SOURCE.get(file) ?? '';
    // Counted, not merely present. "The three strings appear somewhere in this
    // file" would be satisfied by a file that grew a SECOND, unguarded menu
    // beside a guarded one — which is the shape the bug took the first time.
    const contents = count(text, /<DropdownMenuContent/);
    expect(contents).toBeGreaterThan(0);
    expect(count(text, /onCloseAutoFocus=\{guarded\.onCloseAutoFocus\}/)).toBe(contents);
    // …and every one of them renders the GUARDED list, not the raw one.
    expect(count(text, /<SidebarMenuNodes\b/)).toBe(contents);
    expect(count(text, /nodes=\{guarded\.nodes\}/)).toBe(contents);
    expect(text).toMatch(/useGuardedMenuNodes/);
  });

  it('finds no unguarded menu content anywhere else in the feature', () => {
    const withOwnContent = filesMatching(/<DropdownMenuContent/);
    // If a third menu appears, it lands here and has to be added above — with
    // the guard, or with a reason it does not need one.
    expect(withOwnContent).toEqual([...OWN_MENU_CONTENT].sort());
  });
});

describe('BC-44 — the version number leaves the chrome', () => {
  /**
   * A version number being drawn.
   *
   * **This matches spellings, not semantics, and the boundary is worth
   * knowing.** It covers the two forms the sidebar uses today plus the obvious
   * neighbours — a `v`-prefixed template or JSX hole over any identifier whose
   * name ends in `version` (`version`, `model.version`, `serverConfig.version`,
   * `latestVersion`), and a component named `Version…`. What it cannot see is a
   * module that renders a version through a name with no `version` in it
   * (`` {`v${v}`} ``) or assembles the string somewhere else and passes it in.
   * A source scan cannot close that; what closes it is this test failing loudly
   * enough that the next person adding a version line reads it first.
   */
  const VERSION_RENDER =
    /v\$\{[^}]*[Vv]ersion\b[^}]*\}|v\{[^}]*[Vv]ersion\b[^}]*\}|<Version[A-Za-z]*[\s/>]/;

  /**
   * Every module in the sidebar still allowed to draw a version number.
   *
   * **This list is three entries too long, and says so.** BC-44 puts the
   * version in the header block's menu and in DorkBot's seeded context, and
   * nowhere else. The three below all live in the footer strip, which P2.4's
   * disjoint-file guarantee forbids touching — P2.5 owns retiring that strip,
   * and BC-44 replaces its two update cards with one transient "Update ready —
   * Restart" pill. Until then a reader genuinely sees a version number in more
   * than one place, and an assertion scoped so it could not notice would be the
   * more expensive lie.
   *
   * **Two of these were invisible to the first version of this guard**, whose
   * pattern matched only the two literal spellings this feature happened to
   * use. Widening it to any `v`-prefixed render of a `*version` identifier
   * found the update cards immediately — which is the argument for a pattern
   * that is looser than the code you wrote it against.
   *
   * Written as an exact list rather than a "not more than" so P2.5 cannot
   * silently leave an entry behind: deleting a row without deleting its line
   * here fails this test.
   */
  const ALLOWED = [
    'dashboard-sidebar/ui/header-block-menu.ts',
    // OWED BY P2.5 (BC-47): all three go with the footer strip. The two cards
    // become BC-44's single transient update pill.
    'session-list/ui/DesktopUpdateCard.tsx',
    'session-list/ui/SidebarFooterBar.tsx',
    'session-list/ui/SidebarUpgradeCard.tsx',
  ];

  it('scans both halves of the sidebar — the claim is about the panel, not a directory', () => {
    // Without this, the exact list below could pass on a scan that never
    // reached the footer at all.
    const scanned = [...SIDEBAR_SOURCE.keys()];
    expect(scanned).toContain('session-list/ui/SidebarFooterBar.tsx');
    expect(scanned).toContain('dashboard-sidebar/ui/header-block-menu.ts');
  });

  it('draws a version number only where it is still allowed to', () => {
    expect(sidebarFilesMatching(VERSION_RENDER)).toEqual([...ALLOWED].sort());
  });

  it('keeps this feature’s own half of the promise — one module, the header menu', () => {
    expect(filesMatching(VERSION_RENDER)).toEqual(['ui/header-block-menu.ts']);
  });
});

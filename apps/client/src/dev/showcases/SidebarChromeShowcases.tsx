/**
 * The sidebar's persistent chrome: the header block and the one New menu.
 *
 * **The real components, not a lookalike.** An earlier draft hand-copied
 * `SidebarHeaderBlock`'s markup so it could be fed fabricated menu rows, and had
 * already drifted — a `<span>` where the product has a `<button>`, and no focus
 * ring at all. A showcase that draws its own copy cannot catch a regression in
 * the thing it is named after. The Playground supplies a query client, a
 * transport and a memory router (`DevPlayground`), so the live blocks below
 * mount exactly as they do in the cockpit.
 *
 * **A node list needs a menu root.** `SidebarMenuNodes` renders Radix
 * `DropdownMenuItem`, which throws outside a `DropdownMenu` — so the drafts that
 * dropped a list into a bare `<div>` to show it "flat" took the whole section
 * down with them, live components included. Every list here therefore goes
 * through `SidebarMenuSurface`, which owns both menu roots and is the standing
 * pattern in `AgentSidebarShowcases`. Right-click the target or press its ⋮.
 *
 * @module dev/showcases/SidebarChromeShowcases
 */
import { Users } from 'lucide-react';
import { SidebarMenuSurface, type SidebarMenuNode } from '@/layers/shared/ui';
import {
  buildHeaderBlockMenuNodes,
  buildNewMenuNodes,
  NewMenu,
  SidebarHeaderBlock,
  SidebarSearchPill,
} from '@/layers/features/dashboard-sidebar';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The sidebar chrome showcases. */
export function SidebarChromeShowcases() {
  return (
    <>
      <SidebarHeaderBlockShowcase />
      <NewMenuShowcase />
      <SidebarSearchPillShowcase />
    </>
  );
}

const noop = () => {};

/**
 * One node list, openable.
 *
 * `SidebarMenuSurface` brings its own `ContextMenu` and `DropdownMenu` roots,
 * which is the whole reason to route through it: a list rendered without one
 * throws on its first item.
 *
 * @param props - The list, and what to call the target that opens it.
 */
function MenuTarget({ nodes, label }: { nodes: SidebarMenuNode[]; label: string }) {
  return (
    <SidebarMenuSurface nodes={nodes} actionsLabel={label} className="w-72">
      <div className="border-sidebar-border text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground flex w-full cursor-context-menu items-center rounded-lg border border-dashed py-3 pr-8 pl-4 text-xs transition-colors">
        {label} — right-click, or hover for the ⋮
      </div>
    </SidebarMenuSurface>
  );
}

/** The header block, live, plus the growth case its menu is built for. */
function SidebarHeaderBlockShowcase() {
  const short = buildHeaderBlockMenuNodes({
    onOpenSettings: noop,
    onOpenAccount: noop,
    version: '0.58.0',
    isDevMode: false,
    onCheckForUpdates: noop,
  });
  const community = (id: string, label: string): SidebarMenuNode => ({
    kind: 'action',
    id,
    label,
    icon: Users,
    opensInput: false,
    run: noop,
  });
  // What "communities shipped" looks like from inside the menu: more rows, in
  // the same list, above the version line.
  const long: SidebarMenuNode[] = [
    ...short.slice(0, 2),
    { kind: 'separator', id: 'sep-communities' },
    community('community-acme', 'Acme Robotics'),
    community('community-side', 'Side project'),
    ...short.slice(2),
  ];

  return (
    <PlaygroundSection
      title="SidebarHeaderBlock"
      description="The panel's identity, named after the operator, and a button from day one — press it for Workspace settings, Account and a quiet version line. The New button and the ⌘K pill are its neighbours. This is the real component wired to this install, so the name it shows is whatever your own profile says (or 'Your team' until you have set one)."
    >
      <ShowcaseLabel>Live — the block, the New button, the ⌘K pill</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar w-64 rounded-lg">
          <SidebarHeaderBlock />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Its menu today — three rows</ShowcaseLabel>
      <ShowcaseDemo>
        <MenuTarget nodes={short} label="Header menu today" />
      </ShowcaseDemo>

      <ShowcaseLabel>
        …and once communities ship — six rows, and the block above does not move
      </ShowcaseLabel>
      <ShowcaseDemo>
        <MenuTarget nodes={long} label="Header menu with communities" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The one create surface — live, plus its item list at both fleet sizes. */
function NewMenuShowcase() {
  const base = {
    onNewSession: noop,
    onNewChannel: noop,
    onNewMessage: noop,
    onNewAgent: noop,
    smartGroupPresets: [],
    onCreatePresetSmartGroup: noop,
    onOpenSmartGroupDialog: noop,
    onNewGroup: noop,
  };
  const small = buildNewMenuNodes({
    ...base,
    lastUsedAgentName: null,
    showSessionShortcut: false,
  });
  const large = buildNewMenuNodes({
    ...base,
    lastUsedAgentName: 'code-reviewer',
    showSessionShortcut: true,
    smartGroupPresets: [
      { label: 'Active now', rules: { statuses: ['needs-attention', 'active'] } },
      { label: 'By runtime · Claude Code', rules: { runtimes: ['claude-code'] } },
    ],
  });

  return (
    <PlaygroundSection
      title="NewMenu"
      description="The sidebar's only create surface. A section's hover + runs no handler of its own — it opens this menu on the matching item. Agent group appears once you are running eight agents or two runtimes, and ⌘N is advertised only in the desktop app, where the key is not already the browser's. The live button below opens the real menu for this install; the two targets under it are the same builder at both fleet sizes."
    >
      <ShowcaseLabel>Live — press it</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar flex w-64 justify-end rounded-lg p-2">
          <NewMenu />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Small cockpit, in a browser</ShowcaseLabel>
      <ShowcaseDemo>
        <MenuTarget nodes={small} label="New menu — small cockpit" />
      </ShowcaseDemo>

      <ShowcaseLabel>Eight agents, on the desktop app, with a last-used agent</ShowcaseLabel>
      <ShowcaseDemo>
        <MenuTarget nodes={large} label="New menu — eight agents on desktop" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The ⌘K pill on its own, so its tint and its chord are readable in isolation. */
function SidebarSearchPillShowcase() {
  return (
    <PlaygroundSection
      title="SidebarSearchPill"
      description="Opens the same command palette ⌘K opens — the flag it flips is the one the chord flips, so there is no second search to drift. It rides the --sidebar-accent ramp rather than --muted, which sits lighter than the panel in light mode and darker in dark mode and so would flip the separation between themes."
    >
      <ShowcaseLabel>Live</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar w-64 rounded-lg p-2">
          <SidebarSearchPill />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

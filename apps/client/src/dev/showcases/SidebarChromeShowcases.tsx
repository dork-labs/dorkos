/**
 * The sidebar's persistent chrome: the header block and the one New menu.
 *
 * **The real components, not a lookalike.** An earlier draft of this file
 * hand-copied `SidebarHeaderBlock`'s markup so it could be fed fabricated menu
 * rows, and had already drifted — a `<span>` where the product has a `<button>`,
 * and no focus ring at all. A showcase that draws its own copy cannot catch a
 * regression in the thing it is named after, which is the entire job. The
 * Playground supplies a query client, a transport and a memory router
 * (`DevPlayground`), so these mount exactly as they do in the cockpit.
 *
 * The one thing that still cannot be driven from outside is the header menu's
 * LENGTH — BC-43's "communities make the menu longer and nothing outside it
 * moves". That is shown beside the live block as the menu's own node list at
 * three rows and at six, rendered through the same `SidebarMenuNodes` the block
 * uses. `SidebarHeaderBlock.test.tsx` is what asserts the block's box does not
 * change between them.
 *
 * @module dev/showcases/SidebarChromeShowcases
 */
import { Users } from 'lucide-react';
import { SidebarMenuNodes, type SidebarMenuNode } from '@/layers/shared/ui';
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
  // What "communities shipped" looks like from inside the menu: three more
  // rows, in the same list, above the version line.
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
        <div className="bg-popover w-56 rounded-md border p-1">
          <SidebarMenuNodes variant="dropdown" nodes={short} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        …and once communities ship — six rows, and the block does not move
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-56 rounded-md border p-1">
          <SidebarMenuNodes variant="dropdown" nodes={long} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The one create surface — live, plus the item list at both fleet sizes. */
function NewMenuShowcase() {
  const base = {
    onNewSession: noop,
    onNewChannel: noop,
    onNewMessage: noop,
    onNewAgent: noop,
    smartGroupPresets: [],
    onCreatePresetSmartGroup: noop,
    onOpenSmartGroupDialog: noop,
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
    onNewGroup: noop,
    smartGroupPresets: [
      { label: 'Active now', rules: { statuses: ['needs-attention', 'active'] } },
      { label: 'By runtime · Claude Code', rules: { runtimes: ['claude-code'] } },
    ],
  });

  return (
    <PlaygroundSection
      title="NewMenu"
      description="The sidebar's only create surface. A section's hover + runs no handler of its own — it opens this menu on the matching item. Agent group appears once you are running eight agents or two runtimes, and ⌘N is advertised only in the desktop app, where the key is not already the browser's. The live button below opens the real menu for this install; the two lists under it are the same builder at both fleet sizes."
    >
      <ShowcaseLabel>Live — press it</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar flex w-64 justify-end rounded-lg p-2">
          <NewMenu />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Small cockpit, in a browser</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-56 rounded-md border p-1">
          <SidebarMenuNodes variant="dropdown" nodes={small} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Eight agents, on the desktop app, with a last-used agent</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-popover w-56 rounded-md border p-1">
          <SidebarMenuNodes variant="dropdown" nodes={large} />
        </div>
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

/**
 * The sidebar's persistent chrome: the header block and the one New menu.
 *
 * @module dev/showcases/SidebarChromeShowcases
 */
import { ChevronDown, Plus, Search, Users } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Kbd,
  SidebarMenuNodes,
} from '@/layers/shared/ui';
import { buildHeaderBlockMenuNodes, buildNewMenuNodes } from '@/layers/features/dashboard-sidebar';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The sidebar chrome showcases. */
export function SidebarChromeShowcases() {
  return (
    <>
      <SidebarHeaderBlockShowcase />
      <NewMenuShowcase />
    </>
  );
}

/**
 * The header block's chrome, drawn from its own builders.
 *
 * The live components read a roster, a transport and a router, none of which
 * the playground has — so what is shown here is the real markup fed by the real
 * pure builders (`buildHeaderBlockMenuNodes`, `buildNewMenuNodes`) through the
 * real menu renderer. What you cannot see here is only the wiring.
 */
function SidebarHeaderBlockShowcase() {
  const noop = () => {};
  const short = buildHeaderBlockMenuNodes({
    onOpenSettings: noop,
    onOpenAccount: noop,
    version: '0.58.0',
    isDevMode: false,
    onCheckForUpdates: noop,
  });
  // What "communities shipped" looks like: the same menu, longer. Nothing
  // outside it moves (BC-43).
  const long = [
    ...short.slice(0, 2),
    { kind: 'separator' as const, id: 'sep-communities' },
    {
      kind: 'action' as const,
      id: 'community-acme',
      label: 'Acme Robotics',
      icon: Users,
      opensInput: false,
      run: noop,
    },
    {
      kind: 'action' as const,
      id: 'community-side',
      label: 'Side project',
      icon: Users,
      opensInput: false,
      run: noop,
    },
    ...short.slice(2),
  ];

  return (
    <PlaygroundSection
      title="SidebarHeaderBlock"
      description="The panel's identity, named after the operator, and a button from day one. Its menu holds Workspace settings, Account and a quiet version line — the version number's only home in the chrome. When communities ship they arrive as more rows in this same menu: the menu gets longer, and nothing outside it moves."
    >
      <ShowcaseLabel>Today — three rows</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar w-64 rounded-lg p-2">
          <HeaderBlockChrome nodes={short} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>With communities — six rows, same block</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar w-64 rounded-lg p-2">
          <HeaderBlockChrome nodes={long} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The block, its menu, the New button and the ⌘K pill — markup only. */
function HeaderBlockChrome({
  nodes,
}: {
  nodes: React.ComponentProps<typeof SidebarMenuNodes>['nodes'];
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="text-sidebar-foreground hover:bg-sidebar-accent/70 flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] font-semibold"
            >
              <span className="truncate">Dorian&rsquo;s team</span>
              <ChevronDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <SidebarMenuNodes variant="dropdown" nodes={nodes} />
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="bg-sidebar-accent text-sidebar-accent-foreground flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium">
          <Plus className="size-3.5" />
          New
        </span>
      </div>
      <span className="bg-sidebar-accent/40 text-sidebar-foreground/60 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px]">
        <Search className="size-(--size-icon-sm) shrink-0" />
        <span className="truncate">Jump to anything…</span>
        <Kbd className="bg-sidebar-accent text-sidebar-foreground/70 ml-auto shrink-0 border-transparent">
          ⌘K
        </Kbd>
      </span>
    </div>
  );
}

/** The one create surface, at both fleet sizes. */
function NewMenuShowcase() {
  const noop = () => {};
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
      description="The sidebar's only create surface. A section's hover + does not run a handler of its own — it opens this menu on the matching item. Agent group appears once you are running eight agents or two runtimes, and ⌘N is advertised only in the desktop app, where the key is not already the browser's."
    >
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

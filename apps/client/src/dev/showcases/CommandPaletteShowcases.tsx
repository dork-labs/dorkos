import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup } from '@/layers/shared/ui';
import {
  AgentCommandItem,
  AgentSubMenu,
  HighlightedText,
  PaletteFooter,
} from '@/layers/features/command-palette';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_AGENTS: AgentPathEntry[] = [
  {
    id: 'agent-frontend',
    name: 'Frontend App',
    projectPath: '/Users/kai/projects/dork-os/apps/client',
    icon: '🎨',
    color: 'hsl(210, 80%, 55%)',
  },
  {
    id: 'agent-backend',
    name: 'API Server',
    projectPath: '/Users/kai/projects/dork-os/apps/server',
    icon: '⚡',
    color: 'hsl(150, 70%, 45%)',
  },
  {
    id: 'agent-docs',
    name: 'Documentation',
    projectPath: '/Users/kai/projects/dork-os/docs',
    icon: '📚',
  },
  { id: 'agent-cli', name: 'CLI Tool', projectPath: '/Users/kai/projects/dork-os/packages/cli' },
  {
    id: 'agent-infra',
    name: 'Infrastructure',
    projectPath: '/Users/kai/projects/dork-os/infra',
    icon: '🏗️',
    color: 'hsl(30, 85%, 55%)',
  },
];

const LONG_NAME_AGENT: AgentPathEntry = {
  id: 'agent-long',
  name: 'My Extremely Long Agent Name That Should Truncate Gracefully',
  projectPath:
    '/Users/kai/projects/very-deeply-nested/workspace/packages/extremely-long-package-name-here',
};

const MOCK_SESSIONS = [
  {
    id: 'sess-1',
    title: 'Fix auth middleware',
    lastActive: new Date(Date.now() - 30 * 60000).toISOString(),
  },
  {
    id: 'sess-2',
    title: 'Add rate limiting',
    lastActive: new Date(Date.now() - 3 * 3600000).toISOString(),
  },
  { id: 'sess-3', title: null, lastActive: new Date(Date.now() - 48 * 3600000).toISOString() },
];

// ---------------------------------------------------------------------------
// AgentCommandItem showcase
// ---------------------------------------------------------------------------

function AgentItemStates() {
  const [selected, setSelected] = useState(0);

  return (
    <div className="space-y-4">
      <ShowcaseLabel>Default agent item</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <CommandGroup>
              {MOCK_AGENTS.map((agent, i) => (
                <AgentCommandItem
                  key={agent.id}
                  agent={agent}
                  isActive={i === 0}
                  isSelected={i === selected}
                  onSelect={() => setSelected(i)}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>With search highlighting</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <CommandGroup heading='Search: "front"'>
              <AgentCommandItem
                agent={MOCK_AGENTS[0]}
                isActive={false}
                isSelected
                onSelect={() => {}}
                nameIndices={[[0, 4]]}
              />
            </CommandGroup>
            <CommandGroup heading='Search: "cli"'>
              <AgentCommandItem
                agent={MOCK_AGENTS[3]}
                isActive={false}
                isSelected={false}
                onSelect={() => {}}
                nameIndices={[[0, 2]]}
              />
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>Active agent (checkmark)</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <CommandGroup>
              <AgentCommandItem agent={MOCK_AGENTS[1]} isActive isSelected onSelect={() => {}} />
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>Hash-based fallback (no icon/color override)</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <CommandGroup>
              <AgentCommandItem
                agent={MOCK_AGENTS[3]}
                isActive={false}
                isSelected
                onSelect={() => {}}
              />
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HighlightedText showcase
// ---------------------------------------------------------------------------

function HighlightedTextVariants() {
  return (
    <div className="space-y-4">
      <ShowcaseLabel>Single match range</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2 text-sm">
          <HighlightedText text="Frontend App" indices={[[0, 4]]} />
          <div className="text-muted-foreground text-xs">
            indices: [[0, 4]] — &ldquo;Front&rdquo; bolded
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Multiple disjoint ranges</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2 text-sm">
          <HighlightedText
            text="Infrastructure"
            indices={[
              [0, 2],
              [5, 8],
            ]}
          />
          <div className="text-muted-foreground text-xs">
            indices: [[0, 2], [5, 8]] — fuzzy match
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>No match (passthrough)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2 text-sm">
          <HighlightedText text="CLI Tool" />
          <div className="text-muted-foreground text-xs">
            indices: undefined — renders plain text
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Full match</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2 text-sm">
          <HighlightedText text="docs" indices={[[0, 3]]} />
          <div className="text-muted-foreground text-xs">
            indices: [[0, 3]] — entire string bolded
          </div>
        </div>
      </ShowcaseDemo>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentSubMenu showcase
// ---------------------------------------------------------------------------

function SubMenuStates() {
  return (
    <div className="space-y-4">
      <ShowcaseLabel>With recent sessions</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <AgentSubMenu
              agent={MOCK_AGENTS[1]}
              onOpenHere={() => {}}
              onOpenNewTab={() => {}}
              onNewSession={() => {}}
              recentSessions={MOCK_SESSIONS}
            />
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>No recent sessions</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <AgentSubMenu
              agent={MOCK_AGENTS[2]}
              onOpenHere={() => {}}
              onOpenNewTab={() => {}}
              onNewSession={() => {}}
              recentSessions={[]}
            />
          </CommandList>
        </Command>
      </ShowcaseDemo>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaletteFooter showcase
// ---------------------------------------------------------------------------

function FooterStates() {
  return (
    <div className="space-y-4">
      <ShowcaseLabel>Root page — no agent selected</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="overflow-hidden rounded-lg border">
          <PaletteFooter page={undefined} hasAgentSelected={false} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Root page — agent selected</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="overflow-hidden rounded-lg border">
          <PaletteFooter page={undefined} hasAgentSelected />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Agent sub-menu page</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="overflow-hidden rounded-lg border">
          <PaletteFooter page="agent-actions" hasAgentSelected />
        </div>
      </ShowcaseDemo>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edge cases showcase
// ---------------------------------------------------------------------------

const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60_000).toISOString();

function EdgeCases() {
  return (
    <div className="space-y-4">
      <ShowcaseLabel>Truncation — long name & path</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <CommandGroup>
              <AgentCommandItem
                agent={LONG_NAME_AGENT}
                isActive={false}
                isSelected
                onSelect={() => {}}
              />
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>Empty search results</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandInput placeholder="Search..." value="xyznonexistent" readOnly />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>Many agents (scroll behavior)</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList className="max-h-[200px]">
            <CommandGroup heading="All Agents (10)">
              {[...MOCK_AGENTS, ...MOCK_AGENTS].map((agent, i) => (
                <AgentCommandItem
                  key={`${agent.id}-${i}`}
                  agent={{ ...agent, id: `${agent.id}-${i}`, name: `${agent.name} ${i + 1}` }}
                  isActive={i === 0}
                  isSelected={i === 0}
                  onSelect={() => {}}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>

      <ShowcaseLabel>Untitled session in sub-menu</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="rounded-lg border">
          <CommandList>
            <AgentSubMenu
              agent={MOCK_AGENTS[0]}
              onOpenHere={() => {}}
              onOpenNewTab={() => {}}
              onNewSession={() => {}}
              recentSessions={[
                {
                  id: 'sess-untitled',
                  title: null,
                  lastActive: FIVE_MINUTES_AGO,
                },
              ]}
            />
          </CommandList>
        </Command>
      </ShowcaseDemo>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live palette trigger
// ---------------------------------------------------------------------------

function LivePaletteTrigger() {
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">
        The full command palette is globally available. Press{' '}
        <kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">⌘K</kbd> to open it with
        live data from your running server.
      </p>
      <div className="text-muted-foreground space-y-1 text-xs">
        <p>
          <strong>Prefix modes:</strong> Type <code>@</code> to filter agents only,{' '}
          <code>&gt;</code> for commands only.
        </p>
        <p>
          <strong>Navigation:</strong> Arrow keys to move, Enter to select, Backspace to go back
          from sub-menus.
        </p>
        <p>
          <strong>Frecency:</strong> Recently used agents appear first, scored with Slack-style
          time-decay buckets.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/** Command palette showcases: item states, highlighting, sub-menus, footer, and edge cases. */
export function CommandPaletteShowcases() {
  return (
    <>
      <PlaygroundSection
        title="AgentCommandItem"
        description="Agent rows in the palette with color dot, emoji, name, path, active checkmark, and sliding selection indicator."
      >
        <AgentItemStates />
      </PlaygroundSection>

      <PlaygroundSection
        title="HighlightedText"
        description="Fuse.js match highlighting — renders matched character ranges with bold emphasis."
      >
        <HighlightedTextVariants />
      </PlaygroundSection>

      <PlaygroundSection
        title="AgentSubMenu"
        description="Drill-down page shown when selecting an agent. Actions (Open Here, New Tab, New Session) and recent sessions."
      >
        <SubMenuStates />
      </PlaygroundSection>

      <PlaygroundSection
        title="PaletteFooter"
        description="Context-sensitive keyboard shortcut hints. Changes based on page and selection state."
      >
        <FooterStates />
      </PlaygroundSection>

      <PlaygroundSection
        title="Edge Cases"
        description="Long names, empty results, scroll overflow, untitled sessions, and hash-based fallbacks."
      >
        <EdgeCases />
      </PlaygroundSection>

      <PlaygroundSection
        title="Live Palette"
        description="The full CommandPaletteDialog with live server data, fuzzy search, frecency sorting, and prefix modes."
      >
        <ShowcaseDemo>
          <LivePaletteTrigger />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}

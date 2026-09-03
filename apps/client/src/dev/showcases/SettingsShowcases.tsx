import { useState } from 'react';
import { Palette, Settings2, Server } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import {
  Button,
  FieldCard,
  FieldCardContent,
  SettingRow,
  Switch,
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
  NavigationLayoutDialogHeader,
} from '@/layers/shared/ui';
import { SettingsDialog } from '@/layers/features/settings';
import {
  AppearanceResetAction,
  AppearanceTab,
} from '@/layers/features/settings/ui/tabs/AppearanceTab';
import { PreferencesTab } from '@/layers/features/settings/ui/tabs/PreferencesTab';
import { NotificationsTab } from '@/layers/features/settings/ui/tabs/NotificationsTab';
import { RoomsTab } from '@/layers/features/settings/ui/tabs/RoomsTab';
import { ServerTab } from '@/layers/features/settings/ui/ServerTab';
import { ToolsResetAction, ToolsTab } from '@/layers/features/settings/ui/ToolsTab';
import { AdvancedTab } from '@/layers/features/settings/ui/AdvancedTab';
import { ExperimentsTab } from '@/layers/features/settings/ui/ExperimentsTab';
import { BackgroundSystemsCard } from '@/layers/features/settings/ui/tools/BackgroundSystemsCard';
import { ClaudeAccountsSection, ExecutionExceptionsStrip } from '@/layers/features/settings';
import { ControlCenterBody } from '@/layers/widgets/control-center';
import {
  LiveRuntimeCard,
  MockedQueryProvider,
  RefusedConfigWriteProvider,
  TabShell,
} from './settings-showcase-helpers';
import {
  MOCK_EXECUTION_DEVIATIONS,
  MOCK_EXECUTION_EXCEPTIONS,
  MOCK_SERVER_CONFIG_EXPERIMENT_LOCKED,
  MOCK_SERVER_CONFIG_MULTI_ACCOUNT,
  MOCK_SERVER_CONFIG_NO_EXPERIMENTS,
} from './settings-mock-data';

/** Comprehensive showcase for the Settings dialog system. */
export function SettingsShowcases() {
  return (
    <>
      <FullSettingsDialogSection />
      <IndividualTabsSection />
      <ClaudeAccountsShowcaseSection />
      <ExecutionExceptionsSection />
      <BackgroundSystemsSection />
      <MobileDrillInSection />
      <LoadingEmptyStatesSection />
      <PrimitivesSection />
      <ControlCenterShowcaseSection />
    </>
  );
}

/**
 * The Control Center flyout's contents (spec `full-power-defaults`, D7): the
 * global Trust Dial, the power switches, the overrides ledger and the
 * unattended-status line. Shown here as the body without its popover shell, on
 * the playground's mock data — an install with no exceptions renders the calm
 * empty ledger.
 */
function ControlCenterShowcaseSection() {
  return (
    <PlaygroundSection
      title="Control Center"
      description="See and change the fleet's power at a glance — the dial, the switches and the overrides ledger."
    >
      <ShowcaseDemo>
        <div className="max-w-sm">
          <ControlCenterBody />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Section 2b — the Claude Code billing-account section in every state it can
 * reach (spec `claude-code-accounts`).
 *
 * It used to be a card of its own at the bottom of the Runtimes tab; it is now a
 * section the Claude Code runtime declares, so it is shown where it actually
 * renders — inside that card's opened body. Worth its own playground section
 * because three of these states are invisible on the playground's default data:
 * a registered roster, a folder that is not an account yet, and a refused write.
 */
function ClaudeAccountsShowcaseSection() {
  return (
    <PlaygroundSection
      title="Claude Code Accounts"
      description="Which Claude account new work runs and bills on, inside the Claude Code card that carries it. An operator running one account per client registers each folder here and names it after the client."
    >
      <ShowcaseLabel>Default install: nothing registered</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <LiveRuntimeCard type="claude-code" expanded renderSection={accountsSection} />
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Several accounts: one in use, one unnamed, one not an account yet
      </ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider config={MOCK_SERVER_CONFIG_MULTI_ACCOUNT}>
          <LiveRuntimeCard
            type="claude-code"
            expanded
            renderSection={accountsSection}
            sectionValues={{ 'claude-accounts': 'Acme Corp' }}
          />
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Write refused: pick an account to see the message</ShowcaseLabel>
      <ShowcaseDemo>
        <RefusedConfigWriteProvider>
          <MockedQueryProvider config={MOCK_SERVER_CONFIG_MULTI_ACCOUNT}>
            <LiveRuntimeCard
              type="claude-code"
              expanded
              renderSection={accountsSection}
              sectionValues={{ 'claude-accounts': 'Acme Corp' }}
            />
          </MockedQueryProvider>
        </RefusedConfigWriteProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Claude Code's declared accounts section, drawn the way the card's registry draws it. */
function accountsSection(kind: string) {
  return kind === 'claude-accounts' ? <ClaudeAccountsSection /> : null;
}

/**
 * Section 2c — the exceptions strip beneath the runtime cards.
 *
 * The strip is normally the fleet's own answer, read through a hook, which is
 * why it had no playground coverage: the playground has no fleet. It now takes
 * an injected list, so every shape it can be in is reachable here — including
 * the one that matters most, which is drawing nothing at all.
 */
function ExecutionExceptionsSection() {
  return (
    <PlaygroundSection
      title="Execution Exceptions Strip"
      description="Every agent that does not run on the defaults above. Broken rows come first, in warning color, because those are the ones that stopped working rather than the ones somebody chose. The order is the caller's: the strip draws the list it is handed, so nothing here re-sorts."
    >
      <ShowcaseLabel>
        Broken first, then the deviations: a runtime nobody connected, a model that is gone, an
        effort the runtime has no use for
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <ExecutionExceptionsStrip exceptions={MOCK_EXECUTION_EXCEPTIONS} />
      </ShowcaseDemo>

      <ShowcaseLabel>Choices only: nothing is broken, so nothing is amber</ShowcaseLabel>
      <ShowcaseDemo>
        <ExecutionExceptionsStrip exceptions={MOCK_EXECUTION_DEVIATIONS} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        A fleet that inherits everything: the strip draws nothing at all, on purpose
      </ShowcaseLabel>
      <ShowcaseDemo>
        <ExecutionExceptionsStrip exceptions={[]} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Section 1 — full Settings dialog driven by a state-bound trigger button. */
function FullSettingsDialogSection() {
  const [open, setOpen] = useState(false);
  return (
    <PlaygroundSection
      title="Full Settings Dialog"
      description="The complete Settings dialog with all tabs. Server and Tools tabs render in their empty state because the playground transport returns null for all queries — see Loading & Empty States for richer demos."
    >
      <ShowcaseDemo responsive>
        <Button onClick={() => setOpen(true)}>Open Settings</Button>
        <SettingsDialog open={open} onOpenChange={setOpen} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Section 2d — the Tools tab's background-system switches in every state their
 * copy branches on (spec `team-room-home` D6).
 *
 * Three of these four are invisible on the playground's default data, and each
 * one is a different sentence under the same switch. They are the states where
 * getting the wording wrong tells a person something untrue about their own
 * machine, so they are shown side by side where that is easy to see.
 */
function BackgroundSystemsSection() {
  const noop = () => undefined;
  return (
    <PlaygroundSection
      title="Background Systems"
      description="Turning a background system off is saved immediately but only takes effect at the next start, and two other states look identical from the switch's point of view. Each row states which one it is in."
    >
      <ShowcaseLabel>Both running, settings agree</ShowcaseLabel>
      <ShowcaseDemo>
        <BackgroundSystemsCard
          tasks={{ running: true, enabledInConfig: true, lockedByEnv: false }}
          relay={{ running: true, enabledInConfig: true, lockedByEnv: false }}
          onTasksChange={noop}
          onRelayChange={noop}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Restart pending — turned off, still running</ShowcaseLabel>
      <ShowcaseDemo>
        <BackgroundSystemsCard
          tasks={{ running: true, enabledInConfig: false, lockedByEnv: false }}
          relay={{ running: true, enabledInConfig: false, lockedByEnv: false }}
          onTasksChange={noop}
          onRelayChange={noop}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Locked by an environment variable</ShowcaseLabel>
      <ShowcaseDemo>
        <BackgroundSystemsCard
          tasks={{ running: false, enabledInConfig: true, lockedByEnv: true }}
          relay={{ running: true, enabledInConfig: false, lockedByEnv: true }}
          onTasksChange={noop}
          onRelayChange={noop}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Failed to start — on, but crashed at boot</ShowcaseLabel>
      <ShowcaseDemo>
        <BackgroundSystemsCard
          tasks={{ running: true, enabledInConfig: true, lockedByEnv: false }}
          relay={{
            running: false,
            enabledInConfig: true,
            lockedByEnv: false,
            initError: "EACCES: permission denied, open '/Users/dev/.dork/relay/adapters.json'",
          }}
          onTasksChange={noop}
          onRelayChange={noop}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Section 3 — every settings tab rendered standalone inside a bare `NavigationLayout`. */
function IndividualTabsSection() {
  return (
    <PlaygroundSection
      title="Individual Tabs"
      description="Each settings tab rendered in isolation inside a bare NavigationLayout shell. Useful for iterating on a single tab without opening the full dialog."
    >
      <ShowcaseLabel>Appearance Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="appearance" title="Appearance" actions={<AppearanceResetAction />}>
          <AppearanceTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Preferences Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="preferences" title="Preferences">
          <PreferencesTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Notifications Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="notifications" title="Notifications">
            <NotificationsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Server Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="server" title="Server">
            <ServerTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Tools Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="tools" title="Tools" actions={<ToolsResetAction />}>
            <ToolsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Rooms Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="rooms" title="Rooms">
            <RoomsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Advanced Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="advanced" title="Advanced">
          <AdvancedTab />
        </TabShell>
      </ShowcaseDemo>

      <ShowcaseLabel>Experiments Tab</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider>
          <TabShell value="experiments" title="Experiments">
            <ExperimentsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      {/* The two states the tab can be in that the shipped config never shows at
          the same time: a row an environment variable has taken over, and the
          empty registry that IS the success state once every flag graduates. */}
      <ShowcaseLabel>Experiments Tab — locked by environment</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider config={MOCK_SERVER_CONFIG_EXPERIMENT_LOCKED}>
          <TabShell value="experiments" title="Experiments">
            <ExperimentsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Experiments Tab — nothing cooking</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider config={MOCK_SERVER_CONFIG_NO_EXPERIMENTS}>
          <TabShell value="experiments" title="Experiments">
            <ExperimentsTab />
          </TabShell>
        </MockedQueryProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Section 4 — narrow-viewport drill-in interaction for the Settings sidebar. */
function MobileDrillInSection() {
  const [active, setActive] = useState('preferences');
  return (
    <PlaygroundSection
      title="Mobile Drill-In"
      description="At narrow viewports the sidebar collapses to a list view, and tapping an item drills into the panel with a back button. Use the viewport toggle to see the responsive behavior."
    >
      <ShowcaseDemo responsive>
        <div className="border-border overflow-hidden rounded-lg border" style={{ height: 480 }}>
          <NavigationLayout value={active} onValueChange={setActive}>
            <NavigationLayoutDialogHeader>
              {/* A plain heading, not `ResponsiveDialogTitle` (DOR-1117).
                  This header was copied from `tabbed-dialog.tsx`, where it sits
                  inside a `ResponsiveDialog` — but this demo shows the layout
                  standalone in a bordered box, with no dialog anywhere. So
                  `ResponsiveDialogTitle` found no context and threw
                  "useResponsiveDialog must be used within a <ResponsiveDialog>",
                  and this whole section had been a red error card for as long
                  as nothing loaded /dev/settings. On desktop the real component
                  renders a Radix `DialogTitle`, which is an `h2` — so this is
                  what it looked like when it worked. */}
              <h2 className="text-sm leading-none font-medium tracking-tight">Settings</h2>
            </NavigationLayoutDialogHeader>
            <NavigationLayoutBody>
              <NavigationLayoutSidebar>
                <NavigationLayoutItem value="appearance" icon={Palette}>
                  Appearance
                </NavigationLayoutItem>
                <NavigationLayoutItem value="preferences" icon={Settings2}>
                  Preferences
                </NavigationLayoutItem>
                <NavigationLayoutItem value="server" icon={Server}>
                  Server
                </NavigationLayoutItem>
              </NavigationLayoutSidebar>
              <NavigationLayoutContent className="p-4">
                <NavigationLayoutPanel value="appearance">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Appearance</NavigationLayoutPanelHeader>
                    <AppearanceTab />
                  </div>
                </NavigationLayoutPanel>
                <NavigationLayoutPanel value="preferences">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Preferences</NavigationLayoutPanelHeader>
                    <PreferencesTab />
                  </div>
                </NavigationLayoutPanel>
                <NavigationLayoutPanel value="server">
                  <div className="space-y-4">
                    <NavigationLayoutPanelHeader>Server</NavigationLayoutPanelHeader>
                    <MockedQueryProvider>
                      <ServerTab />
                    </MockedQueryProvider>
                  </div>
                </NavigationLayoutPanel>
              </NavigationLayoutContent>
            </NavigationLayoutBody>
          </NavigationLayout>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * Section 5 — empty branches of data-driven tabs.
 *
 * Every settings tab is parameterless after the `settings-dialog-02-tabbed-primitive`
 * migration, so loading vs empty vs loaded is purely a function of what the surrounding
 * `QueryClient` knows. These showcases deliberately omit `MockedQueryProvider` so the
 * tabs fall through to the playground's null transport and render their no-data branches.
 */
function LoadingEmptyStatesSection() {
  return (
    <PlaygroundSection
      title="Loading & Empty States"
      description="Skeleton and empty-state renderings for data-driven tabs. The playground transport returns null for all queries, so unwrapped tabs render their no-data branches."
    >
      <ShowcaseLabel>Server Tab — Empty (no config)</ShowcaseLabel>
      <ShowcaseDemo>
        <TabShell value="server" title="Server">
          <ServerTab />
        </TabShell>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Section 6 — settings primitives (FieldCard, SettingRow) used by every tab. */
function PrimitivesSection() {
  const [toggleA, setToggleA] = useState(true);
  const [toggleB, setToggleB] = useState(false);
  return (
    <PlaygroundSection
      title="Settings Primitives"
      description="Building blocks used by every settings tab — FieldCard wraps groups of rows, SettingRow is the horizontal label/description/control row."
    >
      <ShowcaseLabel>FieldCard with SettingRows</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldCard>
          <FieldCardContent>
            <SettingRow label="Show timestamps" description="Display message timestamps in chat">
              <Switch checked={toggleA} onCheckedChange={setToggleA} />
            </SettingRow>
            <SettingRow label="Auto-hide tool calls" description="Fade out completed tool calls">
              <Switch checked={toggleB} onCheckedChange={setToggleB} />
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      </ShowcaseDemo>

      <ShowcaseLabel>FieldCard — single row</ShowcaseLabel>
      <ShowcaseDemo>
        <FieldCard>
          <FieldCardContent>
            <SettingRow label="Theme">
              <Button variant="outline" size="sm">
                System
              </Button>
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      </ShowcaseDemo>

      <ShowcaseLabel>SettingRow — disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <SettingRow label="Background sync" description="Needs a paid plan.">
          <Switch checked={false} disabled />
        </SettingRow>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

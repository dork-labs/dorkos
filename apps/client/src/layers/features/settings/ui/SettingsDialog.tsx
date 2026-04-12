import { useState } from 'react';
import { Palette, Settings2, LayoutList, Server, Wrench, Radio, Bot, Cog } from 'lucide-react';
import { TabbedDialog, type TabbedDialogTab } from '@/layers/shared/ui';
import { useSettingsDeepLink, type SettingsTab } from '@/layers/shared/model';
import { AppearanceTab } from './tabs/AppearanceTab';
import { PreferencesTab } from './tabs/PreferencesTab';
import { StatusBarTab } from './tabs/StatusBarTab';
import { ServerTab } from './ServerTab';
import { ToolsTab } from './ToolsTab';
import { ChannelsTab } from './ChannelsTab';
import { AgentsTab } from './AgentsTab';
import { AdvancedTab } from './AdvancedTab';
import { RemoteAccessAction } from './RemoteAccessAction';
import { TunnelDialog } from './TunnelDialog';

const SETTINGS_TABS: TabbedDialogTab<SettingsTab>[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette, component: AppearanceTab },
  { id: 'preferences', label: 'Preferences', icon: Settings2, component: PreferencesTab },
  { id: 'statusBar', label: 'Status Bar', icon: LayoutList, component: StatusBarTab },
  { id: 'server', label: 'Server', icon: Server, component: ServerTab },
  { id: 'tools', label: 'Tools', icon: Wrench, component: ToolsTab },
  { id: 'channels', label: 'Channels', icon: Radio, component: ChannelsTab },
  { id: 'agents', label: 'Agents', icon: Bot, component: AgentsTab },
  { id: 'advanced', label: 'Advanced', icon: Cog, component: AdvancedTab },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Tabbed Settings dialog (consumer of TabbedDialog primitive). */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { activeTab: urlTab } = useSettingsDeepLink();
  const [tunnelDialogOpen, setTunnelDialogOpen] = useState(false);

  return (
    <>
      <TabbedDialog
        open={open}
        onOpenChange={onOpenChange}
        title="App Settings"
        description="Application settings"
        defaultTab="appearance"
        initialTab={urlTab}
        tabs={SETTINGS_TABS}
        sidebarExtras={<RemoteAccessAction onClick={() => setTunnelDialogOpen(true)} />}
        extensionSlot="settings.tabs"
        testId="settings-dialog"
      />
      <TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />
    </>
  );
}

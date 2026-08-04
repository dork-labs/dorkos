import { useState } from 'react';
import {
  Palette,
  Settings2,
  Server,
  Wrench,
  Cpu,
  Cog,
  ShieldCheck,
  Lock,
  Link2,
} from 'lucide-react';
import { TabbedDialog, type TabbedDialogTab } from '@/layers/shared/ui';
import { useSettingsDeepLink, type SettingsTab } from '@/layers/shared/model';
import { AppearanceResetAction, AppearanceTab } from './tabs/AppearanceTab';
import { PreferencesTab } from './tabs/PreferencesTab';
import { RuntimesTab } from './runtimes/RuntimesTab';
import { ServerTab } from './ServerTab';
import { ToolsResetAction, ToolsTab } from './ToolsTab';
import { SecurityTab } from './SecurityTab';
import { CloudAccountTab } from './CloudAccountTab';
import { PrivacyTab } from './PrivacyTab';
import { AdvancedTab } from './AdvancedTab';
import { RemoteAccessAction } from './RemoteAccessAction';
import { TunnelDialog } from './TunnelDialog';

const SETTINGS_TABS: TabbedDialogTab<SettingsTab>[] = [
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    component: AppearanceTab,
    actions: <AppearanceResetAction />,
  },
  { id: 'preferences', label: 'Preferences', icon: Settings2, component: PreferencesTab },
  {
    id: 'tools',
    label: 'Tools',
    icon: Wrench,
    component: ToolsTab,
    actions: <ToolsResetAction />,
    group: 'Agents & sessions',
  },
  {
    id: 'runtimes',
    label: 'Runtimes',
    icon: Cpu,
    component: RuntimesTab,
    group: 'Agents & sessions',
  },
  {
    id: 'security',
    label: 'Security',
    icon: ShieldCheck,
    component: SecurityTab,
    group: 'Access & privacy',
  },
  {
    id: 'privacy',
    label: 'Privacy & Data',
    icon: Lock,
    component: PrivacyTab,
    group: 'Access & privacy',
  },
  {
    id: 'account',
    label: 'DorkOS account',
    icon: Link2,
    component: CloudAccountTab,
    group: 'Access & privacy',
  },
  { id: 'server', label: 'Server', icon: Server, component: ServerTab, group: 'System' },
  { id: 'advanced', label: 'Advanced', icon: Cog, component: AdvancedTab, group: 'System' },
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
        title="Settings"
        description="Application settings"
        defaultTab="appearance"
        initialTab={urlTab}
        tabs={SETTINGS_TABS}
        sidebarExtras={<RemoteAccessAction onClick={() => setTunnelDialogOpen(true)} />}
        extensionSlot="settings.tabs"
        maximized
        testId="settings-dialog"
      />
      <TunnelDialog open={tunnelDialogOpen} onOpenChange={setTunnelDialogOpen} />
    </>
  );
}

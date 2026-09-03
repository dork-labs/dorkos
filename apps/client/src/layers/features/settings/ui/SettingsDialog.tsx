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
  UserRound,
  FlaskConical,
  Bell,
  MessagesSquare,
} from 'lucide-react';
import { TabbedDialog, type TabbedDialogTab } from '@/layers/shared/ui';
import { useAppStore, useSettingsDeepLink, type SettingsTab } from '@/layers/shared/model';
import { ProfileTab } from './ProfileTab';
import { AppearanceResetAction, AppearanceTab } from './tabs/AppearanceTab';
import { PreferencesTab } from './tabs/PreferencesTab';
import { NotificationsTab } from './tabs/NotificationsTab';
import { RoomsTab } from './tabs/RoomsTab';
import { RuntimesTab } from './runtimes/RuntimesTab';
import { ServerTab } from './ServerTab';
import { ToolsResetAction, ToolsTab } from './ToolsTab';
import { SecurityTab } from './SecurityTab';
import { CloudAccountTab } from './CloudAccountTab';
import { PrivacyTab } from './PrivacyTab';
import { AdvancedTab } from './AdvancedTab';
import { ExperimentsTab } from './ExperimentsTab';
import { RemoteAccessAction } from './RemoteAccessAction';

const SETTINGS_TABS: TabbedDialogTab<SettingsTab>[] = [
  // First, and promotion needs nothing else: ungrouped tabs render above the
  // first group header (`tabbed-dialog.tsx`), and `appearance`/`preferences`
  // are the only other ungrouped ones. The id is exactly `profile` because
  // that is what the profile drawer's Edit button deep-links to.
  { id: 'profile', label: 'Profile', icon: UserRound, component: ProfileTab },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    component: AppearanceTab,
    actions: <AppearanceResetAction />,
  },
  { id: 'preferences', label: 'Preferences', icon: Settings2, component: PreferencesTab },
  // Ungrouped, beside Preferences: "how loud may this be?" is a personal
  // preference, not a system or access question, and every setting in it was
  // reachable from Preferences before this tab existed.
  { id: 'notifications', label: 'Notifications', icon: Bell, component: NotificationsTab },
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
    // Beside Runtimes rather than under System: what it holds is how far agents
    // may carry a conversation with EACH OTHER, which is a question about
    // agents, not about this machine.
    id: 'rooms',
    label: 'Rooms',
    icon: MessagesSquare,
    component: RoomsTab,
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
  {
    // Between Server and Advanced on purpose: it is a place to try things, not a
    // danger zone, and burying it under Advanced is how the last flag stayed
    // invisible (DOR-1304). The tab renders whatever the server registers, so an
    // empty registry shows an empty-state line rather than a missing tab —
    // an experiments section that disappears would look like a regression.
    id: 'experiments',
    label: 'Experiments',
    icon: FlaskConical,
    component: ExperimentsTab,
    group: 'System',
  },
  { id: 'advanced', label: 'Advanced', icon: Cog, component: AdvancedTab, group: 'System' },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Tabbed Settings dialog (consumer of TabbedDialog primitive).
 *
 * The Remote Access dialog used to be a `useState` and a second `<TunnelDialog>`
 * right here, which is why Settings was the only place that could open it. It
 * is a registered dialog now (DOR-1743) and this action flips its store flag,
 * like every other door to it.
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { activeTab: urlTab } = useSettingsDeepLink();
  const setRemoteAccessOpen = useAppStore((s) => s.setRemoteAccessOpen);

  return (
    <TabbedDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description="Application settings"
      defaultTab="appearance"
      initialTab={urlTab}
      tabs={SETTINGS_TABS}
      sidebarExtras={<RemoteAccessAction onClick={() => setRemoteAccessOpen(true)} />}
      extensionSlot="settings.tabs"
      maximized
      testId="settings-dialog"
    />
  );
}

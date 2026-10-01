import {
  Palette,
  Settings2,
  Server,
  Wrench,
  Cpu,
  TriangleAlert,
  ShieldCheck,
  Lock,
  CircleUserRound,
  Globe,
  UserRound,
  FlaskConical,
  Bell,
  MessagesSquare,
  KeyRound,
  Cable,
} from 'lucide-react';
import { TabbedDialog, type TabbedDialogTab } from '@/layers/shared/ui';
import { useSettingsDeepLink, type SettingsTab } from '@/layers/shared/model';

import { ProfileTab } from './ProfileTab';
import { AppearanceResetAction, AppearanceTab } from './tabs/AppearanceTab';
import { PreferencesTab } from './tabs/PreferencesTab';
import { NotificationsTab } from './tabs/NotificationsTab';
import { RoomsTab } from './tabs/RoomsTab';
import { ConnectionsTab } from './tabs/ConnectionsTab';
import { PermissionsTab } from './tabs/PermissionsTab';
import { RuntimesTab } from './runtimes/RuntimesTab';
import { ServerTab } from './ServerTab';
import { ToolsTab } from './ToolsTab';
import { SecurityPanel } from '@/layers/features/auth';
import { DorkosAccountTab } from './DorkosAccountTab';
import { RemoteAccessTab } from './RemoteAccessTab';
import { PrivacyTab } from './PrivacyTab';
import { DangerZoneTab } from './DangerZoneTab';
import { ExperimentsTab } from './ExperimentsTab';

const SETTINGS_TABS: TabbedDialogTab<SettingsTab>[] = [
  // "You" names what used to be an unlabelled run of four tabs above the first
  // section header — four loose things, then three real sections (DOR-1758).
  // Every region is a labelled peer now.
  //
  // The id is exactly `profile` because that is what the profile drawer's Edit
  // button deep-links to.
  { id: 'profile', label: 'Profile', icon: UserRound, component: ProfileTab, group: 'You' },
  {
    // The DorkOS account's one home (DOR-2628), directly after Profile and
    // never anywhere else: who you are, then the account attached to you. The
    // header menu's "DorkOS account" row opens exactly this tab.
    id: 'account',
    label: 'DorkOS account',
    icon: CircleUserRound,
    component: DorkosAccountTab,
    group: 'You',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    component: AppearanceTab,
    actions: <AppearanceResetAction />,
    group: 'You',
  },
  {
    id: 'preferences',
    label: 'Preferences',
    icon: Settings2,
    component: PreferencesTab,
    group: 'You',
  },
  // Beside Preferences: "how loud may this be?" is a personal preference, not a
  // system or access question, and every setting in it was reachable from
  // Preferences before this tab existed.
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    component: NotificationsTab,
    group: 'You',
  },
  {
    id: 'tools',
    label: 'Tools',
    icon: Wrench,
    component: ToolsTab,
    group: 'Agents & sessions',
  },
  {
    // What agents may do, for everyone (spec `agent-permissions`). First in the
    // group because it is the answer to "why did my agent ask / refuse".
    id: 'permissions',
    label: 'Permissions',
    icon: KeyRound,
    component: PermissionsTab,
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
    // The plumbing behind the Connections page: how DorkOS reaches your apps
    // (the DorkOS account, your own Composio or Nango key) and how chat apps
    // behave when a message arrives. The page is for apps; this is for how
    // they are reached, which people set once and rarely revisit.
    id: 'connections',
    label: 'Connections',
    icon: Cable,
    component: ConnectionsTab,
    group: 'Agents & sessions',
  },
  {
    // The local half of what was the Access tab: whether this computer asks
    // for a login, and the API keys that stand in for one. Its own tab since
    // the DorkOS account moved to the You group (DOR-2628).
    id: 'security',
    label: 'Login & security',
    icon: ShieldCheck,
    component: SecurityPanel,
    group: 'This computer',
  },
  {
    id: 'privacy',
    label: 'Privacy & Data',
    icon: Lock,
    component: PrivacyTab,
    group: 'This computer',
  },
  {
    // A real tab, not the sidebar button it used to be: that button sat in the
    // list of tabs, looked like a tab, and opened a second modal on top of the
    // settings modal — with the phone's drill-in chevron, where the recovery
    // gesture is worst.
    id: 'remote-access',
    label: 'Remote access',
    icon: Globe,
    component: RemoteAccessTab,
    group: 'This computer',
  },
  { id: 'server', label: 'Server', icon: Server, component: ServerTab, group: 'System' },
  {
    // Between Server and the danger zone on purpose: it is a place to try
    // things, not a danger zone, and burying it under "Advanced" is how the last
    // flag stayed invisible (DOR-1304). The tab renders whatever the server
    // registers, so an empty registry shows an empty-state line rather than a
    // missing tab — an experiments section that disappears would look like a
    // regression.
    id: 'experiments',
    label: 'Experiments',
    icon: FlaskConical,
    component: ExperimentsTab,
    group: 'System',
  },
  {
    // Named after what it holds, which is now only the three actions you cannot
    // take back by hand. "Advanced" was a junk drawer — a polling switch, the
    // message box, logging and these buttons in one flat stack — and every other
    // section moved somewhere its name predicts (DOR-1758).
    id: 'danger',
    label: 'Danger zone',
    icon: TriangleAlert,
    component: DangerZoneTab,
    group: 'System',
  },
];

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Tabbed Settings dialog (consumer of TabbedDialog primitive).
 *
 * Remote Access is one of its tabs (`remote-access`, DOR-1758) rather than a
 * dialog this component opens on top of itself — a control that looks like a
 * tab must swap the panel, not stack a second modal. `TunnelDialog` is a
 * separate, independently-registered dialog now (DOR-1743): the Control
 * Center row and the top-bar beacon are its other doors, and neither of them
 * needs Settings open to reach it.
 */
export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { activeTab: urlTab } = useSettingsDeepLink();

  return (
    <TabbedDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description="Application settings"
      defaultTab="appearance"
      initialTab={urlTab}
      tabs={SETTINGS_TABS}
      extensionSlot="settings.tabs"
      maximized
      testId="settings-dialog"
    />
  );
}

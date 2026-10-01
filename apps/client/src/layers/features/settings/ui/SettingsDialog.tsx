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
import { STORAGE_KEYS } from '@/layers/shared/lib';

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

/** The sidebar group that starts folded. */
const ADVANCED_GROUP = 'Advanced';

/**
 * Whether Advanced is open, remembered per viewer in this browser. Folded is
 * the default; only the viewer's own press of the toggle is remembered.
 */
const ADVANCED_FOLD = { group: ADVANCED_GROUP, storageKey: STORAGE_KEYS.SETTINGS_ADVANCED_OPEN };

/**
 * The Settings tabs, in sidebar order: You, Agents, This computer, then
 * Advanced folded at the bottom (DOR-2629).
 */
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
    id: 'runtimes',
    label: 'Runtimes',
    icon: Cpu,
    component: RuntimesTab,
    group: 'Agents',
  },
  {
    // What agents may do, for everyone (spec `agent-permissions`) — the answer
    // to "why did my agent ask / refuse".
    id: 'permissions',
    label: 'Permissions',
    icon: KeyRound,
    component: PermissionsTab,
    group: 'Agents',
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
    group: 'Agents',
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
  {
    id: 'privacy',
    label: 'Privacy & Data',
    icon: Lock,
    component: PrivacyTab,
    group: 'This computer',
  },
  // Advanced, folded until you open it (DOR-2629): the five tabs most people
  // set once or never. Folding is not hiding — a `?settings=` link to any of
  // them still lands, and opens the fold on its way in. The ids are the ones
  // every existing link was minted with; only the grouping moved.
  { id: 'server', label: 'Server', icon: Server, component: ServerTab, group: ADVANCED_GROUP },
  {
    id: 'tools',
    label: 'Tools',
    icon: Wrench,
    component: ToolsTab,
    group: ADVANCED_GROUP,
  },
  {
    // The DEFAULTS every room follows, which is all that lives here: each room
    // keeps its own limits in its own panel (Members → Automatic replies), and
    // a room that sets none follows these. Named "Room limits" because that is
    // the whole of what the tab holds; the id stays `rooms` for old links.
    id: 'rooms',
    label: 'Room limits',
    icon: MessagesSquare,
    component: RoomsTab,
    group: ADVANCED_GROUP,
  },
  {
    // A place to try things, not a danger zone. It sits behind the fold with
    // the other rarely-touched tabs, but every flag still has a direct
    // `?settings=experiments` link, and the tab renders whatever the server
    // registers, so an empty registry shows an empty-state line rather than a
    // missing tab (DOR-1304).
    id: 'experiments',
    label: 'Experiments',
    icon: FlaskConical,
    component: ExperimentsTab,
    group: ADVANCED_GROUP,
  },
  {
    // Named after what it holds, which is now only the three actions you cannot
    // take back by hand (DOR-1758).
    id: 'danger',
    label: 'Danger zone',
    icon: TriangleAlert,
    component: DangerZoneTab,
    group: ADVANCED_GROUP,
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
      foldedGroup={ADVANCED_FOLD}
      testId="settings-dialog"
    />
  );
}

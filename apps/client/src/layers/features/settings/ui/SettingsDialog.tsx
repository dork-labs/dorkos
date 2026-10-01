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
import {
  SETTINGS_ADVANCED_GROUP,
  SETTINGS_TAB_DIRECTORY,
  STORAGE_KEYS,
  type BuiltInSettingsTab,
} from '@/layers/shared/lib';

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

/**
 * Whether Advanced is open, remembered per viewer in this browser. Folded is
 * the default; only the viewer's own press of the toggle is remembered.
 */
const ADVANCED_FOLD = {
  group: SETTINGS_ADVANCED_GROUP,
  storageKey: STORAGE_KEYS.SETTINGS_ADVANCED_OPEN,
};

/** What a tab draws. Its id, label, group and order live in `SETTINGS_TAB_DIRECTORY`. */
type SettingsTabParts = Pick<TabbedDialogTab<SettingsTab>, 'icon' | 'component' | 'actions'>;

/**
 * The panel behind each built-in tab. A total record, so a tab added to the
 * directory is a type error here until it has something to show.
 */
const SETTINGS_TAB_PARTS: Record<BuiltInSettingsTab, SettingsTabParts> = {
  profile: { icon: UserRound, component: ProfileTab },
  account: { icon: CircleUserRound, component: DorkosAccountTab },
  appearance: { icon: Palette, component: AppearanceTab, actions: <AppearanceResetAction /> },
  preferences: { icon: Settings2, component: PreferencesTab },
  notifications: { icon: Bell, component: NotificationsTab },
  runtimes: { icon: Cpu, component: RuntimesTab },
  permissions: { icon: KeyRound, component: PermissionsTab },
  // The plumbing behind the Connections page: how DorkOS reaches your apps
  // (the DorkOS account, your own Composio or Nango key) and how chat apps
  // behave when a message arrives.
  connections: { icon: Cable, component: ConnectionsTab },
  // Whether this computer asks for a login, and the API keys that stand in
  // for one.
  security: { icon: ShieldCheck, component: SecurityPanel },
  // A real tab, not the sidebar button it used to be: that button looked like
  // a tab and opened a second modal on top of this one.
  'remote-access': { icon: Globe, component: RemoteAccessTab },
  privacy: { icon: Lock, component: PrivacyTab },
  server: { icon: Server, component: ServerTab },
  tools: { icon: Wrench, component: ToolsTab },
  rooms: { icon: MessagesSquare, component: RoomsTab },
  // Renders whatever the server registers, so an empty registry shows an
  // empty-state line rather than a missing tab.
  experiments: { icon: FlaskConical, component: ExperimentsTab },
  danger: { icon: TriangleAlert, component: DangerZoneTab },
};

/**
 * The Settings tabs, in sidebar order: You, Agents, This computer, then
 * Advanced folded at the bottom (DOR-2629).
 */
const SETTINGS_TABS: TabbedDialogTab<SettingsTab>[] = SETTINGS_TAB_DIRECTORY.map((entry) => ({
  id: entry.id,
  label: entry.label,
  group: entry.group,
  ...SETTINGS_TAB_PARTS[entry.id],
}));

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

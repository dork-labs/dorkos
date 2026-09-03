import type { DialogContribution } from '@/layers/shared/model';
import { ShapeSwitcherDialog } from '@/layers/features/shapes';
import { ProfileSheetContainer } from '@/layers/features/profile';
import { TunnelDialog } from '@/layers/features/settings';
import { SettingsDialogWrapper } from './wrappers/SettingsDialogWrapper';
import { DirectoryPickerWrapper } from './wrappers/DirectoryPickerWrapper';
import { TasksDialogWrapper } from './wrappers/TaskDialogWrapper';
import { ServerRestartOverlayWrapper } from './wrappers/ServerRestartOverlayWrapper';

/** Built-in dialog contributions for the root dialog host. */
export const DIALOG_CONTRIBUTIONS: DialogContribution[] = [
  {
    id: 'settings',
    component: SettingsDialogWrapper,
    openStateKey: 'settingsOpen',
    priority: 1,
    urlParam: 'settings',
  },
  {
    // Registered beside Settings so one profile panel mounts once for the whole
    // app and `?profile=<member id>` opens it from any route (spec §W3.2). The
    // container renders nothing until it is open, so a route that never opens a
    // profile pays for no roster read.
    id: 'profile',
    component: ProfileSheetContainer,
    openStateKey: 'profileOpen',
    priority: 4,
    urlParam: 'profile',
  },
  {
    id: 'directory-picker',
    component: DirectoryPickerWrapper,
    openStateKey: 'pickerOpen',
    priority: 2,
  },
  {
    id: 'tasks',
    component: TasksDialogWrapper,
    openStateKey: 'tasksOpen',
    priority: 3,
    urlParam: 'tasks',
  },
  {
    id: 'server-restart-overlay',
    component: ServerRestartOverlayWrapper,
    openStateKey: 'restartOverlayOpen',
    priority: 7,
  },
  {
    // Registered here rather than nested inside `SettingsDialog`, because
    // Settings is no longer the only door to it (DOR-1743): the Control Center
    // row opens it for one-time setup and again from a failure's "Fix…", and
    // the beacon's "Manage…" opens it from the top bar. It renders its own
    // dialog chrome, so it registers directly.
    id: 'remote-access',
    component: TunnelDialog,
    openStateKey: 'remoteAccessOpen',
    priority: 8,
  },
  {
    // The switcher already renders its own Dialog chrome (open/onOpenChange), so
    // it registers directly — no passthrough wrapper needed (DOR-355).
    id: 'shape-switcher',
    component: ShapeSwitcherDialog,
    openStateKey: 'shapeSwitcherOpen',
    priority: 6,
  },
];

import type { DialogContribution } from '@/layers/shared/model';
import { ShapeSwitcherDialog } from '@/layers/features/shapes';
import { SettingsDialogWrapper } from './wrappers/SettingsDialogWrapper';
import { DirectoryPickerWrapper } from './wrappers/DirectoryPickerWrapper';
import { TasksDialogWrapper } from './wrappers/TaskDialogWrapper';
import { RelayDialogWrapper } from './wrappers/RelayDialogWrapper';
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
    id: 'relay',
    component: RelayDialogWrapper,
    openStateKey: 'relayOpen',
    priority: 4,
    urlParam: 'relay',
  },
  {
    id: 'server-restart-overlay',
    component: ServerRestartOverlayWrapper,
    openStateKey: 'restartOverlayOpen',
    priority: 7,
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

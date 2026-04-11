import type { DialogContribution } from '@/layers/shared/model';
import { SettingsDialogWrapper } from './wrappers/SettingsDialogWrapper';
import { DirectoryPickerWrapper } from './wrappers/DirectoryPickerWrapper';
import { TasksDialogWrapper } from './wrappers/TaskDialogWrapper';
import { RelayDialogWrapper } from './wrappers/RelayDialogWrapper';
import { AgentDialogWrapper } from './wrappers/AgentDialogWrapper';
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
    id: 'agent',
    component: AgentDialogWrapper,
    openStateKey: 'agentDialogOpen',
    priority: 6,
    urlParam: 'agent',
  },
  {
    id: 'server-restart-overlay',
    component: ServerRestartOverlayWrapper,
    openStateKey: 'restartOverlayOpen',
    priority: 7,
  },
];

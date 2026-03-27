import type { DialogContribution } from '@/layers/shared/model';
import { SettingsDialogWrapper } from './wrappers/SettingsDialogWrapper';
import { DirectoryPickerWrapper } from './wrappers/DirectoryPickerWrapper';
import { PulseDialogWrapper } from './wrappers/PulseDialogWrapper';
import { RelayDialogWrapper } from './wrappers/RelayDialogWrapper';
import { MeshDialogWrapper } from './wrappers/MeshDialogWrapper';
import { AgentDialogWrapper } from './wrappers/AgentDialogWrapper';

/** Built-in dialog contributions for the root dialog host. */
export const DIALOG_CONTRIBUTIONS: DialogContribution[] = [
  {
    id: 'settings',
    component: SettingsDialogWrapper,
    openStateKey: 'settingsOpen',
    priority: 1,
  },
  {
    id: 'directory-picker',
    component: DirectoryPickerWrapper,
    openStateKey: 'pickerOpen',
    priority: 2,
  },
  {
    id: 'pulse',
    component: PulseDialogWrapper,
    openStateKey: 'pulseOpen',
    priority: 3,
  },
  {
    id: 'relay',
    component: RelayDialogWrapper,
    openStateKey: 'relayOpen',
    priority: 4,
  },
  {
    id: 'mesh',
    component: MeshDialogWrapper,
    openStateKey: 'meshOpen',
    priority: 5,
  },
  {
    id: 'agent',
    component: AgentDialogWrapper,
    openStateKey: 'agentDialogOpen',
    priority: 6,
  },
];

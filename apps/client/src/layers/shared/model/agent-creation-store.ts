import { create } from 'zustand';

export type CreationMode = 'new' | 'template' | 'import';

/** @deprecated Use CreationMode instead */
export type CreationTab = CreationMode;

interface AgentCreationState {
  isOpen: boolean;
  initialMode: CreationMode;
  open: (mode?: CreationMode) => void;
  close: () => void;
}

/** Global dialog state for the Create Agent dialog. */
export const useAgentCreationStore = create<AgentCreationState>((set) => ({
  isOpen: false,
  initialMode: 'new',
  open: (mode?: CreationMode) => set({ isOpen: true, initialMode: mode ?? 'new' }),
  close: () => set({ isOpen: false, initialMode: 'new' }),
}));

import { createContext, useContext } from 'react';
import { create } from 'zustand';
import type { TabActivationSource } from '@/layers/shared/ui';

/** A panel host owns the only tab row; standalone feature previews retain their own header. */
export const PanelResourceChrome = createContext(false);
/** Hidden retained resources must never focus their interactive instance. */
export const PanelResourceVisible = createContext(true);

/** Whether the enclosing panel supplies resource tabs. */
export function useUnifiedPanelChrome(): boolean {
  return useContext(PanelResourceChrome);
}

/** Concrete terminal views, shared with the panel header without importing a feature model. */
export interface TerminalResourceChrome {
  scope: string;
  tabs: { id: string; title: string; closed?: boolean }[];
  activeId: string | null;
  activate: (id: string, source: TabActivationSource) => void;
  create: () => void;
  /** Close only the local view, preserving pending and live shell identity. */
  hide?: (id: string) => void;
  stop: (id: string, source: TabActivationSource) => void;
}

interface TerminalChromeState {
  chrome: TerminalResourceChrome | null;
  publish: (chrome: TerminalResourceChrome | null) => void;
  /** One explicit new-shell request waiting for its scoped owner to mount. */
  createRequest: { scope: string; id: number } | null;
  requestCreate: (scope: string) => void;
  consumeCreate: (scope: string, id: number) => void;
}

let createRequestSequence = 0;

/** Ephemeral projection of the mounted terminal owner; no PTY identity is persisted here. */
export const useTerminalResourceChrome = create<TerminalChromeState>((set) => ({
  chrome: null,
  publish: (chrome) => set({ chrome }),
  createRequest: null,
  requestCreate: (scope) => set({ createRequest: { scope, id: ++createRequestSequence } }),
  consumeCreate: (scope, id) =>
    set((state) =>
      state.createRequest?.scope === scope && state.createRequest.id === id
        ? { createRequest: null }
        : state
    ),
}));

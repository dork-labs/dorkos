import { useState } from 'react';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';

interface DialogState {
  removeTarget: { instanceId: string; name: string } | null;
  eventsTarget: { instanceId: string } | null;
  bindingTarget: { mode: 'create' | 'edit'; adapterId: string; binding?: AdapterBinding } | null;
}

/** Manages dialog open/close state for AdapterCard actions hosted at the IntegrationsTab level. */
export function useAdapterCardDialogs() {
  const [state, setState] = useState<DialogState>({
    removeTarget: null,
    eventsTarget: null,
    bindingTarget: null,
  });

  return {
    ...state,
    openRemove: (instanceId: string, name: string) =>
      setState((s) => ({ ...s, removeTarget: { instanceId, name } })),
    closeRemove: () => setState((s) => ({ ...s, removeTarget: null })),
    openEvents: (instanceId: string) => setState((s) => ({ ...s, eventsTarget: { instanceId } })),
    closeEvents: () => setState((s) => ({ ...s, eventsTarget: null })),
    openBindingCreate: (adapterId: string) =>
      setState((s) => ({ ...s, bindingTarget: { mode: 'create', adapterId } })),
    openBindingEdit: (adapterId: string, binding: AdapterBinding) =>
      setState((s) => ({ ...s, bindingTarget: { mode: 'edit', adapterId, binding } })),
    closeBinding: () => setState((s) => ({ ...s, bindingTarget: null })),
  };
}

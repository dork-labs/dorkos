import type { UiPanelId } from '@dorkos/shared/types';
import type { EffectOwner } from './celebrations/celebration-effects';
import type {
  DispatcherContext,
  DispatcherStore,
  UiCommandOrigin,
  EffectInvoke,
} from './ui-command-types';
/** Prepare a call and check its lifetime immediately before host entry. */
export function effectInvoker(owner?: EffectOwner): EffectInvoke {
  const before = owner?.beforeEffect;
  return (receiver, method, args) => {
    if (before) Reflect.apply(before, owner, []);
    return Reflect.apply(method, receiver, args);
  };
}
/** Select a tab while preserving agent-origin preference semantics. */
export function setTab(
  store: DispatcherStore,
  origin: UiCommandOrigin,
  tabId: string,
  invoke: EffectInvoke
): void {
  const method =
    origin === 'user' ? store.setActiveRightPanelTab : store.setActiveRightPanelTabView;
  invoke(store, method, [tabId]);
}
/** Reveal an agent tab without persisting a user preference. */
export function revealTab(
  store: DispatcherStore,
  origin: UiCommandOrigin,
  tabId: string,
  invoke: EffectInvoke
): void {
  const canvas = store.setCanvasOpen;
  invoke(store, canvas, [true]);
  const panel = store.setRightPanelOpen;
  invoke(store, panel, [true]);
  setTab(store, origin, tabId, invoke);
}
/** Update the panel appropriate for the current origin. */
export function setPanelOpen(input: {
  ctx: DispatcherContext;
  store: DispatcherStore;
  panel: UiPanelId;
  open: boolean;
  invoke: EffectInvoke;
}): void {
  const { ctx, store, panel, open, invoke } = input;
  const setterMap: Record<UiPanelId, (open: boolean) => void> = {
    settings: store.setSettingsOpen,
    tasks: store.setTasksOpen,
    relay: store.setRelayOpen,
    picker: store.setPickerOpen,
  };
  const method = setterMap[panel];
  if (method) invoke(store, method, [open]);
  // Closing clears every signal that can hold the panel open, not just the store
  // flag — a deep-linked Settings or Tasks dialog stays on screen otherwise
  // (DOR-839). No-op for panels with no URL signal, and when none is injected.
  if (!open) {
    const signal = ctx.panelUrlSignal;
    const close = signal?.close;
    if (signal && close) invoke(signal, close, [panel]);
  }
}
/** Toggle the current panel through the owned effect boundary. */
export function togglePanel(
  ctx: DispatcherContext,
  store: DispatcherStore,
  panel: UiPanelId,
  invoke: EffectInvoke
): void {
  const getterMap: Record<UiPanelId, boolean> = {
    settings: store.settingsOpen,
    tasks: store.tasksOpen,
    relay: store.relayOpen,
    picker: store.pickerOpen,
  };
  // Same open rule `DialogHost` renders by: either signal counts. Reading the
  // store alone reports a deep-linked dialog as closed, so a toggle "opens" the
  // thing already on screen instead of closing it.
  let isOpen = getterMap[panel];
  if (!isOpen) {
    const signal = ctx.panelUrlSignal;
    const read = signal?.isOpen;
    isOpen = signal && read ? invoke(signal, read, [panel]) : false;
  }
  setPanelOpen({ ctx, store, panel, open: !isOpen, invoke });
}

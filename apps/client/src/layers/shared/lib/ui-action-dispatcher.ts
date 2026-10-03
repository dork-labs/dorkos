import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import { canvasViewForContent } from '@dorkos/shared/canvas-view';
import type { EffectOwner } from './celebrations/celebration-effects';
import type { DispatcherContext, DispatcherStore, UiCommandOrigin } from './ui-command-types';
import { effectInvoker, revealTab } from './ui-command-effects';
import { executeCanvasCommand } from './ui-command-canvas';
import { executeChromeCommand } from './ui-command-chrome';
export type { DispatcherStore, DispatcherContext, UiCommandOrigin } from './ui-command-types';
export type { EffectOwner } from './celebrations/celebration-effects';
const CANVAS_TAB_ID = 'canvas';
const BROWSER_TAB_ID = 'browser';
const LOCAL_UI_ONLY_COMMANDS: Record<UiCommand['action'], boolean> = {
  // Local, visible, reversible chrome.
  open_panel: true,
  close_panel: true,
  toggle_panel: true,
  open_command_palette: true,
  show_toast: true,
  set_theme: true,
  celebrate: true,
  // Canvas, browser, file and diff — all write into a session's own document
  // store, keyed by whichever session the reader has open.
  open_canvas: false,
  update_canvas: false,
  close_canvas: false,
  open_file: false,
  open_diff: false,
  browser_navigate: false,
  // The terminal runs commands; PiP follows a session's newest fence.
  open_terminal: false,
  open_pip: false,
  close_pip: false,
  // These move the reader somewhere, or change what their app IS.
  switch_agent: false,
  apply_layout: false,
  scroll_to_message: false,
  // Embedded-shell chrome, off the approved list rather than judged harmless.
  open_sidebar: false,
  close_sidebar: false,
};
/** Identify commands that only change the local interface. */
export function isLocalUiOnlyCommand(command: UiCommand): boolean {
  return LOCAL_UI_ONLY_COMMANDS[command.action];
}
/** Capture the live store and action once; each owned host entry rechecks admission. */
/** Dispatch one strict action against one current store and effect owner. */
export function executeUiCommand(
  ctx: DispatcherContext,
  command: UiCommand,
  origin: UiCommandOrigin,
  owner?: EffectOwner
): void {
  const invoke = effectInvoker(owner);
  const readStore = ctx.getStore;
  const store = invoke(ctx, readStore, []);
  const action = command.action;
  const input = { ctx, store, command, origin, owner, invoke };
  if (executeCanvasCommand(action, input) || executeChromeCommand(action, input)) return;
  const method = console.warn;
  invoke(console, method, ['[UiDispatcher] Unknown action:', action]);
}
/** Reveal the canvas through the current effect owner. */
export function revealCanvas(
  store: DispatcherStore,
  origin: UiCommandOrigin,
  owner?: EffectOwner
): void {
  revealTab(store, origin, CANVAS_TAB_ID, effectInvoker(owner));
}

/** Reveal the browser through the current effect owner. */
export function revealBrowser(
  store: DispatcherStore,
  origin: UiCommandOrigin,
  owner?: EffectOwner
): void {
  revealTab(store, origin, BROWSER_TAB_ID, effectInvoker(owner));
}

/** Reveal the panel appropriate for the supplied canvas content. */
export function revealForContent(
  store: DispatcherStore,
  origin: UiCommandOrigin,
  content: UiCanvasContent,
  owner?: EffectOwner
): void {
  const view = canvasViewForContent(content);
  revealTab(
    store,
    origin,
    view === 'browser' ? BROWSER_TAB_ID : CANVAS_TAB_ID,
    effectInvoker(owner)
  );
}

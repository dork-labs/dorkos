import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import { toast } from 'sonner';
import type { CommandInvocation } from './ui-command-types';
import { canvasContentForFile } from '@dorkos/shared/viewer-registry';
import { canvasViewForContent } from '@dorkos/shared/canvas-view';
import type { PipContent } from '@/layers/shared/model';
import { configKeys } from '@/layers/shared/model/server-config/query-keys';
import { queryClient } from './query-client';
import { revealTab, setTab } from './ui-command-effects';
const CANVAS_TAB_ID = 'canvas';
const BROWSER_TAB_ID = 'browser';
const TERMINAL_TAB_ID = 'terminal';
/** Strict action selection: never coerce a caller value into a property key. */
export function executeCanvasCommand(
  action: UiCommand['action'],
  input: CommandInvocation
): boolean {
  switch (action) {
    case 'open_canvas':
      runOpenCanvas(input);
      return true;
    case 'update_canvas':
      runUpdateCanvas(input);
      return true;
    case 'open_file':
      runOpenFile(input);
      return true;
    case 'open_diff':
      runOpenDiff(input);
      return true;
    case 'open_terminal':
      runOpenTerminal(input);
      return true;
    case 'browser_navigate':
      runBrowserNavigate(input);
      return true;
    case 'close_canvas':
      runCloseCanvas(input);
      return true;
    case 'open_pip':
      runOpenPip(input);
      return true;
    case 'close_pip':
      runClosePip(input);
      return true;
    default:
      return false;
  }
}
function runOpenCanvas(input: CommandInvocation): void {
  const { ctx, store, origin, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'open_canvas' }>;

  const content = command.content;
  const width = command.preferredWidth;
  const applied = content != null ? ctx.serverAppliedCanvas : false;
  // Prepare the reveal view before any write; unknown data/widget payloads
  // remain unchanged and are not JSON-coerced into a different public value.
  const view = content == null ? 'canvas' : canvasViewForContent(content);
  if (content != null && !applied) {
    const method = store.openCanvasDocument;
    invoke(store, method, [content]);
  }
  if (width != null) {
    const method = store.setCanvasPreferredWidth;
    invoke(store, method, [width]);
  }
  revealTab(store, origin, view === 'browser' ? BROWSER_TAB_ID : CANVAS_TAB_ID, invoke);
  return;
}

function runUpdateCanvas(input: CommandInvocation): void {
  const { ctx, store, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'update_canvas' }>;

  const applied = ctx.serverAppliedCanvas;
  if (!applied) {
    const content = command.content;
    const method = store.updateActiveDocument;
    invoke(store, method, [content]);
  }
  return;
}

function runOpenFile(input: CommandInvocation): void {
  const { ctx, store, origin, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'open_file' }>;

  const path = command.sourcePath;
  const overrides = ctx.workbenchViewerOverrides ?? workbenchViewerOverrides();
  const content = canvasContentForFile(path, overrides);
  const view = canvasViewForContent(content);
  const applied = ctx.serverAppliedCanvas;
  if (!applied) {
    const method = store.openCanvasDocument;
    invoke(store, method, [content]);
  }
  revealTab(store, origin, view === 'browser' ? BROWSER_TAB_ID : CANVAS_TAB_ID, invoke);
  return;
}

function runOpenDiff(input: CommandInvocation): void {
  const { ctx, store, origin, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'open_diff' }>;

  const applied = ctx.serverAppliedCanvas;
  if (!applied) {
    const content: UiCanvasContent = { type: 'diff', sourcePath: command.sourcePath };
    const method = store.openCanvasDocument;
    invoke(store, method, [content]);
  }
  revealTab(store, origin, CANVAS_TAB_ID, invoke);
  return;
}

function runOpenTerminal(input: CommandInvocation): void {
  const { ctx, store, origin, invoke } = input;

  const supported = ctx.supportsTerminal;
  if (supported === false) {
    const method = toast.info;
    const args = [
      'Terminal is not available here',
      {
        description: 'Open this session in the DorkOS web app to use the terminal.',
      },
    ] as const;
    invoke(toast, method, [...args]);
    return;
  }
  const method = store.setRightPanelOpen;
  invoke(store, method, [true]);
  setTab(store, origin, TERMINAL_TAB_ID, invoke);
  return;
}

function runBrowserNavigate(input: CommandInvocation): void {
  const { ctx, store, origin, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'browser_navigate' }>;

  const applied = ctx.serverAppliedCanvas;
  if (!applied) {
    const content: UiCanvasContent = { type: 'browser', url: command.url };
    const method = store.openCanvasDocument;
    invoke(store, method, [content]);
  }
  revealTab(store, origin, BROWSER_TAB_ID, invoke);
  return;
}

function runCloseCanvas(input: CommandInvocation): void {
  const { ctx, store, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'close_canvas' }>;

  const id = command.documentId;
  if (id !== undefined) {
    const applied = ctx.serverAppliedCanvas;
    if (!applied) {
      const method = store.closeCanvasDocument;
      invoke(store, method, [id]);
    }
    return;
  }
  const closeCanvas = store.setCanvasOpen;
  invoke(store, closeCanvas, [false]);
  const closePanel = store.setRightPanelOpen;
  invoke(store, closePanel, [false]);
  return;
}

function runOpenPip(input: CommandInvocation): void {
  const { ctx, store, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'open_pip' }>;

  const sessionId = ctx.sessionId;
  if (sessionId === undefined) {
    const method = toast.info;
    const args = [
      'Picture-in-picture needs an active session',
      {
        description: 'Open a chat session, then pop its widget out.',
      },
    ] as const;
    invoke(toast, method, [...args]);
    return;
  }
  const title = command.title ?? 'Widget';
  const content: PipContent = { kind: 'widget', sessionId, title };
  const method = store.openPip;
  invoke(store, method, [content]);
  return;
}

function runClosePip(input: CommandInvocation): void {
  const { store, invoke } = input;

  const method = store.closePip;
  invoke(store, method, []);
  return;
}
function workbenchViewerOverrides(): Record<string, string> | undefined {
  const config = queryClient.getQueryData<{
    workbench?: { defaultViewers?: Record<string, string> };
  }>(configKeys.current());
  return config?.workbench?.defaultViewers;
}

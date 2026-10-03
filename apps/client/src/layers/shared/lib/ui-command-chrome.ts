import type { UiCommand } from '@dorkos/shared/types';
import { toast } from 'sonner';
import type { CommandInvocation } from './ui-command-types';
import { fireCelebration } from './celebrations/celebration-effects';
import { setPanelOpen, togglePanel } from './ui-command-effects';
/** Strict action selection: never coerce a caller value into a property key. */
export function executeChromeCommand(
  action: UiCommand['action'],
  input: CommandInvocation
): boolean {
  switch (action) {
    case 'open_panel':
      runOpenPanel(input);
      return true;
    case 'close_panel':
      runClosePanel(input);
      return true;
    case 'toggle_panel':
      runTogglePanel(input);
      return true;
    case 'open_sidebar':
      runOpenSidebar(input);
      return true;
    case 'close_sidebar':
      runCloseSidebar(input);
      return true;
    case 'show_toast':
      runShowToast(input);
      return true;
    case 'set_theme':
      runSetTheme(input);
      return true;
    case 'scroll_to_message':
      runScrollToMessage(input);
      return true;
    case 'switch_agent':
      runSwitchAgent(input);
      return true;
    case 'apply_layout':
      runApplyLayout(input);
      return true;
    case 'open_command_palette':
      runOpenCommandPalette(input);
      return true;
    case 'celebrate':
      runCelebrate(input);
      return true;
    default:
      return false;
  }
}
function runOpenPanel(input: CommandInvocation): void {
  const { ctx, store, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'open_panel' }>;

  const panel = command.panel;
  setPanelOpen({ ctx, store, panel, open: true, invoke });
  return;
}

function runClosePanel(input: CommandInvocation): void {
  const { ctx, store, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'close_panel' }>;

  const panel = command.panel;
  setPanelOpen({ ctx, store, panel, open: false, invoke });
  return;
}

function runTogglePanel(input: CommandInvocation): void {
  const { ctx, store, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'toggle_panel' }>;

  const panel = command.panel;
  togglePanel(ctx, store, panel, invoke);
  return;
}

function runOpenSidebar(input: CommandInvocation): void {
  const { store, invoke } = input;

  const method = store.setSidebarOpen;
  invoke(store, method, [true]);
  return;
}

function runCloseSidebar(input: CommandInvocation): void {
  const { store, invoke } = input;

  const method = store.setSidebarOpen;
  invoke(store, method, [false]);
  return;
}

function runShowToast(input: CommandInvocation): void {
  const { invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'show_toast' }>;

  const level = command.level;
  const message = command.message;
  const description = command.description;
  const method = toast[level];
  invoke(toast, method, [message, { description }]);
  return;
}

function runSetTheme(input: CommandInvocation): void {
  const { ctx, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'set_theme' }>;

  const theme = command.theme;
  const method = ctx.setTheme;
  invoke(ctx, method, [theme]);
  return;
}

function runScrollToMessage(input: CommandInvocation): void {
  const { ctx, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'scroll_to_message' }>;

  const id = command.messageId;
  const method = ctx.scrollToMessage;
  if (method) invoke(ctx, method, [id]);
  return;
}

function runSwitchAgent(input: CommandInvocation): void {
  const { ctx, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'switch_agent' }>;

  const cwd = command.cwd;
  const method = ctx.switchAgent;
  if (method) invoke(ctx, method, [cwd]);
  return;
}

function runApplyLayout(input: CommandInvocation): void {
  const { ctx, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'apply_layout' }>;

  const shape = command.shape;
  const method = ctx.applyShape;
  if (method) invoke(ctx, method, [shape]);
  return;
}

function runOpenCommandPalette(input: CommandInvocation): void {
  const { store, invoke } = input;

  const method = store.setGlobalPaletteOpen;
  invoke(store, method, [true]);
  return;
}

function runCelebrate(input: CommandInvocation): void {
  const { ctx, owner, invoke } = input;
  const command = input.command as Extract<UiCommand, { action: 'celebrate' }>;

  const kind = command.kind;
  const emoji = command.emoji;
  const suppliedOrigin = ctx.celebrationOrigin;
  const point =
    suppliedOrigin === undefined
      ? undefined
      : {
          x: suppliedOrigin.x,
          y: suppliedOrigin.y,
        };
  const options = { kind, emoji, origin: point };
  const pending = invoke(undefined, fireCelebration, [options, owner]);
  if (owner) {
    // A void command initiates work, never certifies delayed completion.
    // Rejection is observed; cleanup was installed before the lazy import.
    void pending.catch(() => console.warn('[extensions] Celebration did not complete.'));
  }
  return;
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent, UiState } from '@dorkos/shared/types';
import {
  createControlUiHandler,
  createGetUiStateHandler,
  type UiToolSession,
} from '../../runtimes/claude-code/mcp-tools/ui-tools.js';

function createMockSession(uiState?: UiState): UiToolSession {
  return {
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
    uiState,
  };
}

describe('control_ui handler', () => {
  let session: UiToolSession;

  beforeEach(() => {
    session = createMockSession();
  });

  it('returns success with action name for valid command', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'open_panel', panel: 'tasks' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('open_panel');
  });

  it('emits ui_command event to session eventQueue', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'open_panel', panel: 'tasks' });

    expect(session.eventQueue).toHaveLength(1);
    const event = session.eventQueue[0];
    expect(event.type).toBe('ui_command');
  });

  it('calls eventQueueNotify after emitting', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'close_sidebar' });

    expect(session.eventQueueNotify).toHaveBeenCalledTimes(1);
  });

  it('returns success for show_toast', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({
      action: 'show_toast',
      message: 'Hello!',
      level: 'info',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('show_toast');
  });

  it('returns success for open_canvas with markdown content', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hello' },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('open_canvas');
  });

  it('returns success for set_theme', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'set_theme', theme: 'dark' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('set_theme');
  });

  it('returns error for invalid action', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'nonexistent_action' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('Invalid UI command');
    expect(parsed.details).toBeDefined();
  });

  it('does not emit event when validation fails', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'nonexistent_action' });

    expect(session.eventQueue).toHaveLength(0);
    expect(session.eventQueueNotify).not.toHaveBeenCalled();
  });

  it('returns error when open_panel has invalid panel', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'open_panel', panel: 'nonexistent' });

    expect(result.isError).toBe(true);
  });
});

describe('get_ui_state handler', () => {
  it('returns default state when no session state exists', async () => {
    const session = createMockSession();
    const handler = createGetUiStateHandler(session);
    const result = await handler();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      canvas: { open: false, contentType: null },
      panels: { settings: false, tasks: false, relay: false },
      sidebar: { open: true, activeTab: 'overview' },
      agent: { id: null, cwd: null },
    });
  });

  it('returns session state when provided', async () => {
    const sessionState: UiState = {
      canvas: { open: true, contentType: 'markdown' },
      panels: { settings: false, tasks: true, relay: false },
      sidebar: { open: true, activeTab: 'connections' },
      agent: { id: 'agent-1', cwd: '/projects/my-app' },
    };
    const session = createMockSession(sessionState);
    const handler = createGetUiStateHandler(session);
    const result = await handler();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(sessionState);
  });

  it('returns default state when uiState is undefined', async () => {
    const session = createMockSession(undefined);
    const handler = createGetUiStateHandler(session);
    const result = await handler();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.canvas.open).toBe(false);
    expect(parsed.sidebar.open).toBe(true);
    expect(parsed.sidebar.activeTab).toBe('overview');
  });
});

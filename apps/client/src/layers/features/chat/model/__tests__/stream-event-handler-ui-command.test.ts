/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  HookPart,
  MessagePart,
  SessionStatusEvent,
  TaskUpdateEvent,
} from '@dorkos/shared/types';
import { createStreamEventHandler } from '../stream-event-handler';

// Mock useAppStore to return a controllable state object
const mockStore = {
  settingsOpen: false,
  setSettingsOpen: vi.fn(),
  pulseOpen: false,
  setPulseOpen: vi.fn(),
  relayOpen: false,
  setRelayOpen: vi.fn(),
  meshOpen: false,
  setMeshOpen: vi.fn(),
  pickerOpen: false,
  setPickerOpen: vi.fn(),
  setSidebarOpen: vi.fn(),
  setSidebarActiveTab: vi.fn(),
  setCanvasOpen: vi.fn(),
  setCanvasContent: vi.fn(),
  setCanvasPreferredWidth: vi.fn(),
  setGlobalPaletteOpen: vi.fn(),
  canvasOpen: false,
  canvasContent: null,
  canvasPreferredWidth: null,
};

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return {
    ...actual,
    useAppStore: Object.assign(
      (selector?: (s: Record<string, unknown>) => unknown) =>
        selector ? selector(mockStore as unknown as Record<string, unknown>) : mockStore,
      { getState: () => mockStore }
    ),
  };
});

function createDeps() {
  const currentPartsRef = { current: [] as MessagePart[] };
  const orphanHooksRef = { current: new Map<string, HookPart[]>() };
  const assistantCreatedRef = { current: true };
  const sessionStatusRef = { current: null as SessionStatusEvent | null };
  const streamStartTimeRef = { current: null as number | null };
  const estimatedTokensRef = { current: 0 };
  const textStreamingTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const isTextStreamingRef = { current: false };
  const thinkingStartRef = { current: null as number | null };
  const themeSetFn = vi.fn();

  const handler = createStreamEventHandler({
    currentPartsRef,
    orphanHooksRef,
    assistantCreatedRef,
    sessionStatusRef,
    streamStartTimeRef,
    estimatedTokensRef,
    textStreamingTimerRef,
    isTextStreamingRef,
    thinkingStartRef,
    setMessages: vi.fn(),
    setError: vi.fn(),
    setStatus: vi.fn(),
    setSessionStatus: vi.fn(),
    setEstimatedTokens: vi.fn(),
    setStreamStartTime: vi.fn(),
    setIsTextStreaming: vi.fn(),
    setRateLimitRetryAfter: vi.fn(),
    setIsRateLimited: vi.fn(),
    setSystemStatus: vi.fn(),
    setPromptSuggestions: vi.fn(),
    rateLimitClearRef: { current: null },
    sessionId: 'test-session',
    onTaskEventRef: { current: undefined as ((event: TaskUpdateEvent) => void) | undefined },
    onSessionIdChangeRef: {
      current: undefined as ((newSessionId: string) => void) | undefined,
    },
    onStreamingDoneRef: { current: undefined as (() => void) | undefined },
    onRemapRef: { current: undefined },
    themeRef: { current: themeSetFn },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, themeSetFn };
}

describe('stream-event-handler — ui_command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches open_panel command to store', () => {
    const { handler } = createDeps();
    handler('ui_command', { command: { action: 'open_panel', panel: 'pulse' } }, 'assistant-1');
    expect(mockStore.setPulseOpen).toHaveBeenCalledWith(true);
  });

  it('dispatches close_panel command to store', () => {
    const { handler } = createDeps();
    handler('ui_command', { command: { action: 'close_panel', panel: 'settings' } }, 'assistant-1');
    expect(mockStore.setSettingsOpen).toHaveBeenCalledWith(false);
  });

  it('dispatches show_toast command', async () => {
    const { handler } = createDeps();
    handler(
      'ui_command',
      { command: { action: 'show_toast', message: 'Done!', level: 'success' } },
      'assistant-1'
    );
    // Toast is called via sonner — mock at module level if needed
    // For now we verify no errors thrown
  });

  it('dispatches set_theme command via themeRef', () => {
    const { handler, themeSetFn } = createDeps();
    handler('ui_command', { command: { action: 'set_theme', theme: 'light' } }, 'assistant-1');
    expect(themeSetFn).toHaveBeenCalledWith('light');
  });

  it('dispatches open_canvas command to store', () => {
    const { handler } = createDeps();
    handler(
      'ui_command',
      {
        command: {
          action: 'open_canvas',
          content: { type: 'markdown', content: '# Hello' },
          preferredWidth: 50,
        },
      },
      'assistant-1'
    );
    expect(mockStore.setCanvasOpen).toHaveBeenCalledWith(true);
    expect(mockStore.setCanvasContent).toHaveBeenCalledWith({
      type: 'markdown',
      content: '# Hello',
    });
    expect(mockStore.setCanvasPreferredWidth).toHaveBeenCalledWith(50);
  });

  it('dispatches close_canvas command to store', () => {
    const { handler } = createDeps();
    handler('ui_command', { command: { action: 'close_canvas' } }, 'assistant-1');
    expect(mockStore.setCanvasOpen).toHaveBeenCalledWith(false);
  });

  it('dispatches open_command_palette command to store', () => {
    const { handler } = createDeps();
    handler('ui_command', { command: { action: 'open_command_palette' } }, 'assistant-1');
    expect(mockStore.setGlobalPaletteOpen).toHaveBeenCalledWith(true);
  });
});

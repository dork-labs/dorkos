// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

// ---------------------------------------------------------------------------
// Mock the runtime entity so tests can drive the capabilities the hook reports
// without standing up a full TransportProvider + QueryClient. The component
// resolves capabilities from a `runtime` prop via the static map lookup
// (useCapabilitiesForRuntime); the mock records the requested type so tests
// can assert the prop threads through.
// ---------------------------------------------------------------------------

const mockCapabilitiesForRuntime = vi.fn<
  (runtimeType: string | null | undefined) => RuntimeCapabilities | undefined
>(() => undefined);

vi.mock('@/layers/entities/runtime', () => ({
  useCapabilitiesForRuntime: (runtimeType: string | null | undefined) =>
    mockCapabilitiesForRuntime(runtimeType),
}));

// ---------------------------------------------------------------------------
// Mock the popover shell only — the dial inside it is the real component, so
// these tests exercise the same stop resolution the app runs.
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsivePopover: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="popover-root">{children}</div>
    ),
    ResponsivePopoverTrigger: ({
      children,
      asChild: _asChild,
      ...props
    }: {
      children: React.ReactNode;
      asChild?: boolean;
      [key: string]: unknown;
    }) => (
      <div data-testid="popover-trigger" {...props}>
        {children}
      </div>
    ),
    ResponsivePopoverContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="popover-content">{children}</div>
    ),
    ResponsivePopoverTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({
      children,
      asChild: _asChild,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
    }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tooltip-content">{children}</div>
    ),
  };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockCapabilitiesForRuntime.mockReturnValue(undefined);
});

// Import after mocks are set up
import { PermissionModeItem } from '../ui/PermissionModeItem';

// ---------------------------------------------------------------------------
// Capability fixtures — Claude, Codex, OpenCode, and test-mode mirror the REAL
// profiles in the server adapters' runtime-constants: the dial renders what a
// runtime declared, so anything else would prove nothing.
// ---------------------------------------------------------------------------

const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    values: [
      {
        id: 'default',
        label: 'Default',
        description: 'Prompt for each tool call',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        description: 'Auto-approve file edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      {
        id: 'plan',
        label: 'Plan',
        description: 'Research only, no edits',
        stop: 'ask',
        axis: 'working',
        asks: 'always',
        reach: 'read',
        promise: 'Reads and plans only. Nothing changes until you approve the plan.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        description: 'Auto-approve all',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
      {
        id: 'auto',
        label: 'Auto',
        description: 'Classifier approves or denies',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own and weighs each command, asking you about the risky ones.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {
    claudeSkills: true,
    claudeHooks: true,
    claudeSlashCommands: true,
  },
};

const TEST_MODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'test-mode',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: false,
  supportsMcp: false,
  supportsManagedMcpServers: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    values: [
      {
        id: 'always-allow',
        label: 'Always allow',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Approves every request without asking.',
      },
      {
        id: 'always-deny',
        label: 'Always deny',
        stop: 'ask',
        asks: 'always',
        reach: 'read',
        promise: 'Refuses every request.',
      },
      {
        id: 'scripted',
        label: 'Scripted',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: "Answers each request the way the test scenario's script says.",
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {
    testModeScenarios: ['simple-text'],
    deterministicLatencyMs: 0,
  },
};

const CODEX_CAPABILITIES: RuntimeCapabilities = {
  type: 'codex',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: true,
  supportsMcp: false,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Read only',
        description: 'Sandboxed reads.',
        stop: 'ask',
        asks: 'never',
        reach: 'read',
        promise: 'Reads files and answers questions. Nothing changes.',
        native: 'read-only',
      },
      {
        id: 'acceptEdits',
        label: 'Workspace write',
        description: 'Edits inside the workspace.',
        stop: 'act',
        asks: 'never',
        reach: 'workspace',
        promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
        native: 'workspace-write',
      },
      {
        id: 'bypassPermissions',
        label: 'Full access',
        description: 'No sandbox.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, network included.',
        native: 'danger-full-access',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

const OPENCODE_CAPABILITIES: RuntimeCapabilities = {
  type: 'opencode',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: false,
  supportsManagedMcpServers: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        description: 'Ask before edits.',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        description: 'Auto-accept file edits.',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        description: 'Skip all prompts.',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

const UNSUPPORTED_CAPABILITIES: RuntimeCapabilities = {
  type: 'no-modes-runtime',
  supportsToolApproval: false,
  supportsCostTracking: false,
  supportsResume: false,
  supportsMcp: false,
  supportsManagedMcpServers: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: { supported: false, values: [] },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

/** The three stops, as the dial drew them. */
function stopLabels(): string[] {
  return within(screen.getByRole('radiogroup'))
    .getAllByRole('radio')
    .map((s) => s.textContent ?? '');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionModeItem', () => {
  describe('the dial the runtime can offer', () => {
    it('gives every runtime the same three words', () => {
      for (const caps of [CLAUDE_CAPABILITIES, CODEX_CAPABILITIES, OPENCODE_CAPABILITIES]) {
        mockCapabilitiesForRuntime.mockReturnValue(caps);
        render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime={caps.type} />);
        expect(stopLabels(), caps.type).toEqual(['Ask first', 'Act', 'Full autonomy']);
        cleanup();
      }
    });

    it('keeps the three words for a runtime whose mode ids nobody has heard of', () => {
      mockCapabilitiesForRuntime.mockReturnValue(TEST_MODE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode={'always-allow' as never}
          onChangeMode={vi.fn()}
          runtime="test-mode"
        />
      );

      expect(stopLabels()).toEqual(['Ask first', 'Act', 'Full autonomy']);
      expect(screen.getByRole('radio', { name: 'Full autonomy' })).toBeChecked();
    });

    it('selects the mode that runtime declared for the stop', async () => {
      mockCapabilitiesForRuntime.mockReturnValue(TEST_MODE_CAPABILITIES);
      const onChangeMode = vi.fn();
      render(
        <PermissionModeItem
          mode={'always-allow' as never}
          onChangeMode={onChangeMode}
          runtime="test-mode"
        />
      );

      await userEvent.click(screen.getByRole('radio', { name: 'Ask first' }));
      expect(onChangeMode).toHaveBeenCalledWith('always-deny');
    });

    it('never offers Plan as a stop — it is a way of working, not a trust level', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime="claude-code" />);

      expect(screen.queryByRole('radio', { name: 'Plan' })).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Ask first' })).toBeChecked();
    });
  });

  describe('the word in the status line', () => {
    it("shows the runtime's own label for the current mode", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CODEX_CAPABILITIES);
      render(<PermissionModeItem mode="acceptEdits" onChangeMode={vi.fn()} runtime="codex" />);

      // 'acceptEdits' is 'Workspace write' on Codex — not 'Accept edits'.
      expect(screen.getByTestId('popover-trigger')).toHaveTextContent('Workspace write');
    });

    it('falls back to the shared name for a mode the runtime does not declare', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode={'dontAsk' as never} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('popover-trigger')).toHaveTextContent("Don't Ask");
      // …and the dial admits it has nowhere to point.
      expect(screen.getByTestId('trust-dial-stranded')).toHaveTextContent("Don't Ask");
    });
  });

  describe('what gets marked red', () => {
    /** The trigger's classes, where the current mode's tint lands. */
    function triggerClasses(): string {
      return screen.getByTestId('popover-trigger').querySelector('button')!.className;
    }

    it('marks the mode that never asks about anything, anywhere', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem mode="bypassPermissions" onChangeMode={vi.fn()} runtime="claude-code" />
      );

      expect(triggerClasses()).toContain('text-red-500');
    });

    it("marks Codex's full access too, from its own words rather than its id", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CODEX_CAPABILITIES);
      render(
        <PermissionModeItem mode="bypassPermissions" onChangeMode={vi.fn()} runtime="codex" />
      );

      expect(triggerClasses()).toContain('text-red-500');
    });

    it("leaves Codex's workspace-write unmarked, loud as its caption is", () => {
      mockCapabilitiesForRuntime.mockReturnValue(CODEX_CAPABILITIES);
      render(<PermissionModeItem mode="acceptEdits" onChangeMode={vi.fn()} runtime="codex" />);

      expect(triggerClasses()).not.toContain('text-red-500');
      // The divergence is said instead of shouted — amber, on the caption.
      expect(screen.getByTestId('trust-dial-caption').className).toContain('amber');
    });

    it('marks nothing while the capability map is still arriving', () => {
      mockCapabilitiesForRuntime.mockReturnValue(undefined);
      render(
        <PermissionModeItem mode="bypassPermissions" onChangeMode={vi.fn()} runtime="claude-code" />
      );

      expect(triggerClasses()).not.toContain('text-red-500');
    });
  });

  describe('the scope note beside the dial', () => {
    it('appears for a mode that runs everything, under whatever name the runtime gives it', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CODEX_CAPABILITIES);
      render(
        <PermissionModeItem mode="bypassPermissions" onChangeMode={vi.fn()} runtime="codex" />
      );

      expect(screen.getByText(/covers tools inside the session/i)).toBeInTheDocument();
    });

    it('appears for a bounded mode that never asks, too (DOR-816)', () => {
      // It used to stay away here, on the reasoning that the note is about
      // "runs everything". The note now follows the consent door, which gates
      // this mode: the sentence is true of any session mode, and the dialog
      // this one opens carries the strongest promise on any screen. See the
      // note's own suite for the full reasoning.
      mockCapabilitiesForRuntime.mockReturnValue(CODEX_CAPABILITIES);
      render(<PermissionModeItem mode="acceptEdits" onChangeMode={vi.fn()} runtime="codex" />);

      expect(screen.getByText(/covers tools inside the session/i)).toBeInTheDocument();
    });

    it('stays away from a mode that still stops to ask', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem mode="acceptEdits" onChangeMode={vi.fn()} runtime="claude-code" />
      );

      expect(screen.queryByText(/covers tools inside the session/i)).not.toBeInTheDocument();
    });
  });

  describe("'auto' per-model gating", () => {
    it('offers Auto inside the middle stop when the model can run it', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="acceptEdits"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode
        />
      );

      expect(screen.getByRole('switch', { name: /Auto/ })).toBeInTheDocument();
      expect(screen.getByText('Preview')).toBeInTheDocument();
      expect(screen.queryByTestId('auto-unsupported-hint')).not.toBeInTheDocument();
    });

    it('says why it is missing, where it would have been', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="acceptEdits"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode={false}
        />
      );

      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
      expect(screen.getByTestId('auto-unsupported-hint')).toBeInTheDocument();
      expect(screen.getByTestId('tooltip-content')).toHaveTextContent(
        'Auto mode requires Opus 4.6+ or Sonnet 4.6'
      );
    });

    it('keeps quiet about it from a stop it has nothing to do with', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="default"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode={false}
        />
      );

      expect(screen.queryByTestId('auto-unsupported-hint')).not.toBeInTheDocument();
    });

    it('still says where a session already in Auto stands', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="auto"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode={false}
        />
      );

      expect(screen.getByTestId('popover-trigger')).toHaveTextContent('Auto');
      expect(screen.getByTestId('trust-dial-stranded')).toHaveTextContent('Auto');
      // …and says WHY it is not one of the stops any more. This is the person
      // who most needs the model reason, and the stop-based condition alone hid
      // it from them, because a stranded session has no selected stop.
      expect(screen.getByTestId('auto-unsupported-hint')).toBeInTheDocument();
    });
  });

  describe('while Plan holds the session', () => {
    it('freezes the stops and says what planning means', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem mode="plan" onChangeMode={vi.fn()} runtime="claude-code" planActive />
      );

      expect(screen.getByTestId('popover-trigger')).toHaveTextContent('Plan');
      for (const stop of within(screen.getByRole('radiogroup')).getAllByRole('radio')) {
        expect(stop).toBeDisabled();
      }
      expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(/until you approve/i);
    });
  });

  describe('permissionModes.supported gating', () => {
    it('hides the item entirely when permissionModes.supported is false', () => {
      mockCapabilitiesForRuntime.mockReturnValue(UNSUPPORTED_CAPABILITIES);
      const { container } = render(
        <PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime="no-modes-runtime" />
      );

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('Server-default fallback (no runtime)', () => {
    it('resolves the server-default runtime when the runtime prop is omitted', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} />);

      expect(mockCapabilitiesForRuntime).toHaveBeenCalledWith(undefined);
      expect(stopLabels()).toEqual(['Ask first', 'Act', 'Full autonomy']);
    });
  });

  describe('Disabled state', () => {
    it('shows disabled trigger with tooltip when disabled=true', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem mode="default" onChangeMode={vi.fn()} disabled runtime="claude-code" />
      );

      expect(screen.getByRole('button')).toBeDisabled();
      expect(screen.getByText('Send a message first')).toBeInTheDocument();
      expect(screen.queryByTestId('popover-root')).not.toBeInTheDocument();
    });
  });

  describe('Compact (below the status line’s widest tier)', () => {
    it('bounds a runtime-supplied label so one verbose mode cannot spend the whole bar', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="bypassPermissions"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode
          compact
        />
      );

      expect(screen.getByTestId('popover-trigger')).toHaveTextContent('Bypass permi…');
    });

    it('keeps the full label as the accessible name — a shorter drawing, not a different answer', () => {
      mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
      render(
        <PermissionModeItem
          mode="bypassPermissions"
          onChangeMode={vi.fn()}
          runtime="claude-code"
          modelSupportsAutoMode
          compact
        />
      );

      expect(
        screen.getByRole('button', { name: 'Permissions: Bypass permissions' })
      ).toBeInTheDocument();
    });
  });

  describe('Loading state (capabilities undefined)', () => {
    it('names the current mode and offers no stops it cannot honour', () => {
      mockCapabilitiesForRuntime.mockReturnValue(undefined);
      render(<PermissionModeItem mode="default" onChangeMode={vi.fn()} runtime="claude-code" />);

      expect(screen.getByTestId('popover-trigger')).toHaveTextContent('Default');
      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      // No capabilities is not the same as a stranded session.
      expect(screen.queryByTestId('trust-dial-stranded')).not.toBeInTheDocument();
    });
  });
});

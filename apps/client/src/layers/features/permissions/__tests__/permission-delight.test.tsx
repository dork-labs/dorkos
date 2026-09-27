/**
 * @vitest-environment jsdom
 */
/**
 * Phase 4 of agent permissions: the "why?" behind every state, Undo in the
 * history (with its conflict question), and the honest "affects N agents"
 * preview on every surface that changes a default.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMockTransport } from '@dorkos/test-utils';
import type {
  PermissionHistoryEntry,
  PermissionLastChange,
  PermissionsResponse,
} from '@dorkos/shared/permissions';
import { TransportProvider } from '@/layers/shared/model';

import { lastChangeWhy, stateWhy } from '../lib/permission-why';
import { PermissionWhy } from '../ui/PermissionWhy';
import { PermissionHistory, conflictQuestion, partialUndoNote } from '../ui/PermissionHistory';
import { PermissionList } from '../ui/PermissionList';
import { PresetPicker } from '../ui/PresetPicker';

beforeAll(() => {
  // `sonner` and the responsive surfaces ask for matchMedia.
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

afterEach(() => cleanup());

function wrap(transport = createMockTransport()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, wrapper };
}

const CHANGE: PermissionLastChange = {
  eventId: 'evt-1',
  occurredAt: '2026-09-23T15:00:00.000Z',
  actorLabel: 'Someone on this computer',
  attribution: 'local-trust',
  surface: 'request-card',
};

describe('the why line', () => {
  it('names each source in its own sentence', () => {
    const base = { preset: 'full' as const };
    expect(stateWhy({ ...base, state: 'allowed', source: 'preset' })).toBe(
      'Allowed, from the default (Full power).'
    );
    expect(stateWhy({ ...base, state: 'ask', source: 'default-area' })).toBe(
      'Ask for everyone, changed from the default (Full power).'
    );
    expect(stateWhy({ ...base, state: 'allowed', source: 'default-action' })).toBe(
      'Allowed for everyone, set for this one action.'
    );
    expect(stateWhy({ ...base, state: 'blocked', source: 'agent-area' })).toBe(
      'Blocked, set for this agent.'
    );
    expect(
      stateWhy({ ...base, state: 'allowed', source: 'agent-action', agentName: 'DorkBot' })
    ).toBe('Allowed, set for this one action on DorkBot.');
    expect(stateWhy({ ...base, state: 'blocked', source: 'unchanged' })).toBe(
      'Blocked. No preset is chosen yet, so it works as it did before.'
    );
    expect(stateWhy({ ...base, state: 'blocked', source: 'inactive' })).toBe(
      "Blocked, because this agent's access was turned off."
    );
  });

  it('says a locked area can never be Allowed, and a destructive action always asks', () => {
    expect(stateWhy({ state: 'ask', source: 'floor', preset: 'full' })).toBe(
      'Ask. This is a locked area, so it can never be Allowed.'
    );
    expect(stateWhy({ state: 'ask', source: 'preset', destructiveAsk: true, preset: 'full' })).toBe(
      "Ask, because an action that can't be undone always asks unless you set it on its own."
    );
  });

  it('names the last change by the honesty rule, with where it was made', () => {
    expect(lastChangeWhy(CHANGE)).toMatch(
      /^Changed by someone on this computer on .+ from a request card\. Login is off, so DorkOS can't confirm who\.$/
    );
    expect(
      lastChangeWhy({
        ...CHANGE,
        attribution: 'signed-in',
        actorLabel: 'You (signed in as Dorian)',
        surface: 'settings',
      })
    ).toMatch(/^Changed by you \(signed in as Dorian\) on .+ in Settings\.$/);
    expect(
      lastChangeWhy({
        ...CHANGE,
        attribution: 'agent-request-approved',
        actorLabel: 'DorkBot asked, you said yes',
        surface: 'agent-request',
      })
    ).toMatch(/^Changed on .+: DorkBot asked, you said yes\.$/);
    expect(lastChangeWhy({ ...CHANGE, attribution: 'outside', surface: 'file-edit' })).toMatch(
      /^Changed outside DorkOS on .+, by an edit to the agent's settings file\.$/
    );
    expect(lastChangeWhy(undefined)).toBeNull();
  });

  it('opens on a click, naming the source and the last change', async () => {
    render(
      <PermissionWhy
        question="Why is Rooms set to Allowed?"
        sentence="Allowed, from the default (Full power)."
        lastChange={CHANGE}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Why is Rooms set to Allowed?' }));
    expect(await screen.findByTestId('permission-why-source')).toHaveTextContent(
      'Allowed, from the default (Full power).'
    );
    expect(screen.getByTestId('permission-why-change')).toHaveTextContent(
      /from a request card\. Login is off/
    );
  });
});

/** One area of the default layer. */
const ROOMS = {
  id: 'rooms' as const,
  label: 'Rooms',
  description: 'Make rooms',
  floor: false,
  kind: 'state' as const,
  actions: [
    {
      id: 'rooms.create',
      title: 'Create a room',
      tier: 'act' as const,
      resolved: {
        area: 'rooms' as const,
        state: 'allowed' as const,
        source: 'preset' as const,
        layer: 'default' as const,
      },
    },
  ],
  resolved: { state: 'allowed' as const, source: 'preset' as const, layer: 'default' as const },
  lastChange: CHANGE,
};

/** The default layer: 5 agents, one with Rooms of its own, one with a single action. */
const OVERVIEW: PermissionsResponse = {
  preset: 'full',
  defaults: { areas: {}, actions: {} },
  changeCount: 0,
  filesAndCommands: {
    stop: 'autonomy',
    presetStop: 'autonomy',
    runtimes: [],
    exceptions: [],
    followingAgentIds: ['a1', 'a2', 'a3', 'a4'],
  },
  areas: [ROOMS],
  exceptions: [
    { agentId: 'a1', agentName: 'security-auditor', area: 'rooms', state: 'blocked' },
    { agentId: 'a2', agentName: 'test-bot', area: 'rooms', action: 'rooms.create', state: 'ask' },
  ],
  agentCount: 5,
};

describe('the effect preview', () => {
  it('shows, before any change, how many agents each default reaches', async () => {
    const { wrapper } = wrap(
      createMockTransport({ getPermissions: vi.fn().mockResolvedValue(OVERVIEW) })
    );
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });

    // Rooms: the auditor has Rooms of its own; test-bot's single action does not
    // stop it following the rest of Rooms.
    const row = await screen.findByTestId('permission-row-rooms');
    expect(within(row).getByText('From Full power · affects 4 agents')).toBeInTheDocument();

    // The single action: neither the auditor (its area) nor test-bot (the action).
    await userEvent.click(within(row).getByRole('button', { name: 'Show individual actions' }));
    const action = within(row).getByTestId('permission-action-rooms.create');
    expect(within(action).getByText('· affects 3 agents')).toBeInTheDocument();
  });

  it('says the same count in the apply dialog', async () => {
    const { wrapper } = wrap(
      createMockTransport({ getPermissions: vi.fn().mockResolvedValue(OVERVIEW) })
    );
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });
    const row = await screen.findByTestId('permission-row-rooms');
    await userEvent.click(within(row).getByRole('radio', { name: 'Ask' }));
    expect(await screen.findByText('This affects 4 agents now.')).toBeInTheDocument();
  });

  it('on the preset picker, before a preset is chosen', async () => {
    const { wrapper } = wrap(
      createMockTransport({ getPermissions: vi.fn().mockResolvedValue(OVERVIEW) })
    );
    render(<PresetPicker surface="settings" />, { wrapper });
    expect(await screen.findByTestId('permissions-preset-preview')).toHaveTextContent(
      'Changing it affects 5 agents'
    );
  });

  it('has a "why?" on every default row, naming its last change', async () => {
    const { wrapper } = wrap(
      createMockTransport({ getPermissions: vi.fn().mockResolvedValue(OVERVIEW) })
    );
    render(<PermissionList scope={{ kind: 'default' }} />, { wrapper });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Why is Rooms set to Allowed?' })
    );
    expect(await screen.findByTestId('permission-why-source')).toHaveTextContent(
      'Allowed, from the default (Full power).'
    );
    expect(screen.getByTestId('permission-why-change')).toHaveTextContent(/from a request card/);
  });
});

/** One history row. */
function entry(overrides: Partial<PermissionHistoryEntry> = {}): PermissionHistoryEntry {
  return {
    id: 'evt-1',
    occurredAt: new Date().toISOString(),
    actorLabel: 'Someone on this computer',
    actorDetail: null,
    summary: 'Rooms set to Ask for everyone',
    metadata: {
      changes: [
        {
          target: { kind: 'default' },
          key: { kind: 'area', area: 'rooms' },
          before: null,
          after: 'ask',
        },
      ],
      surface: 'settings',
      attribution: 'local-trust',
    },
    undoable: true,
    undone: false,
    ...overrides,
  };
}

describe('Undo in the history', () => {
  it('undoes a change, and has no Undo for an answer or a change already undone', async () => {
    // Undone, as the server says: an Undo of it stands.
    const undone = entry({
      id: 'evt-0',
      summary: 'Tasks set to Blocked for everyone',
      undone: true,
    });
    const undo = entry({
      id: 'evt-2',
      summary: 'Undo: Tasks set back to the preset for everyone',
      metadata: { ...undone.metadata, surface: 'undo', undoOf: 'evt-0' },
    });
    const answered = entry({
      id: 'evt-3',
      summary: 'Someone on this computer allowed DorkBot to run "Open a room" once',
      metadata: { changes: [], surface: 'request-card', attribution: 'local-trust' },
      undoable: false,
    });
    const undoPermissionChange = vi.fn().mockResolvedValue({ changes: [], skipped: [] });
    const { wrapper } = wrap(
      createMockTransport({
        getPermissionHistory: vi.fn().mockResolvedValue({
          items: [answered, undo, entry(), undone],
          nextCursor: null,
        }),
        undoPermissionChange,
      })
    );
    render(<PermissionHistory />, { wrapper });

    const rows = await screen.findAllByTestId('permission-history-row');
    expect(within(rows[0]!).queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
    expect(within(rows[3]!).getByText('Undone')).toBeInTheDocument();
    expect(within(rows[3]!).queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();

    await userEvent.click(
      within(rows[2]!).getByRole('button', { name: /^Undo: Rooms set to Ask for everyone/ })
    );
    expect(undoPermissionChange).toHaveBeenCalledWith('evt-1', {});
  });

  it('asks before overwriting a change made since, with the value it would write', async () => {
    const conflict = Object.assign(new Error('This has changed since. Set it back anyway?'), {
      code: 'UNDO_CONFLICT',
      status: 409,
      body: {
        conflicts: [
          {
            change: {
              target: { kind: 'agent', agentId: 'a1', agentPath: '/a1', agentName: 'Auditor' },
              key: { kind: 'area', area: 'rooms' },
              before: 'ask',
              after: 'allowed',
            },
            current: 'blocked',
            reason: 'changed-since',
          },
        ],
      },
    });
    const undoPermissionChange = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ changes: [], skipped: [] });
    const { wrapper } = wrap(
      createMockTransport({
        getPermissionHistory: vi.fn().mockResolvedValue({ items: [entry()], nextCursor: null }),
        undoPermissionChange,
      })
    );
    render(<PermissionHistory />, { wrapper });

    await userEvent.click(await screen.findByRole('button', { name: /^Undo:/ }));
    expect(
      await screen.findByText('This has changed since. Set it back to Ask anyway?')
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set it back' }));
    await waitFor(() =>
      expect(undoPermissionChange).toHaveBeenLastCalledWith('evt-1', { force: true })
    );
  });

  it('says what a bulk Undo left alone', async () => {
    const skip = {
      change: entry().metadata.changes[0]!,
      current: 'blocked',
      reason: 'changed-since' as const,
    };
    const undoPermissionChange = vi.fn().mockResolvedValue({
      changes: [skip.change, skip.change, skip.change],
      skipped: [skip],
    });
    const { wrapper } = wrap(
      createMockTransport({
        getPermissionHistory: vi.fn().mockResolvedValue({ items: [entry()], nextCursor: null }),
        undoPermissionChange,
      })
    );
    render(<PermissionHistory />, { wrapper });
    await userEvent.click(await screen.findByRole('button', { name: /^Undo:/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Undid 3 changes. 1 had changed since and was left alone.'
    );
  });

  it('words the question and the note for each case', () => {
    const change = entry().metadata.changes[0]!;
    expect(conflictQuestion([{ change, current: 'blocked', reason: 'changed-since' }])).toBe(
      'This has changed since. Set it back to the preset anyway?'
    );
    expect(
      conflictQuestion([
        { change, current: 'blocked', reason: 'changed-since' },
        { change, current: 'blocked', reason: 'changed-since' },
      ])
    ).toBe('Some of this has changed since. Set it all back anyway?');
    // A Files & commands stop reads as the stop, never as the state that
    // shares its value.
    const files = {
      target: { kind: 'default' as const },
      key: { kind: 'files' as const },
      before: 'ask',
      after: 'autonomy',
    };
    expect(conflictQuestion([{ change: files, current: 'act', reason: 'changed-since' }])).toBe(
      'This has changed since. Set it back to Ask first anyway?'
    );
    expect(
      conflictQuestion([
        { change: { ...files, before: 'autonomy' }, current: 'act', reason: 'changed-since' },
      ])
    ).toBe('This has changed since. Set it back to Full autonomy anyway?');
    expect(partialUndoNote({ changes: [change], skipped: [] })).toBeNull();
    expect(partialUndoNote({ changes: [], skipped: [] })).toBe(
      'Nothing to undo. It was already back the way it was.'
    );
    expect(
      partialUndoNote({
        changes: [change],
        skipped: [{ change, current: 'ask', reason: 'floor' }],
      })
    ).toBe(
      'Undid 1 change. 1 would have set something that always asks to Allowed, so it was left alone.'
    );
  });
});

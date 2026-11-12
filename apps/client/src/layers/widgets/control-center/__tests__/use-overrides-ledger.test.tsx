// @vitest-environment jsdom
/**
 * The overrides ledger's composition — the honesty section of the Control Center
 * (spec `full-power-defaults`, D7).
 *
 * The data hooks are REAL: config, capabilities, sessions, tasks, bindings and
 * permissions are read through a mock transport and a real query client
 * (`test-helpers/transport-query`), so the test decides only what the server
 * said and the hooks' own keys, gates and shapes stay under test. The
 * permission sentences are the real ones too. Only the navigation seams are
 * replaced, because they need full routes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { Transport } from '@dorkos/shared/transport';
import { createMockSession, createMockTransport } from '@dorkos/test-utils';
import { buildTransportQueryHarness } from '@/test-helpers/transport-query';

const navigate = vi.fn();
const openSettings = vi.fn();
const openConnections = vi.fn();
const openProfile = vi.fn();

// Only the navigation seams are replaced. The app store is REAL, so "the flyout
// closes" is read off `controlCenterOpen` itself rather than off a setter spy.
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => navigate,
  useOpenConnections: () => openConnections,
  useSettingsDeepLink: () => ({ open: openSettings }),
  useProfileDeepLink: () => ({ open: openProfile }),
}));

import { useAppStore } from '@/layers/shared/model';
import { useOverridesLedger } from '../model/use-overrides-ledger';

/**
 * Open the flyout, follow one row's link, and report whether the flyout was
 * already shut at the moment the link fired (and is shut afterwards).
 */
function followWithFlyoutOpen(
  onOpen: (() => void) | null | undefined,
  link: ReturnType<typeof vi.fn>
): { closedWhenLinkFired: boolean; closedAfter: boolean } {
  useAppStore.setState({ controlCenterOpen: true });
  let closedWhenLinkFired = false;
  link.mockImplementationOnce(() => {
    closedWhenLinkFired = !useAppStore.getState().controlCenterOpen;
  });
  onOpen?.();
  return { closedWhenLinkFired, closedAfter: !useAppStore.getState().controlCenterOpen };
}

const DESCRIPTORS: PermissionModeDescriptor[] = [
  { id: 'default', label: 'Ask', stop: 'ask', asks: 'always', reach: 'edit', promise: 'Asks.' },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Acts.',
  },
  {
    id: 'bypassPermissions',
    label: 'Full autonomy',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything.',
  },
];

/** Global stop resolves to 'ask' (default runtime's default mode is `default`). */
const CAPABILITIES = {
  defaultRuntime: 'claude-code',
  capabilities: {
    'claude-code': {
      permissionModes: { supported: true, default: 'default', values: DESCRIPTORS },
    },
  },
};

/** An overview with nobody set differently: the ledger's permissions half, answered. */
const NO_EXCEPTIONS = { areas: [], exceptions: [], filesAndCommands: { exceptions: [] } };

/** The folder the sessions query is scoped to; the store holds it, as in the app. */
const CWD = '/repo';

type ExecutionDefaults = { runtime: string; trustStop: string; perRuntime: unknown[] };

/** What the server says, per read. Anything left out answers "nothing here". */
interface ServerAnswers {
  executionDefaults?: ExecutionDefaults;
  sessions?: ReturnType<typeof createMockSession>[];
  tasks?: unknown[];
  bindings?: unknown[];
  permissions?: unknown;
  /** The permissions read fails instead of answering. */
  permissionsFail?: boolean;
  /** The capabilities read never answers. */
  capabilitiesPending?: boolean;
  /** The permissions read never answers. */
  permissionsPending?: boolean;
}

const never = () => new Promise<never>(() => {});

/** Mount the real ledger on a transport that answers `answers`. */
async function mountLedger(answers: ServerAnswers = {}) {
  const baseConfig = await createMockTransport().getConfig();
  const overrides: Partial<Transport> = {
    getConfig: vi.fn().mockResolvedValue({
      ...baseConfig,
      tasks: { enabled: true },
      executionDefaults: answers.executionDefaults ?? {
        runtime: 'claude-code',
        trustStop: 'ask',
        perRuntime: [],
      },
    }),
    getCapabilities: answers.capabilitiesPending
      ? vi.fn(never)
      : vi.fn().mockResolvedValue(CAPABILITIES),
    listSessions: vi.fn().mockResolvedValue({ sessions: answers.sessions ?? [] }),
    listTasks: vi.fn().mockResolvedValue(answers.tasks ?? []),
    getBindings: vi.fn().mockResolvedValue(answers.bindings ?? []),
    getPermissions: answers.permissionsPending
      ? vi.fn(never)
      : answers.permissionsFail
        ? vi.fn().mockRejectedValue(new Error('offline'))
        : vi.fn().mockResolvedValue(answers.permissions ?? NO_EXCEPTIONS),
    patchAgentPermissions: vi.fn().mockResolvedValue({}),
  } as Partial<Transport>;
  const harness = buildTransportQueryHarness(overrides);
  const view = renderHook(() => useOverridesLedger(), { wrapper: harness.Wrapper });
  return { ...view, transport: harness.transport };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ controlCenterOpen: false, selectedCwd: CWD });
});

describe('useOverridesLedger', () => {
  it('reports isResolving until config and capabilities have loaded', async () => {
    const { result, transport } = await mountLedger({ capabilitiesPending: true });
    // The other reads land; the ledger still waits on the one that has not.
    await waitFor(() => expect(transport.getPermissions).toHaveBeenCalled());
    expect(result.current.isResolving).toBe(true);
    expect(result.current.isEmpty).toBe(false);
    expect(result.current.rows).toHaveLength(0);
  });

  it('shows the calm empty state when nothing diverges from the dial', async () => {
    const { result } = await mountLedger();
    await waitFor(() => expect(result.current.isResolving).toBe(false));
    expect(result.current.isEmpty).toBe(true);
    expect(result.current.rows).toHaveLength(0);
  });

  it('builds one row each for a runtime override, a divergent session, a task and a binding', async () => {
    const { result } = await mountLedger({
      executionDefaults: {
        runtime: 'claude-code',
        trustStop: 'ask',
        perRuntime: [{ runtime: 'codex', trustStop: 'autonomy' }],
      },
      sessions: [
        createMockSession({
          id: 's1',
          title: 'My session',
          runtime: 'claude-code',
          permissionMode: 'bypassPermissions',
          cwd: CWD,
        }),
      ],
      tasks: [{ id: 't1', name: 'Nightly', permissionMode: 'bypassPermissions' }],
      bindings: [
        { id: 'b1', label: 'Deploys', adapterId: 'slack', permissionMode: 'bypassPermissions' },
      ],
    });

    await waitFor(() =>
      expect(result.current.rows.map((r) => r.kind)).toEqual([
        'runtime',
        'session',
        'task',
        'binding',
      ])
    );
    expect(result.current.isEmpty).toBe(false);

    // Each row deep-links to its owning surface, and closes the modal flyout
    // BEFORE it navigates — a link that left it open lands the person on a page
    // still locked behind `body { pointer-events: none }` (or stacks a second
    // modal over it).
    const row = (kind: string) => result.current.rows.find((r) => r.kind === kind)?.onOpen;
    const shutFirst = { closedWhenLinkFired: true, closedAfter: true };

    expect(followWithFlyoutOpen(row('runtime'), openSettings)).toEqual(shutFirst);
    expect(openSettings).toHaveBeenCalledWith('runtimes');
    expect(followWithFlyoutOpen(row('session'), navigate)).toEqual(shutFirst);
    // `toSession` drops `dir` on purpose: a session link names the session, and
    // the session's own record carries its folder.
    expect(navigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 's1', dir: undefined },
    });
    expect(followWithFlyoutOpen(row('task'), navigate)).toEqual(shutFirst);
    expect(navigate).toHaveBeenCalledWith({ to: '/tasks' });
    expect(followWithFlyoutOpen(row('binding'), openConnections)).toEqual(shutFirst);
    expect(openConnections).toHaveBeenCalledWith({ app: 'slack' });
  });

  it('does NOT list a runtime, session, task or binding that sits at the global stop', async () => {
    // A per-runtime override EQUAL to the global stop is not an exception. Global
    // is `ask` (the seeded default), so a runtime override at `ask` must produce
    // no row — the same rule the session/task/binding branches apply.
    const { result, transport } = await mountLedger({
      executionDefaults: {
        runtime: 'claude-code',
        trustStop: 'ask',
        perRuntime: [{ runtime: 'codex', trustStop: 'ask' }],
      },
      sessions: [
        createMockSession({
          id: 's1',
          title: 'Quiet',
          runtime: 'claude-code',
          permissionMode: 'default',
          cwd: CWD,
        }),
      ],
      tasks: [{ id: 't1', name: 'Quiet task', permissionMode: 'default' }],
      bindings: [{ id: 'b1', label: 'Quiet bind', adapterId: 'x', permissionMode: 'default' }],
    });

    // Every read has answered, so an empty ledger is a verdict, not a gap.
    await waitFor(() => {
      expect(transport.listSessions).toHaveBeenCalled();
      expect(transport.listTasks).toHaveBeenCalled();
      expect(transport.getBindings).toHaveBeenCalled();
      expect(result.current.isResolving).toBe(false);
    });
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.isEmpty).toBe(true);
  });

  it("lists each agent's own permission, opens its page, and resets it in one tap", async () => {
    const CHANGE = {
      eventId: 'evt-1',
      occurredAt: '2026-09-23T10:00:00.000Z',
      actorLabel: 'Someone on this computer',
      attribution: 'local-trust',
      surface: 'settings',
    };
    const { result, transport } = await mountLedger({
      permissions: {
        areas: [
          {
            id: 'rooms',
            label: 'Rooms',
            actions: [{ id: 'rooms.create', title: 'create rooms' }],
          },
        ],
        exceptions: [
          {
            agentId: 'a1',
            agentName: 'security-auditor',
            area: 'rooms',
            state: 'blocked',
            lastChange: CHANGE,
          },
          {
            agentId: 'a2',
            agentName: 'DorkBot',
            area: 'rooms',
            action: 'rooms.create',
            state: 'allowed',
          },
        ],
        filesAndCommands: {
          exceptions: [{ agentId: 'a1', agentName: 'security-auditor', stop: 'ask' }],
        },
      },
    });

    await waitFor(() =>
      expect(result.current.rows.filter((r) => r.kind === 'agent-permission')).toHaveLength(3)
    );
    const rows = result.current.rows.filter((r) => r.kind === 'agent-permission');
    expect(rows.map((r) => `${r.name}: ${r.detail}`)).toEqual([
      'security-auditor: Rooms Blocked',
      'DorkBot: create rooms Allowed',
      'security-auditor: Files & commands Ask first',
    ]);

    // Each explains itself: where it comes from, and the last change behind it.
    // The sentences are the real ones the Permissions page uses.
    expect(rows.map((r) => r.why?.question)).toEqual([
      'Why is Rooms set to Blocked for security-auditor?',
      'Why is create rooms set to Allowed for DorkBot?',
      'Why is Files & commands set to Ask first for security-auditor?',
    ]);
    expect(rows[0]!.why).toMatchObject({
      sentence: 'Blocked, set for security-auditor.',
      lastChange: CHANGE,
    });
    expect(rows[1]!.why?.sentence).toBe('Allowed, set for this one action on DorkBot.');
    expect(rows[1]!.why?.lastChange).toBeUndefined();
    expect(rows[2]!.why?.sentence).toBe('Ask first, set for security-auditor.');

    rows[0]!.onOpen?.();
    expect(openProfile).toHaveBeenCalledWith('a1', 'permissions');

    // A reset is the real mutation: what reaches the server is the agent's one
    // setting put back to the default, said as a null for that key.
    rows[0]!.onReset?.();
    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenCalledWith('a1', {
        areas: { rooms: null },
        surface: 'control-center',
      })
    );
    rows[1]!.onReset?.();
    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenLastCalledWith('a2', {
        actions: { 'rooms.create': null },
        surface: 'control-center',
      })
    );
    rows[2]!.onReset?.();
    await waitFor(() =>
      expect(transport.patchAgentPermissions).toHaveBeenLastCalledWith('a1', {
        filesAndCommands: null,
        surface: 'control-center',
      })
    );
  });

  it('waits for the permissions before saying nothing is overridden', async () => {
    const { result, transport } = await mountLedger({ permissionsPending: true });
    await waitFor(() => expect(transport.getCapabilities).toHaveBeenCalled());
    expect(result.current.isResolving).toBe(true);
    expect(result.current.isEmpty).toBe(false);
  });

  it('says it could not read them, rather than that nothing differs, when the read fails', async () => {
    const { result } = await mountLedger({ permissionsFail: true });
    await waitFor(() => expect(result.current.permissionsUnreadable).toBe(true));
    expect(result.current.isResolving).toBe(false);
    expect(result.current.isEmpty).toBe(false);
  });
});

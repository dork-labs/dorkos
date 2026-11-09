/**
 * The Permissions-area gate on an agent's read approval and an agent's Undo
 * (spec `agent-grant-autonomy` §4.2, §4.3; Security 11:11 CT, "made
 * explicit"): each asks a person unless the caller's Permissions area is
 * Allowed, and goes ahead when it is. The real tools run through the real
 * registry and resolver; only the approval service behind them is a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentPermissions } from '@dorkos/shared/permissions';
import { ACCESS_CHANGE_CAPABILITIES } from '../access/access-change-capabilities.js';
import type { AccessApprovalService } from '../access/access-approval.js';
import type { AccessNarrowingService } from '../access/access-narrowing.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { eventFanOut } from '../../core/event-fan-out.js';

const PM_PATH = '/agents/pm';
const CALLS = [
  { id: 'connectors.approve_request', input: { requestId: 'request-a' } },
  { id: 'connectors.undo_access_change', input: { changeId: 'change-a' } },
] as const;

describe('the Permissions-area gate on approve_request and undo_access_change', () => {
  let db: Db;
  let approvals: ApprovalService;
  let registry: CapabilityRegistry;
  let agent: AgentPermissions;
  let approve: ReturnType<typeof vi.fn>;
  let undo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb();
    approvals = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    initCapabilityTierGate({ approvals });
    initPermissionGate({
      readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => agent,
    });
    approve = vi.fn(async () => ({
      changeId: 'change-b',
      connectionId: 'connection-a',
      requestAnswered: true,
    }));
    undo = vi.fn(async () => ({ undoId: 'undo-b' }));
    registry = composeRegistry(
      [{ name: 'connectors', capabilities: [...ACCESS_CHANGE_CAPABILITIES] }],
      {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        accessChangeDeps: {
          approval: { approve, undo } as unknown as AccessApprovalService,
          narrowing: {} as AccessNarrowingService,
          db,
        },
      }
    );
  });

  afterEach(() => {
    resetCapabilityTierGate();
    resetPermissionGate();
    vi.restoreAllMocks();
  });

  async function call(id: string, input: object) {
    const serverPrincipal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-a' },
      bindingId: 'binding-a',
      runtime: 'claude-code',
      canonicalSessionId: 'session-pm',
      agentId: 'pm',
      agentPath: PM_PATH,
    });
    try {
      await registry.invoke(id, input, {
        identity: { agentPath: PM_PATH, displayName: 'PM', createdAt: new Date().toISOString() },
        serverPrincipal,
        retryChannel: 'mcp-argument',
      });
      return 'ran' as const;
    } catch (error) {
      return (error as { decision?: { payload: Record<string, unknown> } }).decision?.payload;
    }
  }

  for (const { id, input } of CALLS) {
    it(`${id} asks a person when Permissions is Ask, and does nothing yet`, async () => {
      agent = { areas: { permissions: 'ask' } };
      expect(await call(id, input)).toMatchObject({ status: 'approval_required' });
      expect(approvals.listPending()).toHaveLength(1);
      expect(approve).not.toHaveBeenCalled();
      expect(undo).not.toHaveBeenCalled();
    });

    it(`${id} goes ahead when Permissions is Allowed`, async () => {
      agent = { areas: { permissions: 'allowed' } };
      expect(await call(id, input)).toBe('ran');
      expect(approve.mock.calls.length + undo.mock.calls.length).toBe(1);
    });
  }
});

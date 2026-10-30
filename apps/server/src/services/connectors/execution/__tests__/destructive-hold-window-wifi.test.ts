/**
 * No message shown as the owner's counts as proof for an irreversible action
 * (DOR-3242). Once the owner's own words from Wi-Fi stop being held, a turn
 * they start can run at a level that never asks. So while Wi-Fi access is open
 * over plain `http`, where a copied sign-in could be anyone, a destructive
 * connected-app call below Full keeps its approval card instead of the
 * 60-second window, whoever started the turn. That card cannot be answered
 * from Wi-Fi (`routes/approvals.ts`). HTTPS on that path (DOR-3173) lifts it.
 *
 * A chat set to Full autonomy has no such limit (the owner's rule): it waits
 * out the same 60 seconds, which anyone but the agent can cancel, Wi-Fi open
 * or not, and never gets a card.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type {
  CapabilityInvocationContext,
  CapabilityPreflightResult,
} from '../../../core/capabilities/registry.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import type { DestructiveHoldService } from '../destructive-hold.js';
import {
  cancelWindowFor,
  holdRequesterFor,
  type HoldEligibilitySources,
} from '../destructive-hold-window.js';

const HOME = '/agents/scout';
const SESSION = 'chat-scout';
const FULL: TurnPermissionLevel = { asks: 'never', reach: 'everything' };

const context = {
  identity: { agentPath: HOME, displayName: 'Scout', createdAt: '2026-10-29T00:00:00.000Z' },
  sessionId: SESSION,
  serverPrincipal: createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-a' },
    bindingId: 'binding-a',
    runtime: 'claude-code',
    canonicalSessionId: SESSION,
    agentId: 'agent-scout',
    agentPath: HOME,
    canonicalCwd: HOME,
  }),
} as unknown as CapabilityInvocationContext;

const preflight = {
  approvalServiceAction: { actionName: 'Send email', serviceName: 'Gmail' },
  authorityBinding: { approvalScope: { digest: 'digest-a' } },
} as unknown as CapabilityPreflightResult;

/**
 * A Trusted install, a known agent, an unmarked turn that never asks: eligible but for Wi-Fi.
 * `chosenFull` says whether the chat itself is set to Full autonomy.
 */
function sources(plainWifiOpen: boolean, chosenFull = false): HoldEligibilitySources {
  return {
    trusted: () => true,
    describeAgent: async () => context.identity,
    turnLevel: () => FULL,
    strangerTurn: () => false,
    plainWifiOpen: () => plainWifiOpen,
    chosenFull: () => chosenFull,
  };
}

describe('the cancel window at Full while Wi-Fi is plain http', () => {
  it('holds a Full chat for 60 seconds with Wi-Fi open, and shows no card', async () => {
    expect(await holdRequesterFor(context, preflight, sources(true, true))).toMatchObject({
      agentPath: HOME,
      sessionId: SESSION,
    });
    const holds = {
      start: vi.fn(async () => ({ holdId: 'h1', ended: new Promise(() => {}) })),
    } as unknown as DestructiveHoldService;
    expect(typeof (await cancelWindowFor(holds, context, preflight, sources(true, true)))).toBe(
      'function'
    );
    expect(holds.start).toHaveBeenCalledOnce();
  });

  it('still runs when Wi-Fi opens mid-wait', async () => {
    let open = false;
    const live = { ...sources(false, true), plainWifiOpen: () => open };
    expect(await holdRequesterFor(context, preflight, live)).toBeDefined();
    open = true;
    expect(await holdRequesterFor(context, preflight, live, true)).toBeDefined();
  });

  it('still keeps the card on Careful', async () => {
    const careful = { ...sources(true, true), trusted: () => false };
    expect(await holdRequesterFor(context, preflight, careful)).toBeUndefined();
  });
});

describe('the cancel window below Full while Wi-Fi is plain http', () => {
  it('holds a turn that never asks for 60 seconds when Wi-Fi access is closed', async () => {
    expect(await holdRequesterFor(context, preflight, sources(false))).toMatchObject({
      agentPath: HOME,
      sessionId: SESSION,
    });
  });

  it('keeps the card when Wi-Fi access is open', async () => {
    expect(await holdRequesterFor(context, preflight, sources(true))).toBeUndefined();
  });

  it('says why the card appears, only when Wi-Fi is the one reason', async () => {
    const holds = {
      start: vi.fn(async () => ({ holdId: 'h1', ended: new Promise(() => {}) })),
    } as unknown as DestructiveHoldService;
    expect(await cancelWindowFor(holds, context, preflight, sources(true))).toEqual({
      keptCardBecause: 'wifi-open',
    });
    expect(holds.start).not.toHaveBeenCalled();
    // On Careful there is no window to skip, so nothing to explain.
    const careful = { ...sources(true), trusted: () => false };
    expect(await cancelWindowFor(holds, context, preflight, careful)).toBeUndefined();
    // Wi-Fi closed: the window itself.
    expect(typeof (await cancelWindowFor(holds, context, preflight, sources(false)))).toBe(
      'function'
    );
  });

  it('is re-read when the 60 seconds are up, so Wi-Fi opening mid-wait stops the run', async () => {
    let open = false;
    const live = { ...sources(false), plainWifiOpen: () => open };
    expect(await holdRequesterFor(context, preflight, live)).toBeDefined();
    open = true;
    expect(await holdRequesterFor(context, preflight, live, true)).toBeUndefined();
  });
});

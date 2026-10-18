/**
 * The hub-setup table (DOR-2939 part 6), checked against every action that
 * exists: each registry capability and each hand-registered MCP tool. The
 * expected set is written out, so a change of tier or area that moves a tool
 * in or out of it fails here and has to be decided.
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeAction } from '../hub-setup-tools.js';

vi.mock('../../../../env.js', () => ({ env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined } }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));

const {
  DORKBOT_NEEDS_OWN_COMPUTER,
  HUB_SETUP_AGENT_ACTIONS,
  HUB_SETUP_REFUSAL,
  bridgeActionFor,
  bridgeActionForCapability,
  forwardedToolName,
  handToolBridgeActions,
  hubSetupToolRefusal,
  isHubSetupAction,
  isHubSetupCall,
} = await import('../hub-setup-tools.js');
const { composeCapabilityRegistryForDocs } =
  await import('../../self-description/dorkos-registry.js');

const capabilities = composeCapabilityRegistryForDocs().capabilities;
const everyAction = [...capabilities.map(bridgeActionForCapability), ...handToolBridgeActions()];

/** Every setup action today, by id. Moving one in or out is a decision, made here. */
const EXPECTED_SETUP = [
  // named, whatever their area
  'agent.pause',
  'agent.resume',
  'ui.approve_doc_route',
  'ui.configure_doc_channel',
  'create_agent',
  'mesh_deny',
  'mesh_register',
  'mesh_unregister',
  'operator.update_agent',
  'operator.update_agent_execution',
  // connections
  'binding_create',
  'binding_delete',
  'relay_disable_adapter',
  'relay_enable_adapter',
  'relay_reload_adapters',
  // packages
  'create_extension',
  'marketplace.create_package',
  'marketplace.install',
  'marketplace.uninstall',
  'marketplace.update',
  'mcp.add',
  'mcp.disable',
  'mcp.enable',
  'mcp.import',
  'mcp.remove',
  'mcp.set_client',
  'mcp.signin',
  'mcp.test',
  'mcp.update',
  'reload_extensions',
  'test_extension',
  // permissions, safety, settings
  'operator.config_patch',
  'operator.update_agent_boundaries',
  'permissions.change',
].sort();

const GRANTED_DORKBOT = { agentIsDorkBot: true, setupGranted: true, aloneOnComputer: true };
const NOT_DORKBOT = { agentIsDorkBot: false, setupGranted: true, aloneOnComputer: true };

describe('the hub-setup table', () => {
  it('classifies every registered capability and hand tool exactly as written down', () => {
    const setup = everyAction.filter(isHubSetupAction).map((action) => action.id);
    expect(setup.sort()).toEqual(EXPECTED_SETUP);
  });

  it('names only actions that exist, each one that changes something', () => {
    for (const id of HUB_SETUP_AGENT_ACTIONS) {
      const action = everyAction.find((candidate) => candidate.id === id);
      expect(action, id).toBeDefined();
      expect(action!.tier, id).not.toBe('observe');
    }
  });

  it('never counts a read, whatever its area', () => {
    for (const action of everyAction.filter((candidate) => candidate.tier === 'observe')) {
      expect(isHubSetupAction(action), action.id).toBe(false);
    }
  });

  it('leaves rooms, tasks, messages, own chat and extensions to agents', () => {
    const open = new Set(['rooms', 'tasks', 'messages', 'own_chat', 'extensions']);
    for (const action of everyAction.filter((candidate) => open.has(candidate.area ?? ''))) {
      expect(isHubSetupAction(action), action.id).toBe(false);
    }
  });

  it('covers a tool nobody listed, from its tier and area alone', () => {
    const fresh = { id: 'packages.brand_new', tier: 'act', area: 'packages' } as const;
    expect(isHubSetupAction(fresh)).toBe(true);
    expect(isHubSetupAction({ ...fresh, tier: 'observe' })).toBe(false);
    expect(isHubSetupAction({ ...fresh, area: 'rooms' })).toBe(false);
  });

  it('counts a call whose input reaches a setup area', () => {
    const patch: BridgeAction = {
      id: 'ops.patch',
      toolName: 'patch',
      title: 'Patch',
      tier: 'act',
      area: 'tasks',
      areasForInput: () => ['permissions'],
    };
    expect(isHubSetupAction(patch)).toBe(false);
    expect(isHubSetupCall(patch, {})).toBe(true);
  });
});

describe('the refusal', () => {
  const install = bridgeActionFor('marketplace_install', capabilities)!;

  it('refuses a setup tool to every agent but DorkBot with its grant', () => {
    expect(hubSetupToolRefusal(install, NOT_DORKBOT)).toBe(HUB_SETUP_REFUSAL);
    expect(hubSetupToolRefusal(install, { ...GRANTED_DORKBOT, setupGranted: false })).toBe(
      HUB_SETUP_REFUSAL
    );
    expect(hubSetupToolRefusal(install, GRANTED_DORKBOT)).toBeNull();
    expect(hubSetupToolRefusal(install, { ...GRANTED_DORKBOT, aloneOnComputer: false })).toBe(
      DORKBOT_NEEDS_OWN_COMPUTER
    );
  });

  it('never refuses an ordinary tool', () => {
    const post = bridgeActionFor('post_to_room', capabilities)!;
    expect(
      hubSetupToolRefusal(post, {
        agentIsDorkBot: false,
        setupGranted: false,
        aloneOnComputer: false,
      })
    ).toBeNull();
  });

  it('says it in at most 15 words', () => {
    for (const copy of [HUB_SETUP_REFUSAL, DORKBOT_NEEDS_OWN_COMPUTER]) {
      expect(copy.split(/\s+/).length).toBeLessThanOrEqual(15);
      expect(copy).not.toMatch(/\bhub\b|\bwe\b/i);
    }
  });
});

describe('finding a tool by name', () => {
  it('finds a capability by its MCP tool name or its id, and a hand tool by name', () => {
    expect(bridgeActionFor('config_patch', capabilities)?.id).toBe('operator.config_patch');
    expect(bridgeActionFor('operator.config_patch', capabilities)?.toolName).toBe('config_patch');
    expect(bridgeActionFor('mesh_unregister', capabilities)).toMatchObject({
      id: 'mesh_unregister',
      tier: 'destructive',
    });
    expect(bridgeActionFor('no_such_tool', capabilities)).toBeNull();
  });

  it('reads the tool a request for access names, without its server prefix', () => {
    const request = bridgeActionFor('request_permission', capabilities)!;
    expect(forwardedToolName(request, { action: 'mcp__dorkos__change_permission' })).toBe(
      'change_permission'
    );
    expect(forwardedToolName(request, { action: 7 })).toBeNull();
    const post = bridgeActionFor('post_to_room', capabilities)!;
    expect(forwardedToolName(post, { action: 'change_permission' })).toBeNull();
  });
});

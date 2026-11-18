import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';
import type { AdapterManager } from '../../../relay/adapter-manager.js';
import {
  escalatedGrantFor,
  registerToolCallEscalator,
} from '../../../core/capabilities/tool-call-escalation.js';
import { gateCallerOf } from '../../../tasks/agent-mode/agent-mode-escalation.js';
import { readOutside } from '../../../tasks/credits/credits-work.js';

/** Guard that returns an error response when adapters are not available. */
function requireAdapterManager(deps: McpToolDeps) {
  if (!deps.adapterManager) {
    return jsonContent({ error: 'Chat connections are off', code: 'ADAPTERS_DISABLED' }, true);
  }
  return null;
}

/** List all Relay adapters with their current status. */
export function createRelayListAdaptersHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    const adapters = deps.adapterManager!.listAdapters();
    return jsonContent({ adapters, count: adapters.length });
  };
}

/** Whether this connection exists and is off, so turning it on lets its people in again. */
function isOff(manager: AdapterManager, id: unknown): id is string {
  return typeof id === 'string' && manager.getAdapter(id)?.config.enabled === false;
}

/** Enable a Relay adapter by ID. */
export function createRelayEnableAdapterHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    // Only a person's yes on this exact call turns one back on (Security S7 on DOR-4355 M3).
    if (isOff(deps.adapterManager!, args.id) && escalatedGrantFor(args)?.via !== 'card') {
      return jsonContent(
        {
          error:
            'Turning a chat connection back on needs a person’s yes on a card, and a turn that read words from outside your team can’t ask for one.',
          code: 'ENABLE_NEEDS_YES',
        },
        true
      );
    }
    try {
      await deps.adapterManager!.enable(args.id);
      return jsonContent({ ok: true, id: args.id, action: 'enabled' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Enable failed';
      return jsonContent({ error: message, code: 'ENABLE_FAILED' }, true);
    }
  };
}

/** Disable a Relay adapter by ID. */
export function createRelayDisableAdapterHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    try {
      await deps.adapterManager!.disable(args.id);
      return jsonContent({ ok: true, id: args.id, action: 'disabled' });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Disable failed';
      return jsonContent({ error: message, code: 'DISABLE_FAILED' }, true);
    }
  };
}

/** Reload Relay adapter configuration from disk. */
export function createRelayReloadAdaptersHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireAdapterManager(deps);
    if (err) return err;
    try {
      await deps.adapterManager!.reload();
      const adapters = deps.adapterManager!.listAdapters();
      return jsonContent({ ok: true, adapterCount: adapters.length });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Reload failed';
      return jsonContent({ error: message, code: 'RELOAD_FAILED' }, true);
    }
  };
}

/**
 * The tool gate's half of Security S7 on DOR-4355 M3: an agent turning a chat
 * connection back on lets that connection's people reach your agents again, so
 * it waits for a person's card at every level. A turn that read words from
 * outside the team, or a caller DorkOS cannot name, gets no card: the call is
 * let through to the tool, which refuses it. One that is on already, or does
 * not exist, is left to the tool.
 *
 * @param manager - The connections, read when each call is decided.
 * @returns A function that removes the escalator again.
 */
export function registerAdapterEnableEscalator(manager: AdapterManager): () => void {
  return registerToolCallEscalator('relay_enable_adapter', async (call) => {
    const id = (call.input as { id?: unknown } | undefined)?.id;
    if (!isOff(manager, id)) return null;
    const area = call.permission?.area ?? 'connections';
    if (readOutside(gateCallerOf(call.context))) {
      return {
        action: call.action,
        permission: { area, state: 'allowed', source: 'floor', layer: 'floor' },
      };
    }
    return {
      action: call.action,
      permission:
        call.permission?.state === 'blocked'
          ? call.permission
          : { area, state: 'ask', source: 'always-asks', layer: 'floor' },
      change: `Turn the chat connection “${manager.resolveAdapterName(id)}” back on, so its people can reach your agents again.`,
    };
  });
}

/**
 * The adapter tool definitions: name, description, input schema, and handler.
 *
 * The single source for all of that on BOTH MCP servers. The external `/mcp`
 * server projects these through `registerFromDefinitions` rather than typing them
 * out again, which is what stops the two surfaces describing them differently
 * (DOR-499). Guarded on `deps.adapterManager` by {@link getAdapterTools} for the
 * in-session server; the external server registers unconditionally (see
 * `mcp-server.ts`).
 *
 * @param deps - Shared MCP tool dependencies.
 */
export function adapterToolDefinitions(deps: McpToolDeps) {
  return [
    tool(
      'relay_list_adapters',
      'List every chat connection with its status (connected, disconnected, error).',
      {},
      createRelayListAdaptersHandler(deps)
    ),
    tool(
      'relay_enable_adapter',
      'Turn on a chat connection by ID. Starts the adapter and persists the change to config.',
      { id: z.string().describe('Adapter ID to enable') },
      createRelayEnableAdapterHandler(deps)
    ),
    tool(
      'relay_disable_adapter',
      'Turn off a chat connection by ID. Stops the adapter and persists the change to config.',
      { id: z.string().describe('Adapter ID to disable') },
      createRelayDisableAdapterHandler(deps)
    ),
    tool(
      'relay_reload_adapters',
      'Reload chat connection settings from disk. Hot-reloads adapter state without server restart.',
      {},
      createRelayReloadAdaptersHandler(deps)
    ),
  ];
}

/**
 * The adapter tools for the in-session server — only when adapterManager is provided.
 *
 * @param deps - Shared MCP tool dependencies.
 */
export function getAdapterTools(deps: McpToolDeps) {
  if (!deps.adapterManager) return [];
  return adapterToolDefinitions(deps);
}

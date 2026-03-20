import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Guard that returns an error response when adapters are not available. */
function requireAdapterManager(deps: McpToolDeps) {
  if (!deps.adapterManager) {
    return jsonContent(
      { error: 'Relay adapters are not enabled', code: 'ADAPTERS_DISABLED' },
      true
    );
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

/** Enable a Relay adapter by ID. */
export function createRelayEnableAdapterHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireAdapterManager(deps);
    if (err) return err;
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

/** Returns the adapter tool definitions — only when adapterManager is provided. */
export function getAdapterTools(deps: McpToolDeps) {
  if (!deps.adapterManager) return [];

  return [
    tool(
      'relay_list_adapters',
      'List all Relay external adapters with their current status (connected, disconnected, error).',
      {},
      createRelayListAdaptersHandler(deps)
    ),
    tool(
      'relay_enable_adapter',
      'Enable a Relay external adapter by ID. Starts the adapter and persists the change to config.',
      { id: z.string().describe('Adapter ID to enable') },
      createRelayEnableAdapterHandler(deps)
    ),
    tool(
      'relay_disable_adapter',
      'Disable a Relay external adapter by ID. Stops the adapter and persists the change to config.',
      { id: z.string().describe('Adapter ID to disable') },
      createRelayDisableAdapterHandler(deps)
    ),
    tool(
      'relay_reload_adapters',
      'Reload Relay adapter configuration from disk. Hot-reloads adapter state without server restart.',
      {},
      createRelayReloadAdaptersHandler(deps)
    ),
  ];
}

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Guard that returns an error response when BindingStore is not available. */
function requireBindingStore(deps: McpToolDeps) {
  if (!deps.bindingStore) {
    return jsonContent(
      { error: 'Relay bindings are not enabled', code: 'BINDINGS_DISABLED' },
      true
    );
  }
  return null;
}

/** List all adapter-to-agent bindings. */
export function createBindingListHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireBindingStore(deps);
    if (err) return err;
    const bindings = deps.bindingStore!.getAll();
    return jsonContent({ bindings, count: bindings.length });
  };
}

/** Create a new adapter-to-agent binding. */
export function createBindingCreateHandler(deps: McpToolDeps) {
  return async (args: {
    adapterId: string;
    agentId: string;
    sessionStrategy?: string;
    chatId?: string;
    channelType?: string;
    label?: string;
  }) => {
    const err = requireBindingStore(deps);
    if (err) return err;
    try {
      const binding = await deps.bindingStore!.create({
        adapterId: args.adapterId,
        agentId: args.agentId,
        sessionStrategy: (args.sessionStrategy ?? 'per-chat') as
          | 'per-chat'
          | 'per-user'
          | 'stateless',
        label: args.label ?? '',
        ...(args.chatId && { chatId: args.chatId }),
        ...(args.channelType && {
          channelType: args.channelType as 'dm' | 'group' | 'channel' | 'thread',
        }),
      });
      return jsonContent({ binding });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Create failed';
      return jsonContent({ error: message, code: 'BINDING_CREATE_FAILED' }, true);
    }
  };
}

/** Delete an adapter-to-agent binding by ID. */
export function createBindingDeleteHandler(deps: McpToolDeps) {
  return async (args: { id: string }) => {
    const err = requireBindingStore(deps);
    if (err) return err;
    const deleted = await deps.bindingStore!.delete(args.id);
    return jsonContent({ result: deleted ? 'Deleted' : 'Not found', id: args.id });
  };
}

/** Returns the binding tool definitions — only when bindingStore is provided. */
export function getBindingTools(deps: McpToolDeps) {
  if (!deps.bindingStore) return [];

  return [
    tool('binding_list', 'List all adapter-to-agent bindings.', {}, createBindingListHandler(deps)),
    tool(
      'binding_create',
      'Create a new adapter-to-agent binding. Maps an external adapter to a specific agent directory.',
      {
        adapterId: z.string().describe('ID of the adapter to bind'),
        agentId: z.string().describe('Agent ID to route messages to'),
        sessionStrategy: z
          .string()
          .optional()
          .describe('Session strategy: per-chat, per-user, or stateless (default per-chat)'),
        chatId: z.string().optional().describe('Optional chat ID for targeted routing'),
        channelType: z
          .string()
          .optional()
          .describe('Optional channel type filter: dm, group, channel, or thread'),
        label: z.string().optional().describe('Optional human-readable label for this binding'),
      },
      createBindingCreateHandler(deps)
    ),
    tool(
      'binding_delete',
      'Delete an adapter-to-agent binding by ID.',
      { id: z.string().describe('Binding UUID to delete') },
      createBindingDeleteHandler(deps)
    ),
  ];
}

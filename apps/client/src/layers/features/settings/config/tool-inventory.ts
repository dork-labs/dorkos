/**
 * MCP tool inventory and group definitions for the Settings Tools tab.
 *
 * Display names omit the `mcp__dorkos__` prefix. The source of truth for the
 * server-side equivalent lives in `services/runtimes/claude-code/tool-filter.ts` —
 * keep the two in sync when adding/removing tools.
 *
 * @module features/settings/config/tool-inventory
 */
/** Inventory of tool names per domain — display names without `mcp__dorkos__` prefix. */
export const TOOL_INVENTORY = {
  core: ['ping', 'get_server_info', 'get_session_count', 'get_agent', 'control_ui', 'get_ui_state'],
  tasks: ['tasks_list', 'tasks_create', 'tasks_update', 'tasks_delete', 'tasks_get_run_history'],
  relay: [
    'relay_send',
    'relay_inbox',
    'relay_list_endpoints',
    'relay_register_endpoint',
    'relay_send_and_wait',
    'relay_send_async',
    'relay_unregister_endpoint',
    'relay_get_trace',
    'relay_get_metrics',
  ],
  mesh: [
    'mesh_discover',
    'mesh_register',
    'mesh_list',
    'mesh_deny',
    'mesh_unregister',
    'mesh_status',
    'mesh_inspect',
    'mesh_query_topology',
  ],
  adapter: [
    'relay_list_adapters',
    'relay_enable_adapter',
    'relay_disable_adapter',
    'relay_reload_adapters',
    'binding_list',
    'binding_create',
    'binding_delete',
    'binding_list_sessions',
    'relay_notify_user',
  ],
} as const;

/** Identifier for a toggleable tool domain. */
export type ToolDomainKey = 'tasks' | 'relay' | 'mesh' | 'adapter';

/** Server-config key that controls whether a tool domain is enabled by default. */
export type GlobalConfigKey = 'tasksTools' | 'relayTools' | 'meshTools' | 'adapterTools';

/** Maps a tool domain to its corresponding global config flag name. */
export const CONFIG_KEY_MAP: Record<ToolDomainKey, GlobalConfigKey> = {
  tasks: 'tasksTools',
  relay: 'relayTools',
  mesh: 'meshTools',
  adapter: 'adapterTools',
};

/** Display metadata for a tool group rendered in the Settings Tools tab. */
export interface ToolGroupDef {
  key: ToolDomainKey;
  label: string;
  description: string;
  tools: readonly string[];
  implicitNote?: string;
}

/** Ordered list of toggleable tool groups shown in the Settings Tools tab. */
export const TOOL_GROUPS: ToolGroupDef[] = [
  {
    key: 'tasks',
    label: 'Tasks (Scheduling)',
    description: 'Create and manage scheduled agent runs',
    tools: TOOL_INVENTORY.tasks,
  },
  {
    key: 'relay',
    label: 'Relay (Messaging)',
    description: 'Send messages, check inbox, register endpoints',
    tools: TOOL_INVENTORY.relay,
    implicitNote: 'Includes trace tools (relay_get_trace, relay_get_metrics)',
  },
  {
    key: 'mesh',
    label: 'Mesh (Discovery)',
    description: 'Discover, register, and query agents',
    tools: TOOL_INVENTORY.mesh,
  },
  {
    key: 'adapter',
    label: 'Relay Adapters',
    description: 'Manage Telegram, Slack, webhooks, and bindings',
    tools: TOOL_INVENTORY.adapter,
    implicitNote: 'Includes binding tools (binding_list, binding_create, binding_delete)',
  },
];

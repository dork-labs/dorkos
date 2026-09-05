/**
 * Tool group display metadata for the Settings Tools tab.
 *
 * The tool NAMES are not written down here. Which tools each toggle covers is
 * declared once in `@dorkos/shared/mcp-tool-groups` and shared with the server's
 * session tool list, so the screen cannot claim a tool set the server does not
 * build (DOR-499). This module holds only what is genuinely presentational: the
 * labels, the descriptions, and the order the groups appear in.
 *
 * Display names omit the `mcp__dorkos__` prefix, which is what the shared table
 * stores.
 *
 * @module features/settings/config/tool-inventory
 */
import {
  SESSION_CORE_TOOL_NAMES,
  toolNamesForDomain,
  type ToolDomainKey,
} from '@dorkos/shared/mcp-tool-groups';

export type { ToolDomainKey };

/**
 * Tool names per toggle, derived from the shared group table.
 *
 * `core` is the set no toggle controls; the other four each list everything their
 * toggle covers, including the groups that implicitly follow it (trace follows
 * Messaging, chat routes follow Connection management).
 */
export const TOOL_INVENTORY: Readonly<Record<'core' | ToolDomainKey, readonly string[]>> = {
  core: SESSION_CORE_TOOL_NAMES,
  tasks: toolNamesForDomain('tasks'),
  relay: toolNamesForDomain('relay'),
  mesh: toolNamesForDomain('mesh'),
  adapter: toolNamesForDomain('adapter'),
};

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

/**
 * Ordered list of toggleable tool groups shown in the Settings Tools tab.
 *
 * Labels name what the tools do, not the subsystem behind them — the cockpit
 * does not say "Relay" or "Mesh" (the Language & IA program, plan D4/D6). The
 * matching per-agent Tools view uses the same plain names.
 */
export const TOOL_GROUPS: ToolGroupDef[] = [
  {
    key: 'tasks',
    label: 'Scheduling',
    description: 'Let agents create and manage scheduled runs.',
    tools: TOOL_INVENTORY.tasks,
  },
  {
    key: 'relay',
    label: 'Messaging',
    description: 'Let agents send messages and check the inbox.',
    tools: TOOL_INVENTORY.relay,
    implicitNote: 'Includes trace tools',
  },
  {
    key: 'mesh',
    label: 'Agent discovery',
    description: "Let agents find and register other agents, and see who's available.",
    tools: TOOL_INVENTORY.mesh,
  },
  {
    key: 'adapter',
    label: 'Connection management',
    description:
      'Let agents set up Telegram, Slack, and webhooks, and route each chat to an agent.',
    tools: TOOL_INVENTORY.adapter,
    implicitNote: 'Includes routing tools',
  },
];

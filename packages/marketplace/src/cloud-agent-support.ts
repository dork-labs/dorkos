/**
 * @dorkos/marketplace — whether a package works on a cloud agent
 * (`specs/everything-is-a-space/design-agent-computers.md` §5).
 *
 * A cloud agent runs on an agent computer: a sealed machine in the cloud with
 * one agent runtime, OpenCode. Some packages cannot do anything there, and
 * the app says so before anybody installs one: the marketplace card and the
 * install dialog show {@link CLOUD_AGENT_UNSUPPORTED_SENTENCE}, and an agent
 * computer refuses the install with the same sentence. This module is the one
 * judgment both sides use, so the server and the client always agree.
 *
 * A package does not work on a cloud agent when it is:
 *
 * - an agent package whose own `agent.json` names another runtime;
 * - a plugin that ships hooks (OpenCode has no hook file to project them into,
 *   so only Claude Code runs them);
 * - a plugin that ships what only Claude Code loads: background monitors or
 *   language (LSP) servers;
 * - a relay adapter (a chat app connection lives on the hub, never on the
 *   computer); a connector adapter is fine, since connections are reached
 *   through the hub;
 * - a local (`stdio`) MCP server whose program is not in the computer's image
 *   ({@link CLOUD_COMPUTER_MCP_PROGRAMS}).
 *
 * It judges only what it is told. A fact left out counts as fine, so a card
 * that knows only the package's type flags only what the type decides, and the
 * install dialog, which has the full preview, flags the rest. A manifest field
 * may replace this judgment after launch.
 *
 * Browser-safe: no Node.js imports.
 *
 * @module @dorkos/marketplace/cloud-agent-support
 */
import { CONNECTOR_ADAPTER_TYPE } from './manifest-schema.js';
import type { PackageType } from './package-types.js';

/** What the card, the install dialog and an agent computer say about such a package. */
export const CLOUD_AGENT_UNSUPPORTED_SENTENCE = "This doesn't work on cloud agents yet.";

/** The one agent runtime an agent computer runs. */
export const CLOUD_AGENT_RUNTIME = 'opencode';

/**
 * The programs a local MCP server may run on an agent computer, matched
 * exactly by name (a path, even to one of these, is not matched).
 *
 * **The computer's image decides this list.** It names what the published
 * image ships today; when the image changes, this list changes with it.
 */
export const CLOUD_COMPUTER_MCP_PROGRAMS: readonly string[] = ['node', 'npx', 'python3', 'uvx'];

/**
 * Why a package does not work on a cloud agent: an agent package for another
 * runtime, a plugin that ships hooks, one that ships what only Claude Code
 * loads (monitors, LSP servers), a relay adapter, or a local MCP server whose
 * program is not in the computer's image.
 */
export const CLOUD_AGENT_UNSUPPORTED_REASONS = [
  'agent-runtime',
  'hooks',
  'claude-code-only',
  'relay-adapter',
  'mcp-program',
] as const;

/** Why a package does not work on a cloud agent; see {@link CLOUD_AGENT_UNSUPPORTED_REASONS}. */
export type CloudAgentUnsupportedReason = (typeof CLOUD_AGENT_UNSUPPORTED_REASONS)[number];

/** The judgment: it works, or it does not, and why. */
export type CloudAgentSupport =
  { supported: true } | { supported: false; reason: CloudAgentUnsupportedReason };

/** A local or remote MCP server, as a package's preview describes it. */
export interface CloudAgentMcpServerFacts {
  /** `stdio` for a local command, else the remote transport. */
  readonly transport: string;
  /** The program a `stdio` server runs, verbatim. */
  readonly command?: string;
}

/**
 * What is known about a package. Every field is optional, and one left out
 * counts as fine. A marketplace entry (`AggregatedPackage`) fits as it is; the
 * install dialog adds its permission preview and the agent package's runtime.
 */
export interface CloudAgentPackageFacts {
  /** The package type; a missing one is a plugin, as everywhere else. */
  readonly type?: PackageType;
  /** An adapter's type: `connector`, or a relay service's slug. */
  readonly adapterType?: string;
  /**
   * The runtime an agent package's own `agent.json` names. Absent when it
   * names none, which leaves the runtime to whoever creates the agent.
   */
  readonly agentRuntime?: string;
  /** The hooks the package registers. */
  readonly hooks?: readonly unknown[];
  /** Hook declarations it ships that could not be read. */
  readonly unreadableHooks?: readonly unknown[];
  /** Background monitors it runs. */
  readonly monitors?: readonly unknown[];
  /** Language (LSP) servers it starts. */
  readonly lspServers?: readonly unknown[];
  /** MCP servers it starts. */
  readonly mcpServers?: readonly CloudAgentMcpServerFacts[];
}

/** Whether a list was given and holds anything. */
function some(list: readonly unknown[] | undefined): boolean {
  return (list?.length ?? 0) > 0;
}

/**
 * Whether a package works on a cloud agent. See the module doc for the rule.
 *
 * @param pkg - What is known about the package.
 */
export function cloudAgentSupport(pkg: CloudAgentPackageFacts): CloudAgentSupport {
  const no = (reason: CloudAgentUnsupportedReason): CloudAgentSupport => ({
    supported: false,
    reason,
  });
  const type = pkg.type ?? 'plugin';
  const runtime = pkg.agentRuntime;
  if (type === 'agent' && runtime !== undefined && runtime !== CLOUD_AGENT_RUNTIME) {
    return no('agent-runtime');
  }
  if (type === 'adapter' && pkg.adapterType !== CONNECTOR_ADAPTER_TYPE) return no('relay-adapter');
  if (some(pkg.hooks) || some(pkg.unreadableHooks)) return no('hooks');
  if (some(pkg.monitors) || some(pkg.lspServers)) return no('claude-code-only');
  const outsideImage = (pkg.mcpServers ?? []).some(
    (server) =>
      server.transport === 'stdio' &&
      !CLOUD_COMPUTER_MCP_PROGRAMS.includes(server.command?.trim() ?? '')
  );
  if (outsideImage) return no('mcp-program');
  return { supported: true };
}
